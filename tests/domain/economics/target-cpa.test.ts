import { describe, it, expect } from "vitest";
import {
  computeTargetCpa,
  realisedChurnedLtv,
  type RealisedLtv,
} from "@/domain/economics/target-cpa";
import type { UnitEconomicsResult } from "@/domain/economics/unit-economics";
import type { SubscriptionFact } from "@/domain/subscriptions/analytics";

/**
 * A unit economics result with the fields target CPA reads, and nothing else
 * pinned. Built complete by default so a test that cares about incompleteness
 * has to say so.
 */
function economics(over: Partial<UnitEconomicsResult> = {}): UnitEconomicsResult {
  return {
    orders: 100,
    revenueCents: 450_000,
    aovCents: 4_500,
    components: [],
    paymentFees: { percentageCents: 0, fixedCents: 0 },
    codCents: 225_000,
    codPct: 0.5,
    contributionMarginCents: 225_000,
    breakEvenAmer: 2,
    cogsCoveragePct: 1,
    missing: [],
    complete: true,
    ...over,
  };
}

const ltv = (over: Partial<RealisedLtv> = {}): RealisedLtv => ({
  cohort: "churned-observed",
  subscribers: 87,
  avgLtvCents: 2_398,
  avgTenureMonths: 1.5,
  observationWindowMonths: 3.9,
  unfinishedRuns: 0,
  isFloor: false,
  ...over,
});

/**
 * ─── Target CPA (#34) ─────────────────────────────────────────────────
 *
 * "target CPA at break-even and at 3:1 LTV:CAC."
 *
 * Break-even CPA is the contribution margin one acquisition produces: spend
 * exactly that and the customer pays for themselves and nothing else. The 3:1
 * figure is that divided by three.
 *
 * The numerator is contribution, not revenue, and the result says so — a 3:1
 * ratio computed over revenue is a different and much larger number, and the
 * difference is the entire cost of delivery.
 */
describe("computeTargetCpa: the arithmetic", () => {
  it("sets break-even CPA to the contribution one customer produces", () => {
    const r = computeTargetCpa({ businessLine: "physical", economics: economics() });
    const first = r.bases.find((b) => b.basis === "first-order")!;
    // $45 AOV at 50% COD leaves $22.50 of contribution.
    expect(first.breakEvenCpaCents).toBe(2_250);
  });

  it("sets the 3:1 target to a third of the break-even figure", () => {
    const r = computeTargetCpa({ businessLine: "physical", economics: economics() });
    const first = r.bases.find((b) => b.basis === "first-order")!;
    expect(first.targetCpa3to1Cents).toBe(750);
  });

  it("names contribution, not revenue, as what the ratio is taken over", () => {
    const r = computeTargetCpa({ businessLine: "physical", economics: economics() });
    expect(r.ratioBasis).toBe("contribution");
  });

  /**
   * At or above 100% cost of delivery there is no CPA that breaks even, and a
   * negative one is a number someone could read as "you may spend". Null is
   * the only honest answer, and it is the same rule `breakEvenAmer` follows.
   */
  it("returns null rather than a negative CPA when cost of delivery reaches 100%", () => {
    const r = computeTargetCpa({
      businessLine: "physical",
      economics: economics({ codPct: 1.2, codCents: 540_000 }),
    });
    const first = r.bases.find((b) => b.basis === "first-order")!;
    expect(first.breakEvenCpaCents).toBeNull();
    expect(first.targetCpa3to1Cents).toBeNull();
    expect(r.blockers.join(" ")).toMatch(/cost of delivery/i);
  });

  // Zero orders is an unrun window, not a CPA of zero.
  it("computes nothing at all from an empty window", () => {
    const r = computeTargetCpa({
      businessLine: "physical",
      economics: economics({ orders: 0, revenueCents: 0, aovCents: 0, codPct: null }),
    });
    expect(r.bases).toEqual([]);
    expect(r.recommendedBasis).toBeNull();
    expect(r.blockers.join(" ")).toMatch(/no orders/i);
  });
});

