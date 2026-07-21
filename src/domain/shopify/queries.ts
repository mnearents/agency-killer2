/**
 * Shopify database queries — reads order data for LTV calculations,
 * product catalog for email creative, and attribution analysis.
 */

import { eq, gte, desc, sql, and } from "drizzle-orm";
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
