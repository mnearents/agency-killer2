/**
 * Inventory queries — assembles the data the pure checks operate on.
 *
 * Sales velocity comes from line items on orders in the last 30 days,
 * matched to variants. Variants with no matching line items read 0 sold.
 *
 * Sales are aggregated in a subquery and LEFT JOINed rather than computed
 * in a correlated subquery: Drizzle renders an interpolated column as a
 * bare `"id"` inside raw SQL, which Postgres rejects as ambiguous against
 * shopify_orders.id and shopify_line_items.id.
 */

import { sql, eq, gte, desc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { shopifyInventory, shopifyLineItems, shopifyOrders } from "@/db/schema";
import type { InventoryItem } from "./checks";

const SALES_WINDOW_DAYS = 30;

export function buildInventoryItemsQuery(db: Db, since: Date) {
  const sales = db
    .select({
      variantId: shopifyLineItems.variantId,
      unitsSold: sql<number>`SUM(${shopifyLineItems.quantity})`.as("units_sold"),
    })
    .from(shopifyLineItems)
    .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyLineItems.orderId))
    .where(gte(shopifyOrders.orderCreatedAt, since))
    .groupBy(shopifyLineItems.variantId)
    .as("sales");

  return db
    .select({
      variantId: shopifyInventory.id,
      productTitle: shopifyInventory.productTitle,
      variantTitle: shopifyInventory.variantTitle,
      sku: shopifyInventory.sku,
      quantity: shopifyInventory.quantity,
      priceCents: shopifyInventory.priceCents,
      tracked: shopifyInventory.tracked,
      productStatus: shopifyInventory.productStatus,
      unitsSoldLast30d: sql<number>`COALESCE(${sales.unitsSold}, 0)`,
    })
    .from(shopifyInventory)
    .leftJoin(sales, eq(sales.variantId, shopifyInventory.id))
    .orderBy(desc(shopifyInventory.quantity));
}

export async function getInventoryItems(db: Db): Promise<InventoryItem[]> {
  const since = new Date(Date.now() - SALES_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await buildInventoryItemsQuery(db, since);

  return rows.map((r) => ({
    variantId: r.variantId,
    productTitle: r.productTitle,
    variantTitle: r.variantTitle,
    sku: r.sku,
    quantity: r.quantity,
    priceCents: Number(r.priceCents),
    tracked: r.tracked === 1,
    productStatus: r.productStatus,
    unitsSoldLast30d: Number(r.unitsSoldLast30d),
  }));
}
