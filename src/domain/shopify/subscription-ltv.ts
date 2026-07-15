/**
 * Subscription LTV computation — calculates lifetime value from order history.
 *
 * Rad & Happy sells a subscription at $8/mo. A <1x ROAS is acceptable when
 * the LTV exceeds the acquisition cost. This module computes LTV from real
 * order data so the Meta analysis can make accurate profitability decisions.
 *
 * Subscriptions are identified by the "recurring-order" tag in Shopify.
 */

export interface SubscriptionOrder {
  customerId: string;
  orderCreatedAt: Date;
  totalPriceCents: number;
  isRecurring: boolean;
}

export interface CustomerLtv {
  customerId: string;
  totalOrders: number;
  totalRevenueCents: number;
  firstOrderDate: Date;
  lastOrderDate: Date;
  tenureMonths: number;
  avgMonthlyRevenueCents: number;
  isChurned: boolean;
}

export interface LtvSummary {
  totalSubscribers: number;
  activeSubscribers: number;
  churnedSubscribers: number;
  avgTenureMonths: number;
  avgLtvCents: number;
  avgMonthlyRevenueCents: number;
  medianTenureMonths: number;
}

const DEFAULT_CHURN_THRESHOLD_DAYS = 45;

/**
 * Check if a Shopify order is a subscription based on its tags.
 * Tags come from Shopify as a JSONB array of strings.
 */
export function isSubscriptionOrder(tags: unknown): boolean {
  if (!Array.isArray(tags)) return false;
  return tags.includes("recurring-order");
}

/**
 * Compute months between two dates. Uses calendar months, not 30-day periods.
 */
function monthsBetween(start: Date, end: Date): number {
  const years = end.getFullYear() - start.getFullYear();
  const months = end.getMonth() - start.getMonth();
  return years * 12 + months;
}

/**
 * Compute days between two dates.
 */
function daysBetween(start: Date, end: Date): number {
  return Math.floor(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
  );
}

/**
 * Compute LTV for a single customer from their subscription orders.
 * Returns null if the customer has no orders.
 *
 * @param asOfDate - Fixed date for "now" (no wall clock — deterministic)
 * @param churnThresholdDays - Days since last order to consider churned (default 45)
 */
export function computeCustomerLtv(
  orders: SubscriptionOrder[],
  customerId: string,
  asOfDate: Date,
  churnThresholdDays = DEFAULT_CHURN_THRESHOLD_DAYS
): CustomerLtv | null {
  const customerOrders = orders
    .filter((o) => o.customerId === customerId)
    .sort((a, b) => a.orderCreatedAt.getTime() - b.orderCreatedAt.getTime());

  if (customerOrders.length === 0) return null;

  const firstOrderDate = customerOrders[0].orderCreatedAt;
  const lastOrderDate = customerOrders[customerOrders.length - 1].orderCreatedAt;
  const totalRevenueCents = customerOrders.reduce(
    (sum, o) => sum + o.totalPriceCents,
    0
  );
  const tenureMonths = monthsBetween(firstOrderDate, lastOrderDate);
  const daysSinceLastOrder = daysBetween(lastOrderDate, asOfDate);

  return {
    customerId,
    totalOrders: customerOrders.length,
    totalRevenueCents,
    firstOrderDate,
    lastOrderDate,
    tenureMonths,
    avgMonthlyRevenueCents:
      tenureMonths > 0
        ? Math.round(totalRevenueCents / tenureMonths)
        : totalRevenueCents,
    isChurned: daysSinceLastOrder > churnThresholdDays,
  };
}

/**
 * Compute aggregate LTV summary across all subscribers.
 *
 * @param asOfDate - Fixed date for "now" (no wall clock — deterministic)
 */
export function computeLtvSummary(
  orders: SubscriptionOrder[],
  asOfDate: Date,
  churnThresholdDays = DEFAULT_CHURN_THRESHOLD_DAYS
): LtvSummary {
  // Group orders by customer
  const customerIds = [...new Set(orders.map((o) => o.customerId))];

  if (customerIds.length === 0) {
    return {
      totalSubscribers: 0,
      activeSubscribers: 0,
      churnedSubscribers: 0,
      avgTenureMonths: 0,
      avgLtvCents: 0,
      avgMonthlyRevenueCents: 0,
      medianTenureMonths: 0,
    };
  }

  const ltvs: CustomerLtv[] = [];
  for (const id of customerIds) {
    const ltv = computeCustomerLtv(orders, id, asOfDate, churnThresholdDays);
    if (ltv) ltvs.push(ltv);
  }

  const active = ltvs.filter((l) => !l.isChurned);
  const churned = ltvs.filter((l) => l.isChurned);

  const totalTenure = ltvs.reduce((s, l) => s + l.tenureMonths, 0);
  const totalLtv = ltvs.reduce((s, l) => s + l.totalRevenueCents, 0);
  const totalMonthlyRev = ltvs.reduce(
    (s, l) => s + l.avgMonthlyRevenueCents,
    0
  );

  const sortedTenures = ltvs.map((l) => l.tenureMonths).sort((a, b) => a - b);
  const mid = Math.floor(sortedTenures.length / 2);
  const medianTenure =
    sortedTenures.length % 2 === 0
      ? (sortedTenures[mid - 1] + sortedTenures[mid]) / 2
      : sortedTenures[mid];

  return {
    totalSubscribers: ltvs.length,
    activeSubscribers: active.length,
    churnedSubscribers: churned.length,
    avgTenureMonths: totalTenure / ltvs.length,
    avgLtvCents: totalLtv / ltvs.length,
    avgMonthlyRevenueCents: totalMonthlyRev / ltvs.length,
    medianTenureMonths: medianTenure,
  };
}
