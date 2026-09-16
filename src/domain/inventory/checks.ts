/**
 * Inventory checks — pure classification and roll-up of stock conditions.
 *
 * Design mirrors src/domain/alerts/checks.ts: no DB calls, data is
 * pre-fetched and passed in. queries.ts does the querying.
 *
 * Two things this module exists to get right:
 *  1. Untracked and non-active variants report quantity 0 in Shopify. Reading
 *     those as stockouts would bury every real alert in false alarms.
 *  2. A store with 40 low SKUs must not produce 40 Slack messages. Conditions
 *     roll up into at most one alert per category.
 */

import type { Alert } from "@/domain/alerts/checks";
import { computeDailyVelocity, computeDaysOfCover } from "./velocity";

const SALES_WINDOW_DAYS = 30;
const MAX_LISTED_LOW_COVER = 5;
const MAX_LISTED_SLOW_MOVERS = 3;

export interface InventoryItem {
  variantId: string;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  priceCents: number;
  tracked: boolean;
  productStatus: string;
  unitsSoldLast30d: number;
  /** Sales over the trailing year. Dated editions project on this. */
  unitsSoldLast12m: number;
}

/**
 * Two thresholds rather than one, because the right single number depends on
 * a reorder lead time that varies per product and isn't recorded anywhere.
 * They map to genuinely different actions:
 *   - below the lead time  → still time to reorder, so reorder
 *   - below critical       → too late to reorder, so stop driving demand
 * A wrong-ish lead time degrades the timing of these, not their usefulness.
 */
export interface InventoryCheckOptions {
  /** Start the reorder conversation below this many days of cover. Default: 45. */
  reorderLeadTimeDays?: number;
  /** Too late to restock in time below this many days of cover. Default: 14. */
  criticalCoverDays?: number;
  /** Below this quantity, a non-selling variant isn't worth bundling. Default: 50. */
  slowMoverMinQuantity?: number;
}

export type InventoryClassification =
  | "ignored"
  | "stockout"
  | "critical-cover"
  | "low-cover"
  | "slow-mover"
  | "healthy";

function daysOfCoverFor(item: InventoryItem): number | null {
  const velocity = computeDailyVelocity(item.unitsSoldLast30d, SALES_WINDOW_DAYS);
  return computeDaysOfCover(item.quantity, velocity);
}

export function classifyItem(
  item: InventoryItem,
  options: InventoryCheckOptions = {}
): InventoryClassification {
  const leadTime = options.reorderLeadTimeDays ?? 45;
  const critical = options.criticalCoverDays ?? 14;
  const slowMoverMin = options.slowMoverMinQuantity ?? 50;

  // Untracked variants always read 0; non-active products aren't for sale.
  if (!item.tracked) return "ignored";
  if (item.productStatus !== "ACTIVE") return "ignored";

  if (item.quantity <= 0) {
    return item.unitsSoldLast30d > 0 ? "stockout" : "healthy";
  }

  const cover = daysOfCoverFor(item);
  if (cover !== null && cover < critical) return "critical-cover";
  if (cover !== null && cover < leadTime) return "low-cover";

  if (item.unitsSoldLast30d === 0 && item.quantity >= slowMoverMin) {
    return "slow-mover";
  }

  return "healthy";
}

function displayName(item: InventoryItem): string {
  const variant = item.variantTitle;
  if (!variant || variant === "Default" || variant === "Default Title") {
    return item.productTitle;
  }
  return `${item.productTitle} (${variant})`;
}

function formatDays(days: number): string {
  const whole = Math.floor(days);
  if (whole < 1) return "under a day";
  return `${whole} day${whole === 1 ? "" : "s"}`;
}

function withOverflow(lines: string[], max: number): string {
  const shown = lines.slice(0, max);
  const omitted = lines.length - shown.length;
  const suffix = omitted > 0 ? `\n…and ${omitted} more` : "";
  return shown.join("\n") + suffix;
}

/**
 * Classify every item and roll the results into at most three alerts:
 * one urgent (stocked out), one warning (running low), one info (slow movers).
 */
export function runInventoryChecks(
  items: InventoryItem[],
  options: InventoryCheckOptions = {}
): Alert[] {
  const stockouts: InventoryItem[] = [];
  const criticalCover: InventoryItem[] = [];
  const lowCover: InventoryItem[] = [];
  const slowMovers: InventoryItem[] = [];

  for (const item of items) {
    switch (classifyItem(item, options)) {
      case "stockout":
        stockouts.push(item);
        break;
      case "critical-cover":
        criticalCover.push(item);
        break;
      case "low-cover":
        lowCover.push(item);
        break;
      case "slow-mover":
        slowMovers.push(item);
        break;
    }
  }

  // Most urgent first — fewest days of cover.
  function byUrgency(a: InventoryItem, b: InventoryItem) {
    return (daysOfCoverFor(a) ?? Infinity) - (daysOfCoverFor(b) ?? Infinity);
  }

  function coverLines(group: InventoryItem[]): string[] {
    return [...group].sort(byUrgency).map((i) => {
      const cover = daysOfCoverFor(i);
      const coverText = cover === null ? "no recent sales" : formatDays(cover);
      return `• ${displayName(i)} — ${i.quantity} left, about ${coverText} of cover`;
    });
  }

  const alerts: Alert[] = [];

  if (stockouts.length > 0) {
    // Biggest sellers first — those are the ones burning ad spend.
    const sorted = [...stockouts].sort(
      (a, b) => b.unitsSoldLast30d - a.unitsSoldLast30d
    );
    const lines = sorted.map(
      (i) => `• ${displayName(i)} — sold ${i.unitsSoldLast30d} in the last 30 days`
    );
    alerts.push({
      type: "inventory-stockout",
      severity: "urgent",
      message:
        `Out of stock and still selling:\n${withOverflow(lines, MAX_LISTED_LOW_COVER)}\n\n` +
        `Pause any ad spend pointing at these and pull them from upcoming emails — ` +
        `you're paying to send people to something they can't buy. Reorder or mark them back-in-stock-soon.`,
    });
  }

  if (criticalCover.length > 0) {
    alerts.push({
      type: "inventory-critical-cover",
      severity: "urgent",
      message:
        `About to sell out:\n${withOverflow(coverLines(criticalCover), MAX_LISTED_LOW_COVER)}\n\n` +
        `These will run out before a reorder could realistically land. Ease off the ad spend ` +
        `and don't feature them in the next email — otherwise you're paying to create demand ` +
        `you can't fill. If a restock is already on the way, ignore me.`,
    });
  }

  if (lowCover.length > 0) {
    alerts.push({
      type: "inventory-low-cover",
      severity: "warning",
      message:
        `Worth reordering soon:\n${withOverflow(coverLines(lowCover), MAX_LISTED_LOW_COVER)}\n\n` +
        `There's still time to restock these before they run out. Get the reorder moving now ` +
        `and you can keep promoting them without risk.`,
    });
  }

  if (slowMovers.length > 0) {
    // Deepest stock first — most cash tied up.
    const sorted = [...slowMovers].sort((a, b) => b.quantity - a.quantity);
    const lines = sorted.map((i) => `• ${displayName(i)} — ${i.quantity} sitting, none sold in 30 days`);
    alerts.push({
      type: "inventory-slow-mover",
      severity: "info",
      message:
        `Sitting still and tying up cash:\n${withOverflow(lines, MAX_LISTED_SLOW_MOVERS)}\n\n` +
        `Good candidates to bundle with a bestseller, use as a spend-threshold gift, ` +
        `or feature in an email — anything to turn shelf space back into cash.`,
    });
  }

  return alerts;
}