/**
 * ─── Which way the number is wrong ────────────────────────────────────
 *
 * Every figure here is built from two inputs that are each incomplete, and
 * they are incomplete in OPPOSITE directions:
 *
 *   - Fulfilment cost is not in the database, so COD is understated, so
 *     contribution is overstated, so the CPA is a CEILING. Spending it loses
 *     money.
 *   - The churned cohort is truncated by a short observation window, so LTV is
 *     understated, so the CPA is a FLOOR. Spending it leaves money unspent.
 *
 * A single "estimated" flag over both would be useless: the caller needs to
 * know which way to lean, and when both apply, that they cannot lean either
 * way. So the bound is named and the reasons are carried with it.
 */
describe("computeTargetCpa: the direction of the error is reported", () => {
  it("calls the CPA a ceiling when a cost category is missing", () => {
    const r = computeTargetCpa({
      businessLine: "physical",
      economics: economics({ complete: false, missing: ["Fulfilment"] }),
    });
    const first = r.bases.find((b) => b.basis === "first-order")!;
    expect(first.bound).toBe("ceiling");
    expect(first.boundReasons.join(" ")).toMatch(/Fulfilment/);
  });

  it("calls the CPA a floor when the LTV cohort is truncated", () => {
    const r = computeTargetCpa({
      businessLine: "subscription",
      economics: economics({ codPct: 0.08, codCents: 36_000 }),
      ltv: ltv({ isFloor: true, unfinishedRuns: 290 }),
    });
    const lifetime = r.bases.find((b) => b.basis === "realised-churned-ltv")!;
    expect(lifetime.bound).toBe("floor");
  });

  /**
   * Both errors at once do not cancel and do not combine. Neither dominates,
   * so the answer is that the direction is unknown — which is a different
   * instruction to the reader than either bound alone.
   */
  it("calls it indeterminate when both errors apply", () => {
    const r = computeTargetCpa({
      businessLine: "subscription",
      economics: economics({ codPct: 0.08, codCents: 36_000, complete: false, missing: ["Fulfilment"] }),
      ltv: ltv({ isFloor: true, unfinishedRuns: 290 }),
    });
    const lifetime = r.bases.find((b) => b.basis === "realised-churned-ltv")!;
    expect(lifetime.bound).toBe("indeterminate");
    expect(lifetime.boundReasons).toHaveLength(2);
  });

  it("calls it measured only when neither applies", () => {
    const r = computeTargetCpa({
      businessLine: "subscription",
      economics: economics({ codPct: 0.08, codCents: 36_000 }),
      ltv: ltv({ isFloor: false, unfinishedRuns: 0 }),
    });
    const lifetime = r.bases.find((b) => b.basis === "realised-churned-ltv")!;
    expect(lifetime.bound).toBe("measured");
    expect(lifetime.boundReasons).toEqual([]);
  });
});

/**
 * ─── The cohort the spec forbids ──────────────────────────────────────
 *
 * #34: "For subscriptions use realised churned-cohort LTV from
 * subscription_ltv, never the active-cohort figure (censored — active
 * subscribers haven't finished their runs)."
 *
 * Against production the active observed cohort reports $53.90 against the
 * churned cohort's $23.98. Reading the wrong one would more than double every
 * acquisition budget in the business, and the number would look reasonable.
 */
