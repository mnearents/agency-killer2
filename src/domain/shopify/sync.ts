/**
 * Shopify sync service — pulls orders from Shopify API,
 * transforms, and upserts to the database.
 */

import type { ShopifyApiClient } from "@/integrations/shopify-api";
import type { Db } from "@/db/client";
import { shopifyOrders, shopifyLineItems } from "@/db/schema";
import { transformOrderWithLineItems } from "./sync-transform";

export interface ShopifySyncDeps {
  client: ShopifyApiClient;
  db: Db;
}

export interface ShopifySyncResult {
  orders: number;
  lineItems: number;
  errors: string[];
}

/**
 * Sync orders from Shopify. Pulls all orders since the given date
 * (or last 30 days by default) and upserts them.
 */
export async function syncOrders(
  deps: ShopifySyncDeps,
  since?: string
): Promise<ShopifySyncResult> {
  const { client, db } = deps;
  const syncedAt = new Date();
  const errors: string[] = [];
  let orderCount = 0;
  let lineItemCount = 0;

  const defaultSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  try {
    const rawOrders = await client.getOrders({ since: since ?? defaultSince });

    for (const raw of rawOrders) {
      const { order, lineItems } = transformOrderWithLineItems(raw, syncedAt);

      await db
        .insert(shopifyOrders)
        .values(order)
        .onConflictDoUpdate({
          target: shopifyOrders.id,
          set: { ...order, updatedAt: syncedAt },
        });
      orderCount++;

      for (const item of lineItems) {
        await db
          .insert(shopifyLineItems)
          .values(item)
          .onConflictDoUpdate({
            target: shopifyLineItems.id,
            set: { ...item },
          });
        lineItemCount++;
      }
    }
  } catch (err) {
    errors.push(`Orders: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { orders: orderCount, lineItems: lineItemCount, errors };
}
