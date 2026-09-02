/**
 * Seal subscription transform — pure, no database, no clock.
 *
 * Everything here exists because the raw Seal data cannot be trusted at face
 * value. Three specific traps, each with a test:
 *
 *   1. Tier comes from `variant_id`. It cannot come from `selling_plan_id`,
 *      which is empty on ~90% of records and empty on precisely the
 *      grandfathered cohort we need to identify. It cannot come from price
 *      either — proration means the same plan bills many different amounts.
 *   2. Dunning comes from `billing_attempts[].status === "error"` alone.
 *      Completed attempts routinely retain the `error_code` of an earlier
 *      failure, so reading the code instead over-reports by roughly 3x.
 *   3. Money arrives as major-unit strings and timestamps arrive in mixed
 *      offsets. Both are normalised on the way in, never on the way out.
 */

import type { SealBillingAttempt, SealSubscription } from "@/integrations/seal-api";

export type SubscriptionTier = "spark" | "studio" | "unknown";
export type PricingCohort = "grandfathered" | "current" | "unknown";
export type BillingCadence = "monthly" | "annual" | "other";

interface VariantMapping {
  tier: SubscriptionTier;
  pricingCohort: PricingCohort;
}

/**
 * The only reliable cohort discriminator. Grandfathered and current pricing
 * use genuinely different Shopify variants, which is what makes it possible
 * to tell a $5 legacy Spark from an $8 current one.
 */
export const VARIANT_MAP: Record<string, VariantMapping> = {
  "36983342497944": { tier: "spark", pricingCohort: "grandfathered" },
  "48093950214389": { tier: "spark", pricingCohort: "current" },
  "48150148284661": { tier: "studio", pricingCohort: "grandfathered" },
  "48125741793525": { tier: "studio", pricingCohort: "current" },
};

export function resolveVariant(variantId: string | null | undefined): VariantMapping {
  if (!variantId) return { tier: "unknown", pricingCohort: "unknown" };
  return VARIANT_MAP[variantId] ?? { tier: "unknown", pricingCohort: "unknown" };
}

/**
 * Expected price in cents per tier + cohort + interval. Used only to decide
 * whether a price is plausible, never to assign a tier.
 */
const EXPECTED_PRICE_CENTS: Record<string, number> = {
  "spark|grandfathered|1 month": 500,
  "spark|grandfathered|12 month": 5500,
  "spark|current|1 month": 800,
  "spark|current|12 month": 7200,
  "studio|grandfathered|1 month": 1200,
  "studio|grandfathered|12 month": 12000,
  // A 2026 promo: twelve months plus one free. Same price as the annual plan.
  "studio|grandfathered|13 month": 12000,
  "studio|current|1 month": 1500,
  "studio|current|12 month": 14400,
};

export function parseMoneyToCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function toUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Seal emits both FRAUD__SUSPECTED and FRAUD_SUSPECTED for the same condition. */
export function normaliseErrorCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return code === "FRAUD__SUSPECTED" ? "FRAUD_SUSPECTED" : code;
}

/**
 * The earliest attempt that has not run yet. Seal happens to return these in
 * date order today, but sorting explicitly costs nothing and means a future
 * ordering change cannot quietly move everyone's renewal date.
 */
export function deriveNextBillingDate(attempts: SealBillingAttempt[] | null | undefined): Date | null {
  const scheduled = (attempts ?? [])
    .filter((a) => !a.status)
    .map((a) => toUtc(a.date))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  return scheduled[0] ?? null;
}

export interface DunningState {
  inDunning: boolean;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: Date | null;
}

export function deriveDunning(
  status: string,
  attempts: SealBillingAttempt[] | null | undefined
): DunningState {
  const errored = (attempts ?? [])
    .filter((a) => a.status === "error")
    .sort((a, b) => (toUtc(a.date)?.getTime() ?? 0) - (toUtc(b.date)?.getTime() ?? 0));

  const latest = errored[errored.length - 1];

  return {
    // Only a live subscription can be in dunning. A cancelled one has already
    // finished failing.
    inDunning: status === "ACTIVE" && errored.length > 0,
    lastErrorCode: latest ? normaliseErrorCode(latest.error_code) : null,
    lastErrorMessage: latest?.error_message || null,
    lastErrorAt: latest ? toUtc(latest.date) : null,
  };
}

