/**
 * Is a subscription billed the right amount? (#8)
 *
 * `isPriceAnomaly` only fires above 2x expected, so it caught the $120/month
 * overcharge and missed every undercharge — and an undercharge is the shape
 * the tier-change billing bug actually takes. Subscription 14101980 bills $12
 * a year against $120 expected: below grid, above zero, invisible.
 *
 * ## Why this does not change `isPriceAnomaly`
 *
 * #8 proposes raising that flag "on any deviation from grid, in either
 * direction". That would be wrong, and expensively so.
 *
 * `priceAnomaly` controls exclusion from MRR: `summariseActive` drops those
 * subscriptions and totals them under `excluded.anomalousTotalCents`, because
 * a corrupt number folded into MRR hides itself. A Studio subscriber billed
 * Spark's $5 is not a corrupt number — $5 is what we collect every month, and
 * it belongs in MRR. Flagging them would delete real revenue from the headline
 * to report a billing error. Against production that is 62 subscriptions and
 * roughly $350 a month.
 *
 * Two questions, opposite responses, so they do not share a return value:
 *
 *     priceAnomaly   is this number usable for money maths?   exclude it
 *     off-grid       are we billing the right amount?          fix the billing
 *
 * This module answers the second and touches nothing about the first.
 *
 * ## Derived, never stored
 *
 * #8 suggests backfilling a flag onto `seal_subscriptions`. The verdict is a
 * function of tier, cohort, interval and price — all already stored — so
 * deriving it at read time cannot go stale when the grid changes, and a stored
 * flag would. There is no migration here on purpose.
 *
 * Pure functions only — no database, no clock.
 */

import { expectedPriceCents } from "./sync-transform";

export type PriceVerdict =
  | "on-grid"
  | "undercharge"
  | "overcharge"
  /** Zero or negative. Not a cheap plan. */
  | "non-positive"
  /** No price recorded at all — unknown, not zero. */
  | "no-price"
  /** No grid row for this tier/cohort/interval. A product decision nobody recorded. */
  | "unknown-plan";

export interface PriceAssessment {
  verdict: PriceVerdict;
  expectedCents: number | null;
  actualCents: number | null;
  /** actual - expected. Negative is an undercharge. Null when there is nothing to compare. */
  deltaCents: number | null;
}

export function assessPrice(
  tier: string,
  cohort: string,
  billingInterval: string,
  priceCents: number | null
): PriceAssessment {
  const expectedCents = expectedPriceCents(tier, cohort, billingInterval);

  if (priceCents === null) {
    return { verdict: "no-price", expectedCents, actualCents: null, deltaCents: null };
  }

  // Checked before the grid lookup: a price of zero is wrong whether or not we
  // know what it should have been.
  if (priceCents <= 0) {
    return { verdict: "non-positive", expectedCents, actualCents: priceCents, deltaCents: null };
  }

  if (expectedCents === null) {
    // No delta rather than a delta of zero: there is no expectation to differ
    // from, and 0 would read as "correct".
    return { verdict: "unknown-plan", expectedCents: null, actualCents: priceCents, deltaCents: null };
  }

  const deltaCents = priceCents - expectedCents;
  if (deltaCents === 0) {
    return { verdict: "on-grid", expectedCents, actualCents: priceCents, deltaCents: 0 };
  }

  return {
    verdict: deltaCents < 0 ? "undercharge" : "overcharge",
    expectedCents,
    actualCents: priceCents,
    deltaCents,
  };
}

export interface PricedSubscription {
  id: string;
  status: string;
  tier: string;
  pricingCohort: string;
  billingInterval: string;
  /** Normalised: monthly, annual, other. */
  billingCadence: string;
  priceCents: number | null;
  /**
   * Whether `isPriceAnomaly` already judged this number unusable.
   *
   * Carried through so the two questions stay separable in the OUTPUT as well
   * as in the code. Against production four records at $19,382, $7,963,
   * $2,425 and $2,207 dominate the overcharge total, and reading that as
   * "$2,770 a month of customers being overbilled" would be badly wrong —
   * they are corrupt rows already excluded from MRR, not people paying.
   */
  priceAnomaly: boolean;
}

