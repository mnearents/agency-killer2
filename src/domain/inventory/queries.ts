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
const ANNUAL_WINDOW_DAYS = 365;

/**
 * Two windows, not one. Days of cover wants the recent rate, because a reorder
 * decision is about what is selling now. Dated editions want the annual rate:
 * they are seasonal by construction, so thirty days of September projected
 * across a December deadline reads the quiet half of a wall calendar's year as
 * if it were the whole of it. Both are aggregated in one pass over the same
 * join, filtered apart by date.
 */
export function buildInventoryItemsQuery(db: Db, since: Date, sinceAnnual: Date) {
  const sales = db
    .select({
      variantId: shopifyLineItems.variantId,
      // .toISOString() rather than the Date: a value interpolated into a raw
      // sql`` template reaches postgres-js unchanged and is rejected at bind
      // time, where the same Date passed through gte() below is serialized for
      // us. Nothing about the generated SQL text shows the difference.
      unitsSold: sql<number>`SUM(${shopifyLineItems.quantity}) FILTER (WHERE ${shopifyOrders.orderCreatedAt} >= ${since.toISOString()})`.as("units_sold"),
      unitsSoldAnnual: sql<number>`SUM(${shopifyLineItems.quantity})`.as("units_sold_annual"),
    })
    .from(shopifyLineItems)
    .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyLineItems.orderId))
    .where(gte(shopifyOrders.orderCreatedAt, sinceAnnual))
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
      unitsSoldLast12m: sql<number>`COALESCE(${sales.unitsSoldAnnual}, 0)`,
    })
    .from(shopifyInventory)
    .leftJoin(sales, eq(sales.variantId, shopifyInventory.id))
    .orderBy(desc(shopifyInventory.quantity));
}

/**
 * Exported so the two bounds can be asserted apart. Built from one constant
 * each: derive them from a shared expression and a single edit collapses the
 * annual window onto the thirty-day one, which produces no error and no
 * missing column — just dated projections wrong by a factor of twelve.
 */
export function inventoryWindows(now: Date): { since: Date; sinceAnnual: Date } {
  const ms = 24 * 60 * 60 * 1000;
  return {
    since: new Date(now.getTime() - SALES_WINDOW_DAYS * ms),
    sinceAnnual: new Date(now.getTime() - ANNUAL_WINDOW_DAYS * ms),
  };
}

export async function getInventoryItems(db: Db): Promise<InventoryItem[]> {
  const { since, sinceAnnual } = inventoryWindows(new Date());
  const rows = await buildInventoryItemsQuery(db, since, sinceAnnual);

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
    unitsSoldLast12m: Number(r.unitsSoldLast12m),
  }));
}