/**
 * A price is anomalous when it is non-positive, or more than double the
 * expected price for its plan, or when there is no expected price to compare
 * against. Proration and partial discounts land comfortably inside 2x; the
 * genuinely corrupt records ($7,963, $19,382) do not.
 */
export function isPriceAnomaly(
  tier: SubscriptionTier,
  cohort: PricingCohort,
  billingInterval: string,
  priceCents: number | null
): boolean {
  if (priceCents === null || priceCents <= 0) return true;
  const expected = EXPECTED_PRICE_CENTS[`${tier}|${cohort}|${billingInterval}`];
  if (expected === undefined) return true;
  return priceCents > expected * 2;
}

export function toCadence(billingInterval: string): BillingCadence {
  if (billingInterval === "1 month") return "monthly";
  if (billingInterval === "12 month" || billingInterval === "1 year") return "annual";
  // 13 month is a real promo cycle. Folding it into "annual" would silently
  // inflate the annual count; dropping it would silently lose 56 subscribers.
  return "other";
}

export interface SealSubscriptionRow {
  id: string;
  orderId: string;
  shopifyOrderId: string | null;
  manualOrigin: boolean;
  email: string | null;
  status: string;
  tier: SubscriptionTier;
  pricingCohort: PricingCohort;
  variantId: string | null;
  productId: string | null;
  variantSku: string | null;
  productTitle: string | null;
  sellingPlanId: string | null;
  sellingPlanName: string | null;
  planConflict: boolean;
  priceCents: number | null;
  priceAnomaly: boolean;
  currency: string;
  billingInterval: string;
  billingCadence: BillingCadence;
  orderPlaced: Date | null;
  nextBillingDate: Date | null;
  cancelledOn: Date | null;
  cancellationReason: string | null;
  inDunning: boolean;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: Date | null;
  raw: unknown;
  syncedAt: Date;
}

export interface SealSnapshotRow {
  snapshotDate: string;
  subscriptionId: string;
  status: string;
  tier: SubscriptionTier;
  pricingCohort: PricingCohort;
  billingInterval: string;
  billingCadence: BillingCadence;
  priceCents: number | null;
  inDunning: boolean;
  createdAt: Date;
}

export interface TransformedSubscription {
  row: SealSubscriptionRow;
  snapshot: SealSnapshotRow;
  /** Non-null when the record needs a human to look at it. */
  warning: string | null;
}

/** Plan names encode a tier. Where that disagrees with the variant, note it. */
function detectPlanConflict(planName: string, tier: SubscriptionTier): boolean {
  if (!planName || tier === "unknown") return false;
  const lower = planName.toLowerCase();
  if (lower.includes("spark")) return tier !== "spark";
  if (lower.includes("studio")) return tier !== "studio";
  return false;
}

