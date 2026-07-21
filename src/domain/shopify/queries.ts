/**
 * Shopify database queries — reads order data for LTV calculations,
 * product catalog for email creative, and attribution analysis.
 */

import { eq, gte, lte, desc, sql, and } from "drizzle-orm";
import type { Db } from "@/db/client";
import { shopifyOrders, shopifyLineItems } from "@/db/schema";
import type { SubscriptionOrder } from "./subscription-ltv";
import type { ProductInfo } from "@/domain/email/creative";

/**
 * Get all recurring orders for LTV computation.
 */
export async function getSubscriptionOrders(db: Db): Promise<SubscriptionOrder[]> {
  const rows = await db
    .select({
      customerId: shopifyOrders.customerId,
      orderCreatedAt: shopifyOrders.orderCreatedAt,
      totalPriceCents: shopifyOrders.totalPriceCents,
      isRecurring: shopifyOrders.isRecurring,
    })
    .from(shopifyOrders)
    .where(eq(shopifyOrders.isRecurring, 1));

  return rows
    .filter((r) => r.customerId && r.orderCreatedAt)
    .map((r) => ({
      customerId: r.customerId!,
      orderCreatedAt: r.orderCreatedAt!,
      totalPriceCents: Number(r.totalPriceCents),
      isRecurring: true,
    }));
}

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
