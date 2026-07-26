/**
 * Subscription LTV computation — calculates lifetime value from order history.
 *
 * Handles multiple products, billing frequencies, and pricing tiers:
 *
 * Color Happy (legacy):  $5/mo or $55/year
 * Really Awesome Doodles Tier 1: $8/mo or $72/year
 * Really Awesome Doodles Tier 2: $15/mo or $144/year
 *
 * Yearly orders are normalized to monthly equivalent for accurate
 * tenure and avg monthly revenue calculations.
 */

export interface SubscriptionOrder {
  customerId: string;
  orderCreatedAt: Date;
  totalPriceCents: number;
  isRecurring: boolean;
}

export type BillingFrequency = "monthly" | "yearly" | "unknown";
export type SubscriptionTier = "color-happy" | "rad-tier-1" | "rad-tier-2" | "unknown";

export interface ClassifiedOrder extends SubscriptionOrder {
  tier: SubscriptionTier;
  frequency: BillingFrequency;
  monthsCovered: number; // 1 for monthly, 12 for yearly
  monthlyValueCents: number; // normalized to per-month
}

export interface CustomerLtv {
  customerId: string;
  totalOrders: number;
  totalRevenueCents: number;
  totalMonthsCovered: number; // sum of monthsCovered across all orders
  firstOrderDate: Date;
  lastOrderDate: Date;
  currentTier: SubscriptionTier;
  currentFrequency: BillingFrequency;
  avgMonthlyRevenueCents: number;
  isChurned: boolean;
}

export interface TierSummary {
  tier: SubscriptionTier;
  subscribers: number;
  active: number;
  churned: number;
  avgTenureMonths: number;
  avgLtvCents: number;
  avgMonthlyRevenueCents: number;
  monthlyPrice: string;
}

export interface LtvSummary {
  totalSubscribers: number;
  activeSubscribers: number;
  churnedSubscribers: number;
  avgTenureMonths: number;
  avgLtvCents: number;
  avgMonthlyRevenueCents: number;
  medianTenureMonths: number;
  tiers: TierSummary[];
}

const DEFAULT_CHURN_THRESHOLD_DAYS = 45;
// Yearly subscribers only order once a year — need a longer window
const YEARLY_CHURN_THRESHOLD_DAYS = 395; // 13 months

const SUBSCRIPTION_TAGS = [
  "recurring-order",
  "colorhappy-first",
  "rad-first",
];

export function isSubscriptionOrder(tags: unknown): boolean {
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => SUBSCRIPTION_TAGS.includes(tag));
}

/**
 * Classify an order by tier and billing frequency based on price.
 * Prices are distinct enough to identify unambiguously.
 */
export function classifyOrder(order: SubscriptionOrder): ClassifiedOrder {
  const priceDollars = order.totalPriceCents / 100;

  let tier: SubscriptionTier = "unknown";
  let frequency: BillingFrequency = "unknown";
  let monthsCovered = 1;
  let monthlyValueCents = order.totalPriceCents;

  // Color Happy
  if (priceDollars >= 4.5 && priceDollars <= 5.5) {
    tier = "color-happy";
    frequency = "monthly";
    monthsCovered = 1;
    monthlyValueCents = order.totalPriceCents;
  } else if (priceDollars >= 53 && priceDollars <= 57) {
    tier = "color-happy";
    frequency = "yearly";
    monthsCovered = 12;
    monthlyValueCents = Math.round(order.totalPriceCents / 12);
  }
  // RAD Tier 1
  else if (priceDollars >= 7.5 && priceDollars <= 8.5) {
    tier = "rad-tier-1";
    frequency = "monthly";
    monthsCovered = 1;
    monthlyValueCents = order.totalPriceCents;
  } else if (priceDollars >= 70 && priceDollars <= 74) {
    tier = "rad-tier-1";
    frequency = "yearly";
    monthsCovered = 12;
    monthlyValueCents = Math.round(order.totalPriceCents / 12);
  }
  // RAD Tier 2
  else if (priceDollars >= 14.5 && priceDollars <= 15.5) {
    tier = "rad-tier-2";
    frequency = "monthly";
    monthsCovered = 1;
    monthlyValueCents = order.totalPriceCents;
  } else if (priceDollars >= 142 && priceDollars <= 146) {
    tier = "rad-tier-2";
    frequency = "yearly";
    monthsCovered = 12;
    monthlyValueCents = Math.round(order.totalPriceCents / 12);
  }

  return { ...order, tier, frequency, monthsCovered, monthlyValueCents };
}

function monthsBetween(start: Date, end: Date): number {
  const years = end.getFullYear() - start.getFullYear();
  const months = end.getMonth() - start.getMonth();
  return years * 12 + months;
}