describe("realisedChurnedLtv: reads the churned cohort and only the churned cohort", () => {
  const fact = (over: Partial<SubscriptionFact> = {}): SubscriptionFact => ({
    id: Math.random().toString(),
    status: "CANCELLED",
    tier: "spark",
    pricingCohort: "current",
    billingInterval: "1 month",
    billingCadence: "monthly",
    priceCents: 800,
    priceAnomaly: false,
    inDunning: false,
    manualOrigin: false,
    orderPlaced: new Date("2026-01-01"),
    cancelledOn: new Date("2026-02-01"),
    ...over,
  });

  const now = new Date("2026-04-01T00:00:00Z");

  /**
   * The fixtures make the three cohorts produce three different LTVs, so the
   * assertion below fails if the call reaches for the wrong one. A fixture set
   * where they agree would pass against every cohort.
   */
  const facts: SubscriptionFact[] = [
    // Churned, observed: one month elapsed at $8 → two billings → $16.
    fact({ orderPlaced: new Date("2026-01-01"), cancelledOn: new Date("2026-02-01") }),
    // Active, observed: three months to date at $8 → $24. Higher, as it is in life.
    fact({ status: "ACTIVE", cancelledOn: null, orderPlaced: new Date("2026-01-01") }),
    // Churned, migrated: $8 over a longer run → $40.
    fact({ manualOrigin: true, orderPlaced: new Date("2025-10-01"), cancelledOn: new Date("2026-02-01") }),
  ];

  it("returns the churned observed figure, not the active one", () => {
    const r = realisedChurnedLtv(facts, now)!;
    expect(r.subscribers).toBe(1);
    expect(r.avgLtvCents).toBe(1_600);
  });

  it("labels what it read, so the cohort survives into the output", () => {
    expect(realisedChurnedLtv(facts, now)!.cohort).toBe("churned-observed");
  });

  /**
   * A migrated record's `order_placed` is the June 2026 import timestamp, so
   * its tenure is a floor and its LTV a different kind of estimate. Mixing it
   * in would raise the figure using a number that is not a measurement.
   */
  it("excludes migrated records from the figure", () => {
    const r = realisedChurnedLtv(facts, now)!;
    expect(r.avgLtvCents).toBe(1_600);
    expect(r.subscribers).toBe(1);
  });

  /**
   * Nobody churned yet is not an LTV of zero — it is an LTV nobody can
   * compute. A zero here would set every target CPA in the business to zero
   * and look like an answer.
   */
  it("returns null when no run has finished", () => {
    const activeOnly = [fact({ status: "ACTIVE", cancelledOn: null })];
    expect(realisedChurnedLtv(activeOnly, now)).toBeNull();
  });
});

/**
 * ─── Truncation, which the spec does not anticipate ───────────────────
 *
 * The spec treats the churned cohort as the honest one because those runs are
 * finished. They are — but the window they finished in is 3.9 months long,
 * and no finished run in it can be longer than that. Meanwhile 290 observed
 * subscribers are still running, several already past the longest churned
 * tenure on record.
 *
 * So the churned figure is a floor, and the reason is not that the data is bad
 * — it is that the business has not existed on this platform long enough for
 * the question to have an answer yet. That has to reach the caller.
 */
describe("realisedChurnedLtv: the observation window", () => {
  const fact = (over: Partial<SubscriptionFact>): SubscriptionFact => ({
    id: Math.random().toString(),
    status: "CANCELLED",
    tier: "spark",
    pricingCohort: "current",
    billingInterval: "1 month",
    billingCadence: "monthly",
    priceCents: 800,
    priceAnomaly: false,
    inDunning: false,
    manualOrigin: false,
    orderPlaced: new Date("2026-01-01"),
    cancelledOn: new Date("2026-02-01"),
    ...over,
  });

  const now = new Date("2026-04-01T00:00:00Z");

  it("reports the window as the longest tenure it could possibly have seen", () => {
    const r = realisedChurnedLtv([fact({})], now)!;
    // 2026-01-01 to 2026-04-01 is 90 days, a shade under three months.
    expect(r.observationWindowMonths).toBeCloseTo(2.96, 1);
  });

  it("measures the window from the earliest signup, not the earliest churn", () => {
    const r = realisedChurnedLtv(
      [
        fact({ orderPlaced: new Date("2025-07-01"), cancelledOn: new Date("2026-01-01") }),
        fact({ orderPlaced: new Date("2026-03-01"), cancelledOn: new Date("2026-03-20") }),
      ],
      now
    )!;
    expect(r.observationWindowMonths).toBeCloseTo(9, 0);
  });

  it("counts the unfinished runs that make the figure a floor", () => {
    const r = realisedChurnedLtv(
      [fact({}), fact({ status: "ACTIVE", cancelledOn: null })],
      now
    )!;
    expect(r.unfinishedRuns).toBe(1);
    expect(r.isFloor).toBe(true);
  });

  /**
   * In a world where every subscriber has finished, the figure is not a floor
   * and must not be labelled one — otherwise the flag is decorative and reads
   * as noise on the day it matters.
   */
  it("is not a floor once every run has finished", () => {
    const r = realisedChurnedLtv([fact({}), fact({})], now)!;
    expect(r.unfinishedRuns).toBe(0);
    expect(r.isFloor).toBe(false);
  });

  // Migrated records are excluded from the figure, but they are still
  // unfinished runs against the same window.
  it("counts unfinished migrated runs too", () => {
    const r = realisedChurnedLtv(
      [fact({}), fact({ status: "ACTIVE", cancelledOn: null, manualOrigin: true })],
      now
    )!;
    expect(r.unfinishedRuns).toBe(1);
  });
});

