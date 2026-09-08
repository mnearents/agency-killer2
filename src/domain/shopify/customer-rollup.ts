/**
 * Recomputes the derived fields on `shopify_customers` from the tables that
 * already hold the truth: orders, line items, and Seal subscriptions.
 *
 * The rollup is a cache, not a source. Every field it writes could be answered
 * by a five-way join instead; it exists so that questions about customers do
 * not each have to reassemble that join and get it subtly different.
 *
 * Two things it deliberately does not do:
 *
 *   - It never writes a days-since number. `days_since_last_order` would be
 *     wrong the moment a day passed, and a stale number that looks fresh is
 *     worse than a join. The view computes it from `last_order_at`.
 *   - It never leaves a computed field null to mean zero. A customer with no
 *     orders gets 0 and a `derived_at` stamp; a customer the rollup has never
 *     seen keeps nulls. "No orders" and "not computed" must not look alike.
 */

import { sql, eq, isNotNull, and } from "drizzle-orm";
import type { Db } from "@/db/client";
import { shopifyOrders, shopifyLineItems, shopifyCustomers, sealSubscriptions } from "@/db/schema";

export interface CustomerOrderAggregate {
  customerId: string;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  lifetimeOrders: number;
  subscriptionRevenueCents: number;
  oneOffRevenueCents: number;
  productTypes: string[];
}

export interface CustomerSubscription {
  status: string;
  tier: string;
  orderPlaced: Date | null;
  /** True for bulk-imported rows, whose `order_placed` is the import date. */
  manualOrigin: boolean;
}

export interface CustomerDerivedFields {
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  lifetimeOrders: number;
  subscriptionRevenueCents: number;
  oneOffRevenueCents: number;
  productTypesPurchased: string[];
  isSubscriber: number;
  subscriptionTier: string | null;
  subscriptionStatus: string | null;
  derivedAt: Date;
}

/**
 * Which of a customer's subscriptions describes them now.
 *
 * Active beats cancelled outright — someone who lapsed and resubscribed is a
 * subscriber, and taking the newest row regardless of status would call them
 * lapsed whenever the cancellation was recorded last. Within a status, the most
 * recent wins, but real rows outrank bulk-imported ones: `manual_origin` records
 * carry the import timestamp as `order_placed`, so their dates would otherwise
 * sort ahead of every genuine subscription.
 */
function pickSubscription(subs: CustomerSubscription[]): CustomerSubscription | null {
  if (subs.length === 0) return null;

  return [...subs].sort((a, b) => {
    const active = (s: CustomerSubscription) => (s.status === "ACTIVE" ? 1 : 0);
    if (active(a) !== active(b)) return active(b) - active(a);

    const real = (s: CustomerSubscription) => (s.manualOrigin ? 0 : 1);
    if (real(a) !== real(b)) return real(b) - real(a);

    const at = a.orderPlaced?.getTime() ?? -Infinity;
    const bt = b.orderPlaced?.getTime() ?? -Infinity;
    return bt - at;
  })[0];
}

export function deriveCustomerFields(
  input: { orders: CustomerOrderAggregate | null; subscriptions: CustomerSubscription[] },
  derivedAt: Date
): CustomerDerivedFields {
  const { orders, subscriptions } = input;
  const chosen = pickSubscription(subscriptions);

  return {
    firstOrderAt: orders?.firstOrderAt ?? null,
    lastOrderAt: orders?.lastOrderAt ?? null,
    lifetimeOrders: orders?.lifetimeOrders ?? 0,
    subscriptionRevenueCents: orders?.subscriptionRevenueCents ?? 0,
    oneOffRevenueCents: orders?.oneOffRevenueCents ?? 0,
    productTypesPurchased: orders?.productTypes ?? [],

    isSubscriber: subscriptions.some((s) => s.status === "ACTIVE") ? 1 : 0,
    subscriptionTier: chosen?.tier ?? null,
    subscriptionStatus: chosen?.status ?? null,

    derivedAt,
  };
}

/**
 * Per-customer order totals and the set of product types they have bought.
 *
 * Product types are aggregated in their own subquery rather than joined into
 * the order aggregate directly: a customer with four line items on one order
 * would otherwise be counted as having placed four orders and spent four times
 * what they did.
 */
