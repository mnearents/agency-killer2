/**
 * Shopify database queries — reads order data for LTV calculations,
 * product catalog for email creative, and attribution analysis.
 */

import { eq, gte, lte, desc, sql, and } from "drizzle-orm";
import type { Db } from "@/db/client";
import { shopifyOrders, shopifyLineItems } from "@/db/schema";
import type { ProductInfo } from "@/domain/email/creative";

/**
 * Get top-selling products from recent orders for email creative.
 * Returns distinct products ordered by frequency.
 */
export async function getTopProducts(
  db: Db,
  limit = 10
): Promise<ProductInfo[]> {
  const rows = await db
    .select({
      title: shopifyLineItems.title,
      productType: shopifyLineItems.productType,
      priceCents: shopifyLineItems.priceCents,
      count: sql<number>`COUNT(*)`.as("count"),
    })
    .from(shopifyLineItems)
    .groupBy(
      shopifyLineItems.title,
      shopifyLineItems.productType,
      shopifyLineItems.priceCents
    )
    .orderBy(desc(sql`COUNT(*)`))
    .limit(limit);

  return rows.map((r) => ({
    title: r.title,
    description: "",
    priceCents: Number(r.priceCents),
    productType: r.productType ?? undefined,
  }));
}

/**
 * Get recent order count and revenue for the dashboard.
 */
export async function getOrderSummary(
  db: Db,
  days = 30
): Promise<{
  totalOrders: number;
  totalRevenueCents: number;
  subscriptionOrders: number;
  subscriptionRevenueCents: number;
}> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      isRecurring: shopifyOrders.isRecurring,
      totalPriceCents: shopifyOrders.totalPriceCents,
    })
    .from(shopifyOrders)
    .where(gte(shopifyOrders.orderCreatedAt, since));

  let totalOrders = 0;
  let totalRevenueCents = 0;
  let subscriptionOrders = 0;
  let subscriptionRevenueCents = 0;

  for (const row of rows) {
    totalOrders++;
    totalRevenueCents += Number(row.totalPriceCents);
    if (row.isRecurring === 1) {
      subscriptionOrders++;
      subscriptionRevenueCents += Number(row.totalPriceCents);
    }
  }

  return {
    totalOrders,
    totalRevenueCents,
    subscriptionOrders,
    subscriptionRevenueCents,
  };
}

/**
 * Order count and revenue over an explicit window — the same bounds as
 * getDailyOrders, so a summary and its daily rows always add up.
 *
 * store_performance used getOrderSummary(days), which counts back from NOW:
 * a request for 2025 got the last 364 days instead, and two windows of equal
 * length got identical totals.
 */
export async function getOrderSummaryBetween(
  db: Db,
  startDate: Date,
  endDate: Date,
): Promise<{ totalOrders: number; totalRevenueCents: number; subscriptionOrders: number; subscriptionRevenueCents: number }> {
  const [row] = await db
    .select({
      totalOrders: sql<number>`COUNT(*)`,
      totalRevenueCents: sql<number>`COALESCE(SUM(${shopifyOrders.totalPriceCents}), 0)`,
      subscriptionOrders: sql<number>`COUNT(*) FILTER (WHERE ${shopifyOrders.isRecurring} = 1)`,
      subscriptionRevenueCents: sql<number>`COALESCE(SUM(${shopifyOrders.totalPriceCents}) FILTER (WHERE ${shopifyOrders.isRecurring} = 1), 0)`,
    })
    .from(shopifyOrders)
    .where(and(gte(shopifyOrders.orderCreatedAt, startDate), lte(shopifyOrders.orderCreatedAt, endDate)));
  return {
    totalOrders: Number(row?.totalOrders ?? 0),
    totalRevenueCents: Number(row?.totalRevenueCents ?? 0),
    subscriptionOrders: Number(row?.subscriptionOrders ?? 0),
    subscriptionRevenueCents: Number(row?.subscriptionRevenueCents ?? 0),
  };
}

export interface DailyOrderMetrics {
  date: string;
  orders: number;
  revenueCents: number;
  subscriptionOrders: number;
}

/**
 * Get daily order metrics for trend charts.
 */
export async function getDailyOrders(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<DailyOrderMetrics[]> {
  const rows = await db
    .select({
      date: sql<string>`DATE(${shopifyOrders.orderCreatedAt})`.as("date"),
      orders: sql<number>`COUNT(*)`.as("orders"),
      revenueCents: sql<number>`SUM(${shopifyOrders.totalPriceCents})`.as("revenue_cents"),
      subscriptionOrders: sql<number>`SUM(CASE WHEN ${shopifyOrders.isRecurring} = 1 THEN 1 ELSE 0 END)`.as("sub_orders"),
    })
    .from(shopifyOrders)
    .where(
      and(
        gte(shopifyOrders.orderCreatedAt, startDate),
        lte(shopifyOrders.orderCreatedAt, endDate)
      )
    )
    .groupBy(sql`DATE(${shopifyOrders.orderCreatedAt})`)
    .orderBy(sql`DATE(${shopifyOrders.orderCreatedAt})`);

  return rows.map((r) => ({
    date: String(r.date).split("T")[0],
    orders: Number(r.orders ?? 0),
    revenueCents: Number(r.revenueCents ?? 0),
    subscriptionOrders: Number(r.subscriptionOrders ?? 0),
  }));
}

export interface ProductSales {
  productId: string;
  title: string;
  handle: string | null;
  status: string | null;
  productType: string | null;
  units: number;
  orders: number;
  /** Line revenue after line discounts, before tax and shipping. */
  revenueCents: number;
}

/**
 * Sales per product over a window, keyed by product so a strategy role can
 * sit beside it. Every active product appears, sold or not — a product that
 * sold nothing is the answer to "what is not working", and an inner join
 * would drop exactly those.
 */
export async function getProductSales(db: Db, since: Date, until: Date): Promise<ProductSales[]> {
  const rows = (await db.execute(sql`
    with sales as (
      select li.product_id,
             sum(li.quantity)::int as units,
             count(distinct li.order_id)::int as orders,
             sum(li.price_cents * li.quantity - coalesce(li.total_discount_cents, 0))::bigint as revenue_cents,
             max(li.title) as title
      from shopify_line_items li
      join shopify_orders o on o.id = li.order_id
      where o.order_created_at >= ${since} and o.order_created_at < ${until}
        and li.product_id is not null
      group by li.product_id
    )
    select coalesce(p.id, s.product_id) as "productId",
           coalesce(p.title, s.title) as title,
           p.handle, p.status, p.product_type as "productType",
           coalesce(s.units, 0) as units,
           coalesce(s.orders, 0) as orders,
           coalesce(s.revenue_cents, 0) as "revenueCents"
    from shopify_products p
    full join sales s on s.product_id = p.id
    where p.status = 'ACTIVE' or s.product_id is not null
  `)) as unknown as ProductSales[];
  return rows.map((r) => ({ ...r, units: Number(r.units), orders: Number(r.orders), revenueCents: Number(r.revenueCents) }));
}
