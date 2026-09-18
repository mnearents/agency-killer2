/**
 * ─── Off-grid pricing (#8) ────────────────────────────────────────────
 *
 * `isPriceAnomaly` only fires above 2x expected, so it caught the $120/month
 * overcharge and missed every undercharge — and an undercharge is the shape
 * the tier-change billing bug actually takes. Subscription 14101980 bills $12
 * a year against $120 expected: below grid, above zero, invisible.
 *
 * ## Why this is NOT a change to `isPriceAnomaly`
 *
 * #8 proposes raising that flag "on any deviation from grid, in either
 * direction". That would be wrong, and expensively so.
 *
 * `priceAnomaly` controls exclusion from MRR — `summariseActive` drops those
 * subscriptions and totals them under `excluded.anomalousTotalCents`, because
 * a corrupt number folded into MRR hides itself. A Studio subscriber billed
 * Spark's $5 is not a corrupt number: $5 is what we actually collect every
 * month, and it belongs in MRR. Flagging them would delete real revenue from
 * the headline figure to report a billing error.
 *
 * Against production that is 62 subscriptions and roughly $350 a month.
 *
 * So these are two questions with opposite responses, and CLAUDE.md is explicit
 * that they must not share a return value:
 *
 *   priceAnomaly  — is this number usable for money maths?   (exclude it)
 *   off-grid      — are we billing the right amount?          (fix the billing)
 *
 * This module answers the second and touches nothing about the first.
 */

import { describe, it, expect } from "vitest";
import { assessPrice, summarisePricing, type PricedSubscription } from "@/domain/subscriptions/pricing";

describe("assessPrice", () => {
  it("calls a grid price on-grid", () => {
    const r = assessPrice("spark", "grandfathered", "1 month", 500);
    expect(r.verdict).toBe("on-grid");
    expect(r.deltaCents).toBe(0);
  });

  /**
   * The case #8 was filed for: subscription 14101980, $12 a year against $120
   * expected. Below grid, above zero, and more than a rounding error.
   */
  it("catches the annual subscription billed a tenth of its plan", () => {
    const r = assessPrice("studio", "grandfathered", "12 month", 1200);
    expect(r.verdict).toBe("undercharge");
    expect(r.expectedCents).toBe(12000);
    expect(r.deltaCents).toBe(-10800);
  });

  /**
   * The most likely real failure, per #8: a Studio subscriber still billed
   * Spark's $5 after an upgrade. A 2x test returns false on a 3x undercharge.
   * Against production exactly one subscription sits here.
   */
  it("catches a Studio subscriber billed Spark's price", () => {
    const r = assessPrice("studio", "grandfathered", "1 month", 500);
    expect(r.verdict).toBe("undercharge");
    expect(r.deltaCents).toBe(-700);
  });

  it("catches an overcharge", () => {
    const r = assessPrice("spark", "grandfathered", "1 month", 700);
    expect(r.verdict).toBe("overcharge");
    expect(r.deltaCents).toBe(200);
  });

  /**
   * Direction is recorded rather than magnitude alone because the two need
   * opposite responses. An undercharge is revenue quietly leaking; an
   * overcharge is a customer being harmed and a support ticket waiting to
   * happen. A single "off by 700" tells you to look, not what to do.
   */
  it("separates the two directions rather than reporting a distance", () => {
    expect(assessPrice("spark", "grandfathered", "1 month", 300).verdict).toBe("undercharge");
    expect(assessPrice("spark", "grandfathered", "1 month", 700).verdict).toBe("overcharge");
  });

  // Zero is not a cheap plan.
  it("calls a non-positive price what it is", () => {
    expect(assessPrice("studio", "grandfathered", "1 month", 0).verdict).toBe("non-positive");
    expect(assessPrice("studio", "grandfathered", "1 month", -100).verdict).toBe("non-positive");
  });

  it("calls a missing price unknown rather than zero", () => {
    const r = assessPrice("studio", "grandfathered", "1 month", null);
    expect(r.verdict).toBe("no-price");
    expect(r.deltaCents).toBeNull();
  });

  /**
   * #8: "an unrecognised plan is a product decision nobody recorded, and
   * should surface rather than default to fine." There is no grid row to
   * compare against, so there is no delta — null, not 0.
   */
  it("surfaces a plan that is not on the grid at all", () => {
    const r = assessPrice("studio", "current", "13 month", 1500);
    expect(r.verdict).toBe("unknown-plan");
    expect(r.expectedCents).toBeNull();
    expect(r.deltaCents).toBeNull();
  });

  /**
   * Grandfathered pricing is only reachable by existing Color Happy
   * subscribers, so a CURRENT-cohort subscriber sitting on a grandfathered
   * price is a signal in itself (#8), not a rounding difference. It reads as
   * an undercharge because that is what it is.
   */
  it("reads a current subscriber on grandfathered pricing as an undercharge", () => {
    const r = assessPrice("studio", "current", "1 month", 1200);
    expect(r.verdict).toBe("undercharge");
    expect(r.expectedCents).toBe(1500);
  });
});

/**
 * ─── The monthly cost of being wrong ──────────────────────────────────
 *
 * A $10,800 annual undercharge and a $700 monthly one are not comparable until
 * both are expressed per month, and ranking by raw delta puts the annual one
 * on top when the monthly one costs more over a year.
 */
