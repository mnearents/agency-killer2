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

export interface InventorySyncResult {
  variants: number;
  pruned: number;
  errors: string[];
}

export async function syncInventory(
  deps: InventorySyncDeps
): Promise<InventorySyncResult> {
  const { client, db } = deps;
  const syncedAt = new Date();
  const errors: string[] = [];
  let variants = 0;
  let pruned = 0;

  try {
    const rawVariants = await client.getInventory();

    for (const raw of rawVariants) {
      const row = transformVariant(raw, syncedAt);
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

  return { variants, pruned, errors };
}
