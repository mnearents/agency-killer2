/**
 * ShipHero shipments and labels into Postgres (`sync:shiphero`).
 *
 * Always a date window, walked in windows of 7 days or less, every page read.
 * Daily it re-reads the last 7 days, so a label added late, voided or
 * refunded is picked up; the backfill starts where the Shopify orders begin
 * (2025-07-22). Rows are upserted by ShipHero's shipment and label ids, so a
 * second run of the same window changes no row counts.
 *
 * A failed window stops the run, named with ShipHero's request id so it can
 * be reported to them. Throttling is handled and reported by the client.
 */

import { getTableColumns, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { shipheroLabels, shipheroShipments } from "@/db/schema";
import { ShipHeroError, type ShipHeroClient } from "@/integrations/shiphero-api";
import { toShipHeroRows } from "./shiphero-transform";

export const SHIPHERO_HISTORY_START = "2025-07-22";
export const SHIPHERO_WINDOW_DAYS = 7;
export const SHIPHERO_DAILY_LOOKBACK_DAYS = 7;

const DAY_MS = 86_400_000;
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Windows of at most 7 days; ShipHero's ends are inclusive, so each stops a second before the next. */
export function syncWindows(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const windows: Array<{ from: Date; to: Date }> = [];
  for (let start = from.getTime(); start <= to.getTime(); start += SHIPHERO_WINDOW_DAYS * DAY_MS) {
    const end = Math.min(start + SHIPHERO_WINDOW_DAYS * DAY_MS - 1000, to.getTime());
    windows.push({ from: new Date(start), to: new Date(end) });
  }
  return windows;
}

export function dailyShipHeroRange(now: Date): { from: Date; to: Date } {
  return { from: new Date(startOfUtcDay(now).getTime() - SHIPHERO_DAILY_LOOKBACK_DAYS * DAY_MS), to: now };
}

export function backfillShipHeroRange(now: Date): { from: Date; to: Date } {
  return { from: new Date(`${SHIPHERO_HISTORY_START}T00:00:00Z`), to: now };
}

export interface ShipHeroSyncDeps {
  db: Db;
  client: ShipHeroClient;
  now: () => Date;
}

export interface ShipHeroSyncResult {
  windows: number;
  pages: number;
  shipments: number;
  labels: number;
  /** Label statuses as ShipHero reported them, counted — what the postage rule is checked against. */
  statuses: Record<string, number>;
}

/** Every column but the id, from the incoming row: a re-read replaces what was held. */
const excluded = (table: typeof shipheroShipments | typeof shipheroLabels) =>
  Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([key]) => key !== "id")
      .map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]),
  );

export async function syncShipHero(deps: ShipHeroSyncDeps, range: { from: Date; to: Date }): Promise<ShipHeroSyncResult> {
  const result: ShipHeroSyncResult = { windows: 0, pages: 0, shipments: 0, labels: 0, statuses: {} };
  const seenShipments = new Set<string>();
  const labelStatus = new Map<string, string>();
  for (const window of syncWindows(range.from, range.to)) {
    result.windows++;
    let after: string | null = null;
    do {
      let page;
      try {
        page = await deps.client.shipments(window, after);
      } catch (err) {
        const requestId = err instanceof ShipHeroError ? err.requestId : null;
        throw new Error(
          `ShipHero shipments failed for ${window.from.toISOString().slice(0, 10)} to ${window.to.toISOString().slice(0, 10)}` +
            `${requestId ? ` (request id ${requestId})` : ""}: ${err instanceof Error ? err.message : String(err)} — ` +
            `${result.shipments} shipment(s) saved before it`,
          { cause: err },
        );
      }
      result.pages++;
      const syncedAt = deps.now();
      const rows = page.nodes.map((n) => toShipHeroRows(n, syncedAt));
      const shipments = rows.map((r) => r.shipment);
      const labels = rows.flatMap((r) => r.labels);
      if (shipments.length > 0) {
        await deps.db.insert(shipheroShipments).values(shipments).onConflictDoUpdate({ target: shipheroShipments.id, set: excluded(shipheroShipments) });
      }
      if (labels.length > 0) {
        await deps.db.insert(shipheroLabels).values(labels).onConflictDoUpdate({ target: shipheroLabels.id, set: excluded(shipheroLabels) });
      }
      // Distinct ids: ShipHero does not document which date the window
      // filters on, so a shipment may come back in two windows.
      for (const s of shipments) seenShipments.add(s.id);
      for (const l of labels) labelStatus.set(l.id, l.status ?? "(none)");
      result.shipments = seenShipments.size;
      result.labels = labelStatus.size;
      after = page.hasNextPage ? page.endCursor : null;
    } while (after !== null);
  }
  for (const status of labelStatus.values()) result.statuses[status] = (result.statuses[status] ?? 0) + 1;
  return result;
}
