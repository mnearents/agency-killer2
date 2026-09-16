/**
 * Inventory sync — pulls variant stock levels from Shopify and upserts them.
 *
 * Stock is a snapshot, not a time series: rows are replaced on every run and
 * variants that vanished from Shopify are pruned, so a deleted product can't
 * linger as a phantom stockout.
 */

import { lt } from "drizzle-orm";
import type { ShopifyApiClient } from "@/integrations/shopify-api";
import type { Db } from "@/db/client";
import { shopifyInventory } from "@/db/schema";
import { transformVariant } from "./sync-transform";

export interface InventorySyncDeps {
  client: ShopifyApiClient;
  db: Db;
}

/**
 * How much of the catalogue carries a landed cost.
 *
 * Reported rather than left to be discovered, because every cost-of-delivery
 * figure is a guess until this is populated (#34), and a number nobody prints
 * is a number nobody acts on.
 *
 * Two populations, never one blended figure. Against the live catalogue 42 of
 * 232 active variants carry a cost — 18%, which sounds alarming and is not,
 * because 181 of them are digital products, gift cards, subscriptions and
 * classes that correctly cost nothing. Among physical variants it is 42 of 51.
 * A single percentage over both describes neither.
 */
export interface CostCoverage {
  /**
   * Active variants seen this run. Archived and draft products are excluded
   * throughout: their landed cost cannot affect any margin because nothing
   * can be sold, and counting them reported 85/327 for a catalogue that
   * actually had 8 active physical variants missing a cost.
   */
  total: number;
  /** Variants with any cost recorded, including a genuine zero. */
  withCost: number;
  /** Variants whose product type implies a physical good with real COGS. */
  physicalTotal: number;
  physicalWithCost: number;
}

export interface InventorySyncResult {
  variants: number;
  pruned: number;
  cost: CostCoverage;
  errors: string[];
}

/**
 * Product types that legitimately cost nothing to deliver.
 *
 * Listed as the exception rather than enumerating physical types, for the same
 * reason voice rules use `exceptIn`: a product type nobody thought about is
 * then counted as physical and shows up as a coverage gap, which is wrong in
 * the direction someone notices. The alternative silently excuses it.
 */
const ZERO_COGS_TYPES = new Set([
  "Pages",
  "Digital",
  "Font",
  "Subscription",
  "Gift Card",
  "Gift Cards",
  "Class",
  "Activity Books",
]);

export async function syncInventory(
  deps: InventorySyncDeps
): Promise<InventorySyncResult> {
  const { client, db } = deps;
  const syncedAt = new Date();
  const errors: string[] = [];
  let variants = 0;
  let pruned = 0;
  const cost: CostCoverage = { total: 0, withCost: 0, physicalTotal: 0, physicalWithCost: 0 };

  try {
    const rawVariants = await client.getInventory();

    for (const raw of rawVariants) {
      const row = transformVariant(raw, syncedAt);

      // Counted from the row, so what is reported is what was stored. Active
      // only — an archived product's landed cost cannot affect any margin.
      // The row is still synced; only the metric is scoped.
      if (row.productStatus === "ACTIVE") {
        const recorded = row.unitCostCents !== null;
        cost.total++;
        if (recorded) cost.withCost++;
        if (!ZERO_COGS_TYPES.has(row.productType ?? "")) {
          cost.physicalTotal++;
          if (recorded) cost.physicalWithCost++;
        }
      }

      await db
        .insert(shopifyInventory)
        .values(row)
        .onConflictDoUpdate({ target: shopifyInventory.id, set: row });
      variants++;
    }

    // Only prune once the pull succeeded, or a failed fetch would wipe the table.
    if (variants > 0) {
      const removed = await db
        .delete(shopifyInventory)
        .where(lt(shopifyInventory.syncedAt, syncedAt))
        .returning({ id: shopifyInventory.id });
      pruned = removed.length;
    }
  } catch (err) {
    errors.push(`Inventory: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { variants, pruned, cost, errors };
}