export interface OffGridSubscription {
  id: string;
  tier: string;
  pricingCohort: string;
  billingInterval: string;
  verdict: Extract<PriceVerdict, "undercharge" | "overcharge">;
  expectedCents: number;
  actualCents: number;
  deltaCents: number;
  /** True when this row is already excluded from MRR as a corrupt number. */
  alsoPriceAnomaly: boolean;
  /**
   * The delta expressed per month.
   *
   * An annual shortfall is spread over the year it covers, so a $108 annual
   * undercharge is $9 a month and can be ranked against a monthly one. Raw
   * delta puts the annual case on top when the monthly one costs more.
   */
  monthlyImpactCents: number;
}

export interface UnpriceableSubscription {
  id: string;
  tier: string;
  pricingCohort: string;
  billingInterval: string;
  verdict: Extract<PriceVerdict, "non-positive" | "no-price" | "unknown-plan">;
  actualCents: number | null;
}

export interface PricingSummary {
  /** Active subscriptions actually compared against the grid. */
  assessed: number;
  onGrid: number;
  /** Ordered by monthly impact, worst first. */
  offGrid: OffGridSubscription[];
  /** Listed rather than counted as correct — none of these can be compared. */
  unpriceable: UnpriceableSubscription[];
  monthlyUnderchargeCents: number;
  monthlyOverchargeCents: number;
  /**
   * The overcharge total with corrupt rows removed.
   *
   * This is the figure about customers. The gross total is dominated by four
   * records that `priceAnomaly` already excludes from MRR, and quoting it
   * would describe a mass overbilling that is not happening.
   */
  monthlyOverchargeExcludingCorruptCents: number;
  /** Cancelled subscriptions bill nothing, so their mispricing costs nothing. */
  excludedNotActive: number;
}

const ACTIVE = "ACTIVE";
const MONTHS_PER_YEAR = 12;

/** How many months one billing period covers. */
function monthsPerPeriod(billingCadence: string, billingInterval: string): number {
  if (billingCadence === "annual") return MONTHS_PER_YEAR;
  // "13 month" is the 2026 promo: twelve months plus one free.
  const match = billingInterval.match(/^(\d+)\s*month/);
  if (match) return Math.max(1, Number(match[1]));
  return 1;
}

export function summarisePricing(subscriptions: PricedSubscription[]): PricingSummary {
  const offGrid: OffGridSubscription[] = [];
  const unpriceable: UnpriceableSubscription[] = [];
  let assessed = 0;
  let onGrid = 0;
  let excludedNotActive = 0;
  let monthlyUnderchargeCents = 0;
  let monthlyOverchargeCents = 0;
  let monthlyOverchargeExcludingCorruptCents = 0;

  for (const s of subscriptions) {
    // A cancelled subscription bills nothing, so its mispricing costs nothing
    // and would pad the total with money that was never at stake.
    if (s.status !== ACTIVE) {
      excludedNotActive++;
      continue;
    }

    const a = assessPrice(s.tier, s.pricingCohort, s.billingInterval, s.priceCents);

    if (a.verdict === "non-positive" || a.verdict === "no-price" || a.verdict === "unknown-plan") {
      unpriceable.push({
        id: s.id,
        tier: s.tier,
        pricingCohort: s.pricingCohort,
        billingInterval: s.billingInterval,
        verdict: a.verdict,
        actualCents: a.actualCents,
      });
      continue;
    }

    assessed++;
    if (a.verdict === "on-grid") {
      onGrid++;
      continue;
    }

    const months = monthsPerPeriod(s.billingCadence, s.billingInterval);
    const monthlyImpactCents = Math.round(a.deltaCents! / months);

    if (a.verdict === "undercharge") {
      monthlyUnderchargeCents += Math.abs(monthlyImpactCents);
    } else {
      monthlyOverchargeCents += monthlyImpactCents;
      if (!s.priceAnomaly) monthlyOverchargeExcludingCorruptCents += monthlyImpactCents;
    }

    offGrid.push({
      id: s.id,
      tier: s.tier,
      pricingCohort: s.pricingCohort,
      billingInterval: s.billingInterval,
      verdict: a.verdict,
      expectedCents: a.expectedCents!,
      actualCents: a.actualCents!,
      deltaCents: a.deltaCents!,
      alsoPriceAnomaly: s.priceAnomaly,
      monthlyImpactCents,
    });
  }

  // Worst monthly impact first, in either direction.
  offGrid.sort((x, y) => Math.abs(y.monthlyImpactCents) - Math.abs(x.monthlyImpactCents));

  return {
    assessed,
    onGrid,
    offGrid,
    unpriceable,
    monthlyUnderchargeCents,
    monthlyOverchargeCents,
    monthlyOverchargeExcludingCorruptCents,
    excludedNotActive,
  };
}