describe("summarisePricing", () => {
  const sub = (over: Partial<PricedSubscription> = {}): PricedSubscription => ({
    id: "1",
    status: "ACTIVE",
    tier: "spark",
    pricingCohort: "grandfathered",
    billingInterval: "1 month",
    billingCadence: "monthly",
    priceCents: 500,
    priceAnomaly: false,
    ...over,
  });

  it("counts nothing wrong when everything is on grid", () => {
    const r = summarisePricing([sub(), sub({ id: "2" })]);
    expect(r.offGrid).toHaveLength(0);
    expect(r.monthlyUnderchargeCents).toBe(0);
    expect(r.monthlyOverchargeCents).toBe(0);
  });

  it("totals undercharges and overcharges separately", () => {
    const r = summarisePricing([
      sub({ id: "u", priceCents: 300 }),
      sub({ id: "o", priceCents: 700 }),
    ]);
    expect(r.monthlyUnderchargeCents).toBe(200);
    expect(r.monthlyOverchargeCents).toBe(200);
  });

  /**
   * An annual plan's shortfall is spread over the year it covers, so a $108
   * annual undercharge is $9 a month — comparable with a monthly one, and
   * rankable against it. The sign is kept, so the direction is readable from
   * the number as well as from the verdict.
   */
  it("amortises an annual shortfall over the year", () => {
    const r = summarisePricing([
      sub({ id: "a", billingInterval: "12 month", billingCadence: "annual", priceCents: 1200, tier: "studio" }),
    ]);
    expect(r.offGrid[0].monthlyImpactCents).toBe(-900);
  });

  it("ranks by monthly impact, not by raw delta", () => {
    const r = summarisePricing([
      // $108/yr short = $9/month.
      sub({ id: "annual", tier: "studio", billingInterval: "12 month", billingCadence: "annual", priceCents: 1200 }),
      // $10/month short = $10/month, smaller delta and the bigger problem.
      sub({ id: "monthly", tier: "studio", priceCents: 200 }),
    ]);
    expect(r.offGrid[0].id).toBe("monthly");
  });

  /**
   * A cancelled subscription bills nothing, so its mispricing costs nothing
   * and would pad the total with money that was never at stake.
   */
  it("counts only subscriptions that are still billing", () => {
    const r = summarisePricing([sub({ id: "dead", status: "CANCELLED", priceCents: 300 })]);
    expect(r.monthlyUnderchargeCents).toBe(0);
    expect(r.offGrid).toHaveLength(0);
    expect(r.excludedNotActive).toBe(1);
  });

  // Unknown plans and missing prices are listed, never silently priced at zero.
  it("separates the ones it cannot price from the ones it can", () => {
    const r = summarisePricing([
      sub({ id: "unknown", billingInterval: "99 month" }),
      sub({ id: "none", priceCents: null }),
      sub({ id: "zero", priceCents: 0 }),
    ]);
    expect(r.unpriceable.map((u) => u.id).sort()).toEqual(["none", "unknown", "zero"]);
    expect(r.monthlyUnderchargeCents).toBe(0);
  });
});

/**
 * ─── The overcharge headline, and why it needs splitting ──────────────
 *
 * Against production the gross monthly overcharge is $2,770, and four records
 * account for nearly all of it: $19,382, $7,963, $2,425 and $2,207. Those are
 * corrupt rows that `priceAnomaly` already excludes from MRR, not customers
 * paying $19,382 a month.
 *
 * Reporting the gross figure would describe a mass overbilling that is not
 * happening, and it is the kind of number that gets quoted before it gets
 * checked.
 */
describe("summarisePricing: corrupt rows are separable from real overcharges", () => {
  const sub = (over: Partial<PricedSubscription> = {}): PricedSubscription => ({
    id: "1",
    status: "ACTIVE",
    tier: "spark",
    pricingCohort: "grandfathered",
    billingInterval: "1 month",
    billingCadence: "monthly",
    priceCents: 500,
    priceAnomaly: false,
    ...over,
  });

  it("keeps a corrupt row out of the customer-facing overcharge total", () => {
    const r = summarisePricing([
      sub({ id: "corrupt", priceCents: 1_938_200, priceAnomaly: true }),
      sub({ id: "real", priceCents: 700 }),
    ]);
    expect(r.monthlyOverchargeExcludingCorruptCents).toBe(200);
    // The gross figure is still reported, so nothing is hidden.
    expect(r.monthlyOverchargeCents).toBe(1_937_900);
  });

  it("still lists the corrupt row, marked", () => {
    const r = summarisePricing([sub({ id: "corrupt", priceCents: 1_938_200, priceAnomaly: true })]);
    expect(r.offGrid).toHaveLength(1);
    expect(r.offGrid[0].alsoPriceAnomaly).toBe(true);
  });

  /**
   * Undercharges are not split the same way, and should not be: a corrupt row
   * cannot undercharge — `priceAnomaly` fires above 2x expected and at zero or
   * below, so everything it catches is either an overcharge or unpriceable.
   */
  it("marks an ordinary undercharge as not corrupt", () => {
    const r = summarisePricing([sub({ id: "u", priceCents: 300 })]);
    expect(r.offGrid[0].alsoPriceAnomaly).toBe(false);
    expect(r.monthlyUnderchargeCents).toBe(200);
  });
});