/**
 * ─── Which basis the caller should use ────────────────────────────────
 *
 * A subscription's first order is $5-8. Its lifetime is worth several times
 * that. Setting acquisition budget from the first order would hold subscriber
 * CPA under about $5 and stop paid acquisition dead — which is roughly what
 * has happened: new subscribers have fallen from ~300/month to ~20 (#79).
 *
 * So the subscription line recommends the lifetime basis where one exists, and
 * says why when it does not.
 */
describe("computeTargetCpa: basis selection", () => {
  it("recommends lifetime value for subscriptions when a churned cohort exists", () => {
    const r = computeTargetCpa({
      businessLine: "subscription",
      economics: economics({ codPct: 0.08, codCents: 36_000 }),
      ltv: ltv(),
    });
    expect(r.recommendedBasis).toBe("realised-churned-ltv");
  });

  it("falls back to the first order for subscriptions with no finished runs, and says so", () => {
    const r = computeTargetCpa({
      businessLine: "subscription",
      economics: economics({ codPct: 0.08, codCents: 36_000 }),
      ltv: null,
    });
    expect(r.recommendedBasis).toBe("first-order");
    expect(r.blockers.join(" ")).toMatch(/no finished subscription/i);
  });

  /**
   * Physical and digital get the first order, and the caveat that repeat
   * purchases are not counted — order history begins 2025-07-22, so a
   * customer lifetime is truncated the same way the subscription one is.
   */
  it("uses the first order for physical goods and flags the repeat purchases it ignores", () => {
    const r = computeTargetCpa({ businessLine: "physical", economics: economics() });
    expect(r.recommendedBasis).toBe("first-order");
    const first = r.bases.find((b) => b.basis === "first-order")!;
    expect(first.caveats.join(" ")).toMatch(/repeat/i);
  });

  // An LTV handed in for a non-subscription line is a caller error, not an
  // input to silently average in — the cohort is subscribers, not buyers.
  it("ignores a subscription LTV passed for a physical line, and says it did", () => {
    const r = computeTargetCpa({ businessLine: "physical", economics: economics(), ltv: ltv() });
    expect(r.bases.map((b) => b.basis)).toEqual(["first-order"]);
    expect(r.blockers.join(" ")).toMatch(/subscription/i);
  });

  it("offers both bases for subscriptions, so the gap between them is visible", () => {
    const r = computeTargetCpa({
      businessLine: "subscription",
      economics: economics({ aovCents: 656, codPct: 0.08, codCents: 36_000 }),
      ltv: ltv(),
    });
    expect(r.bases.map((b) => b.basis).sort()).toEqual(["first-order", "realised-churned-ltv"]);
  });

  it("carries the cohort size onto the lifetime basis", () => {
    const r = computeTargetCpa({
      businessLine: "subscription",
      economics: economics({ codPct: 0.08, codCents: 36_000 }),
      ltv: ltv({ subscribers: 87 }),
    });
    const lifetime = r.bases.find((b) => b.basis === "realised-churned-ltv")!;
    expect(lifetime.cohortSize).toBe(87);
  });
});
