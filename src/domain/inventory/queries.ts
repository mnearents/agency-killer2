/**
 * Inventory queries — assembles the data the pure checks operate on.
 *
 * Sales velocity comes from line items on orders in the last 30 days,
 * matched to variants. Variants with no matching line items read 0 sold.
 */

import { sql, desc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { shopifyInventory } from "@/db/schema";
import type { InventoryItem } from "./checks";

const SALES_WINDOW_DAYS = 30;

export async function getInventoryItems(db: Db): Promise<InventoryItem[]> {
  const since = new Date(Date.now() - SALES_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      variantId: shopifyInventory.id,
      productTitle: shopifyInventory.productTitle,
      variantTitle: shopifyInventory.variantTitle,
      sku: shopifyInventory.sku,
      quantity: shopifyInventory.quantity,
      tracked: shopifyInventory.tracked,
      productStatus: shopifyInventory.productStatus,
      unitsSoldLast30d: sql<number>`COALESCE((
        SELECT SUM(li.quantity)
        FROM shopify_line_items li
        JOIN shopify_orders o ON o.id = li.order_id
        WHERE li.variant_id = ${shopifyInventory.id}
          AND o.order_created_at >= ${since}
      ), 0)`,
    })
    .from(shopifyInventory)
    .orderBy(desc(shopifyInventory.quantity));

  return rows.map((r) => ({
    variantId: r.variantId,
    productTitle: r.productTitle,
    variantTitle: r.variantTitle,
    sku: r.sku,
    quantity: r.quantity,
    tracked: r.tracked === 1,
    productStatus: r.productStatus,
    unitsSoldLast30d: Number(r.unitsSoldLast30d),
  }));
}

export async function getLastSyncedAt(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ syncedAt: sql<Date | null>`MAX(${shopifyInventory.syncedAt})` })
    .from(shopifyInventory);
  return row?.syncedAt ? new Date(row.syncedAt) : null;
}