function daysBetween(start: Date, end: Date): number {
  return Math.floor(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
  );
}

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

  const classified = customerOrders.map(classifyOrder);

  const firstOrderDate = classified[0].orderCreatedAt;
  const lastOrderDate = classified[classified.length - 1].orderCreatedAt;
  const lastOrder = classified[classified.length - 1];

  const totalRevenueCents = classified.reduce(
    (sum, o) => sum + o.totalPriceCents,
    0
  );

  // Total months covered = sum of monthsCovered across all orders
  // This gives accurate tenure: a yearly order counts as 12 months
  const totalMonthsCovered = classified.reduce(
    (sum, o) => sum + o.monthsCovered,
    0
  );

  // Use the appropriate churn threshold based on billing frequency
  const effectiveChurnDays =
    lastOrder.frequency === "yearly"
      ? YEARLY_CHURN_THRESHOLD_DAYS
      : churnThresholdDays;

  const daysSinceLastOrder = daysBetween(lastOrderDate, asOfDate);

  // Average monthly revenue = total revenue / total months covered
  const avgMonthlyRevenueCents =
    totalMonthsCovered > 0
      ? Math.round(totalRevenueCents / totalMonthsCovered)
      : classified[0].monthlyValueCents;

  return {
    customerId,
    totalOrders: classified.length,
    totalRevenueCents,
    totalMonthsCovered,
    firstOrderDate,
    lastOrderDate,
    currentTier: lastOrder.tier,
    currentFrequency: lastOrder.frequency,
    avgMonthlyRevenueCents,
    isChurned: daysSinceLastOrder > effectiveChurnDays,
  };
}

export function computeLtvSummary(
  orders: SubscriptionOrder[],
  asOfDate: Date,
  churnThresholdDays = DEFAULT_CHURN_THRESHOLD_DAYS
): LtvSummary {
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
      tiers: [],
    };
  }

  const ltvs: CustomerLtv[] = [];
  for (const id of customerIds) {
    const ltv = computeCustomerLtv(orders, id, asOfDate, churnThresholdDays);
    if (ltv) ltvs.push(ltv);
  }

  const active = ltvs.filter((l) => !l.isChurned);
  const churned = ltvs.filter((l) => l.isChurned);

  const totalTenure = ltvs.reduce((s, l) => s + l.totalMonthsCovered, 0);
  const totalLtv = ltvs.reduce((s, l) => s + l.totalRevenueCents, 0);
  const totalMonthlyRev = ltvs.reduce(
    (s, l) => s + l.avgMonthlyRevenueCents,
    0
  );

  const sortedTenures = ltvs
    .map((l) => l.totalMonthsCovered)
    .sort((a, b) => a - b);
  const mid = Math.floor(sortedTenures.length / 2);
  const medianTenure =
    sortedTenures.length % 2 === 0
      ? (sortedTenures[mid - 1] + sortedTenures[mid]) / 2
      : sortedTenures[mid];

  // Build per-tier breakdown
  const tierMap = new Map<SubscriptionTier, CustomerLtv[]>();
  for (const ltv of ltvs) {
    const existing = tierMap.get(ltv.currentTier) ?? [];
    existing.push(ltv);
    tierMap.set(ltv.currentTier, existing);
  }

  const monthlyPrices: Record<SubscriptionTier, string> = {
    "color-happy": "$5/mo",
    "rad-tier-1": "$8/mo",
    "rad-tier-2": "$15/mo",
    unknown: "unknown",
  };

  const tiers: TierSummary[] = [];
  for (const [tier, tierLtvs] of tierMap) {
    const tierActive = tierLtvs.filter((l) => !l.isChurned);
    const tierChurned = tierLtvs.filter((l) => l.isChurned);
    const tierTenure = tierLtvs.reduce((s, l) => s + l.totalMonthsCovered, 0);
    const tierLtv = tierLtvs.reduce((s, l) => s + l.totalRevenueCents, 0);
    const tierMonthly = tierLtvs.reduce(
      (s, l) => s + l.avgMonthlyRevenueCents,
      0
    );

    tiers.push({
      tier,
      subscribers: tierLtvs.length,
      active: tierActive.length,
      churned: tierChurned.length,
      avgTenureMonths: tierTenure / tierLtvs.length,
      avgLtvCents: tierLtv / tierLtvs.length,
      avgMonthlyRevenueCents: tierMonthly / tierLtvs.length,
      monthlyPrice: monthlyPrices[tier],
    });
  }

  // Sort tiers by subscriber count descending
  tiers.sort((a, b) => b.subscribers - a.subscribers);

  return {
    totalSubscribers: ltvs.length,
    activeSubscribers: active.length,
    churnedSubscribers: churned.length,
    avgTenureMonths: totalTenure / ltvs.length,
    avgLtvCents: totalLtv / ltvs.length,
    avgMonthlyRevenueCents: totalMonthlyRev / ltvs.length,
    medianTenureMonths: medianTenure,
    tiers,
  };
}