export function buildCustomerOrderAggregateQuery(db: Db) {
  const totals = db
    .select({
      customerId: shopifyOrders.customerId,
      firstOrderAt: sql<Date>`MIN(${shopifyOrders.orderCreatedAt})`.as("first_order_at"),
      lastOrderAt: sql<Date>`MAX(${shopifyOrders.orderCreatedAt})`.as("last_order_at"),
      lifetimeOrders: sql<number>`COUNT(*)`.as("lifetime_orders"),
      subscriptionRevenueCents:
        sql<number>`COALESCE(SUM(CASE WHEN ${shopifyOrders.isRecurring} = 1 THEN ${shopifyOrders.totalPriceCents} ELSE 0 END), 0)`.as(
          "subscription_revenue_cents"
        ),
      oneOffRevenueCents:
        sql<number>`COALESCE(SUM(CASE WHEN ${shopifyOrders.isRecurring} = 1 THEN 0 ELSE ${shopifyOrders.totalPriceCents} END), 0)`.as(
          "one_off_revenue_cents"
        ),
    })
    .from(shopifyOrders)
    .where(isNotNull(shopifyOrders.customerId))
    .groupBy(shopifyOrders.customerId)
    .as("totals");

  const types = db
    .select({
      customerId: shopifyOrders.customerId,
      productTypes: sql<
        string[]
      >`ARRAY_AGG(DISTINCT ${shopifyLineItems.productType})`.as("product_types"),
    })
    .from(shopifyLineItems)
    .innerJoin(shopifyOrders, eq(shopifyOrders.id, shopifyLineItems.orderId))
    .where(and(isNotNull(shopifyOrders.customerId), isNotNull(shopifyLineItems.productType)))
    .groupBy(shopifyOrders.customerId)
    .as("types");

  return db
    .select({
      customerId: totals.customerId,
      firstOrderAt: totals.firstOrderAt,
      lastOrderAt: totals.lastOrderAt,
      lifetimeOrders: totals.lifetimeOrders,
      subscriptionRevenueCents: totals.subscriptionRevenueCents,
      oneOffRevenueCents: totals.oneOffRevenueCents,
      // Left, not inner: a customer whose orders predate line-item capture
      // still has orders, and an inner join would drop them from the rollup.
      productTypes: sql<string[] | null>`${types.productTypes}`,
    })
    .from(totals)
    .leftJoin(types, eq(types.customerId, totals.customerId));
}

/**
 * Every subscription, keyed to the Shopify customer GID it belongs to.
 *
 * Seal stores the bare numeric customer ID and Shopify stores a GID, so the
 * join reduces one to the other — the same `split_part(..., '/', 5)` the
 * analytics views use.
 */
export function buildCustomerSubscriptionQuery(db: Db) {
  return db
    .select({
      customerId: shopifyCustomers.id,
      status: sealSubscriptions.status,
      tier: sealSubscriptions.tier,
      orderPlaced: sealSubscriptions.orderPlaced,
      manualOrigin: sealSubscriptions.manualOrigin,
    })
    .from(sealSubscriptions)
    .innerJoin(
      shopifyCustomers,
      eq(
        sealSubscriptions.customerId,
        sql`NULLIF(split_part(${shopifyCustomers.id}, '/', 5), '')`
      )
    )
    .where(isNotNull(sealSubscriptions.customerId));
}

export interface RollupResult {
  /** Customers whose derived fields were written. */
  updated: number;
  /** Of those, how many had at least one order. */
  withOrders: number;
  /** Of those, how many are currently subscribed. */
  subscribers: number;
}

/**
 * Recompute derived fields for every customer in `shopify_customers`.
 *
 * Every customer is updated, including those with no orders and no
 * subscriptions — that is the whole point of `derived_at`. Skipping them would
 * leave their fields null and indistinguishable from never having been rolled
 * up at all.
 */
export async function rollupCustomers(db: Db, derivedAt: Date): Promise<RollupResult> {
  const aggregates = await buildCustomerOrderAggregateQuery(db);
  const subscriptionRows = await buildCustomerSubscriptionQuery(db);

  const aggByCustomer = new Map<string, CustomerOrderAggregate>();
  for (const row of aggregates) {
    if (!row.customerId) continue;
    aggByCustomer.set(row.customerId, {
      customerId: row.customerId,
      firstOrderAt: row.firstOrderAt ? new Date(row.firstOrderAt) : null,
      lastOrderAt: row.lastOrderAt ? new Date(row.lastOrderAt) : null,
      lifetimeOrders: Number(row.lifetimeOrders),
      subscriptionRevenueCents: Number(row.subscriptionRevenueCents),
      oneOffRevenueCents: Number(row.oneOffRevenueCents),
      productTypes: row.productTypes ?? [],
    });
  }

  const subsByCustomer = new Map<string, CustomerSubscription[]>();
  for (const row of subscriptionRows) {
    const existing = subsByCustomer.get(row.customerId) ?? [];
    existing.push({
      status: row.status,
      tier: row.tier,
      orderPlaced: row.orderPlaced ? new Date(row.orderPlaced) : null,
      manualOrigin: row.manualOrigin === 1,
    });
    subsByCustomer.set(row.customerId, existing);
  }

  const ids = await db.select({ id: shopifyCustomers.id }).from(shopifyCustomers);

  let updated = 0;
  let withOrders = 0;
  let subscribers = 0;

  for (const { id } of ids) {
    const derived = deriveCustomerFields(
      {
        orders: aggByCustomer.get(id) ?? null,
        subscriptions: subsByCustomer.get(id) ?? [],
      },
      derivedAt
    );

    await db
      .update(shopifyCustomers)
      .set({ ...derived, updatedAt: derivedAt })
      .where(eq(shopifyCustomers.id, id));

    updated++;
    if (derived.lifetimeOrders > 0) withOrders++;
    if (derived.isSubscriber === 1) subscribers++;
  }

  return { updated, withOrders, subscribers };
}