export function transformSubscription(
  sub: SealSubscription,
  syncedAt: Date
): TransformedSubscription {
  const item = sub.items?.[0];
  const { tier, pricingCohort } = resolveVariant(item?.variant_id);
  const priceCents = parseMoneyToCents(item?.price);
  const billingInterval = sub.billing_interval ?? "";
  const priceAnomaly = isPriceAnomaly(tier, pricingCohort, billingInterval, priceCents);
  const dunning = deriveDunning(sub.status, sub.billing_attempts);

  // "_manual_xxxxx" is Seal's placeholder for a subscription created by
  // migration or by hand. There is no Shopify order behind it.
  const orderId = sub.order_id ?? "";
  const isNumericOrder = /^\d+$/.test(orderId);

  const sellingPlanId = item?.selling_plan_id || null;
  const sellingPlanName = item?.selling_plan_name || null;

  const row: SealSubscriptionRow = {
    id: String(sub.id),
    orderId,
    shopifyOrderId: isNumericOrder ? `gid://shopify/Order/${orderId}` : null,
    manualOrigin: !isNumericOrder,
    email: sub.email || null,
    status: sub.status,
    tier,
    pricingCohort,
    variantId: item?.variant_id || null,
    productId: item?.product_id || null,
    variantSku: item?.variant_sku || null,
    productTitle: item?.title || null,
    sellingPlanId,
    sellingPlanName,
    planConflict: detectPlanConflict(sellingPlanName ?? "", tier),
    priceCents,
    priceAnomaly,
    currency: sub.currency || "USD",
    billingInterval,
    billingCadence: toCadence(billingInterval),
    orderPlaced: toUtc(sub.order_placed),
    nextBillingDate: deriveNextBillingDate(sub.billing_attempts),
    cancelledOn: toUtc(sub.cancelled_on),
    cancellationReason: sub.cancellation_reason || null,
    inDunning: dunning.inDunning,
    lastErrorCode: dunning.lastErrorCode,
    lastErrorMessage: dunning.lastErrorMessage,
    lastErrorAt: dunning.lastErrorAt,
    raw: sub,
    syncedAt,
  };

  const snapshot: SealSnapshotRow = {
    snapshotDate: syncedAt.toISOString().slice(0, 10),
    subscriptionId: row.id,
    status: row.status,
    tier: row.tier,
    pricingCohort: row.pricingCohort,
    billingInterval: row.billingInterval,
    billingCadence: row.billingCadence,
    priceCents: row.priceCents,
    inDunning: row.inDunning,
    createdAt: syncedAt,
  };

  // An unmapped variant is a new product we do not know how to price. It must
  // be countable and it must name everything needed to map it.
  const warning =
    tier === "unknown"
      ? `Unmapped Seal variant: subscription=${sub.id} variant_id=${item?.variant_id ?? "(none)"} ` +
        `selling_plan_id=${sellingPlanId ?? "(empty)"} selling_plan_name=${sellingPlanName ?? "(empty)"} ` +
        `price=${item?.price ?? "(none)"} title=${item?.title ?? "(none)"}`
      : null;

  return { row, snapshot, warning };
}

export interface TransformSummary {
  total: number;
  byStatus: Record<string, number>;
  byTier: Record<string, number>;
  byCadence: Record<string, number>;
  inDunning: number;
  unknownTier: number;
  planConflicts: number;
  manualOrigin: number;
  priceAnomalies: number;
  anomalousTotalCents: number;
  mrrCents: number;
  warnings: string[];
}

export function summariseTransform(items: TransformedSubscription[]): TransformSummary {
  const summary: TransformSummary = {
    total: items.length,
    byStatus: {},
    byTier: {},
    byCadence: {},
    inDunning: 0,
    unknownTier: 0,
    planConflicts: 0,
    manualOrigin: 0,
    priceAnomalies: 0,
    anomalousTotalCents: 0,
    mrrCents: 0,
    warnings: [],
  };

  for (const { row, warning } of items) {
    summary.byStatus[row.status] = (summary.byStatus[row.status] ?? 0) + 1;
    summary.byTier[row.tier] = (summary.byTier[row.tier] ?? 0) + 1;
    summary.byCadence[row.billingCadence] = (summary.byCadence[row.billingCadence] ?? 0) + 1;

    if (row.inDunning) summary.inDunning++;
    if (row.tier === "unknown") summary.unknownTier++;
    if (row.planConflict) summary.planConflicts++;
    if (row.manualOrigin) summary.manualOrigin++;
    if (warning) summary.warnings.push(warning);

    if (row.priceAnomaly) {
      summary.priceAnomalies++;
      summary.anomalousTotalCents += row.priceCents ?? 0;
      // Deliberately not added to MRR: a $19,382 subscription would swamp it.
      continue;
    }

    if (row.status !== "ACTIVE" || row.priceCents === null) continue;

    if (row.billingCadence === "monthly") {
      summary.mrrCents += row.priceCents;
    } else if (row.billingCadence === "annual") {
      summary.mrrCents += Math.round(row.priceCents / 12);
    }
    // "other" contributes nothing until we decide what a 13-month cycle is
    // worth per month.
  }

  return summary;
}
