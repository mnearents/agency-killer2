import { describe, it, expect } from "vitest";
import {
  summariseActive,
  computeLtv,
  computeChanges,
  type SubscriptionFact,
  type SnapshotFact,
} from "@/domain/subscriptions/analytics";

const NOW = new Date("2026-09-03T12:00:00Z");

function fact(over: Partial<SubscriptionFact> = {}): SubscriptionFact {
  return {
    id: "1",
    status: "ACTIVE",
    tier: "spark",
    pricingCohort: "grandfathered",
    billingInterval: "1 month",
    billingCadence: "monthly",
    priceCents: 500,
    priceAnomaly: false,
    inDunning: false,
    manualOrigin: false,
    orderPlaced: new Date("2026-06-01T00:00:00Z"),
    cancelledOn: null,
    ...over,
  };
}

// ─── subscription_summary ──────────────────────────────────────────────

describe("summariseActive", () => {
  it("counts only active subscriptions", () => {
    const s = summariseActive([
      fact({ id: "1" }),
      fact({ id: "2", status: "CANCELLED", cancelledOn: new Date("2026-08-01T00:00:00Z") }),
    ]);
    expect(s.activeTotal).toBe(1);
  });

  it("breaks active down by tier, cohort and raw billing interval", () => {
    const s = summariseActive([
      fact({ id: "1", tier: "spark", pricingCohort: "grandfathered", billingInterval: "1 month" }),
      fact({ id: "2", tier: "studio", pricingCohort: "current", billingInterval: "12 month", billingCadence: "annual", priceCents: 14400 }),
      fact({ id: "3", tier: "studio", pricingCohort: "grandfathered", billingInterval: "13 month", billingCadence: "annual", priceCents: 12000 }),
    ]);
    expect(s.byTier).toEqual({ spark: 1, studio: 2 });
    expect(s.byPricingCohort).toEqual({ grandfathered: 2, current: 1 });
    expect(s.byBillingInterval).toEqual({ "1 month": 1, "12 month": 1, "13 month": 1 });
  });

  // The whole point of the rewrite: a $120 annual plan is $10/mo of MRR, not a
  // $120 spike in the month it renews.
  it("amortises annual plans into MRR instead of booking the full charge", () => {
    const s = summariseActive([
      fact({ id: "1", billingCadence: "annual", billingInterval: "12 month", priceCents: 12000 }),
    ]);
    expect(s.mrr.annualAmortisedCents).toBe(1000);
    expect(s.mrr.monthlyBilledCents).toBe(0);
    expect(s.mrr.totalCents).toBe(1000);
  });

  it("reports monthly-billed and annual-amortised MRR separately and combined", () => {
    const s = summariseActive([
      fact({ id: "1", priceCents: 500 }),
      fact({ id: "2", billingCadence: "annual", billingInterval: "12 month", priceCents: 12000 }),
    ]);
    expect(s.mrr.monthlyBilledCents).toBe(500);
    expect(s.mrr.annualAmortisedCents).toBe(1000);
    expect(s.mrr.totalCents).toBe(1500);
  });

  it("derives ARR as twelve times combined MRR", () => {
    const s = summariseActive([fact({ id: "1", priceCents: 500 })]);
    expect(s.arrCents).toBe(6000);
  });

  // A 13-month interval is an annual plan; it must not fall out of MRR.
  it("amortises a 13-month interval as annual", () => {
    const s = summariseActive([
      fact({ id: "1", billingCadence: "annual", billingInterval: "13 month", priceCents: 12000 }),
    ]);
    expect(s.mrr.annualAmortisedCents).toBe(1000);
    expect(s.activeTotal).toBe(1);
  });

  it("counts subscriptions in dunning", () => {
    const s = summariseActive([fact({ id: "1", inDunning: true }), fact({ id: "2" })]);
    expect(s.dunning).toBe(1);
  });

  // Quarantining bad prices silently would make MRR unexplainable.
  it("excludes price anomalies from MRR and reports them separately", () => {
    const s = summariseActive([
      fact({ id: "1", priceCents: 500 }),
      fact({ id: "2", priceCents: 1938200, priceAnomaly: true }),
    ]);
    expect(s.mrr.totalCents).toBe(500);
    expect(s.activeTotal).toBe(2);
    expect(s.excluded.priceAnomalies).toBe(1);
    expect(s.excluded.anomalousTotalCents).toBe(1938200);
  });

  it("excludes rows with no price and counts them", () => {
    const s = summariseActive([fact({ id: "1", priceCents: null })]);
    expect(s.mrr.totalCents).toBe(0);
    expect(s.excluded.missingPrice).toBe(1);
  });
});

// ─── subscription_ltv ──────────────────────────────────────────────────

describe("computeLtv", () => {
  const churned = (over: Partial<SubscriptionFact> = {}) =>
    fact({
      status: "CANCELLED",
      orderPlaced: new Date("2026-01-01T00:00:00Z"),
      cancelledOn: new Date("2026-07-01T00:00:00Z"), // 6 months
      ...over,
    });

  // The censoring bug. Active subscribers have not finished their runs, so
  // averaging them in drags measured tenure down.
  it("never blends churned and active tenure", () => {
    const r = computeLtv(
      [
        churned({ id: "1" }),
        fact({ id: "2", orderPlaced: new Date("2026-08-01T00:00:00Z") }), // ~1 month so far
      ],
      NOW
    );
    expect(r.churned.observed.subscribers).toBe(1);
    expect(r.active.observed.subscribers).toBe(1);
    // Calendar months average 30.44 days, so six months reads as 5.95.
    expect(r.churned.observed.avgTenureMonths).toBeCloseTo(5.95, 1);
    // If the two were blended the answer would be ~3.5.
    expect(r.active.observed.avgTenureMonths).toBeCloseTo(1.1, 1);
  });

  it("marks the churned cohort complete and the active cohort incomplete", () => {
    const r = computeLtv([churned({ id: "1" }), fact({ id: "2" })], NOW);
    expect(r.churned.complete).toBe(true);
    expect(r.active.complete).toBe(false);
  });

  it("measures churned tenure from order placed to cancellation, not to now", () => {
    const r = computeLtv([churned({ id: "1" })], NOW);
    // Six calendar months; measuring to NOW instead would give ~8.
    expect(r.churned.observed.avgTenureMonths).toBeCloseTo(5.95, 1);
  });

  it("measures active tenure to date", () => {
    const r = computeLtv([fact({ id: "1", orderPlaced: new Date("2026-06-03T12:00:00Z") })], NOW);
    expect(r.active.observed.avgTenureMonths).toBeCloseTo(3, 1);
  });

  it("breaks each cohort down by tier, pricing cohort and billing interval", () => {
    const r = computeLtv(
      [
        churned({ id: "1", tier: "spark", pricingCohort: "grandfathered" }),
        churned({ id: "2", tier: "studio", pricingCohort: "current", billingCadence: "annual", billingInterval: "12 month", priceCents: 14400 }),
      ],
      NOW
    );
    expect(r.churned.observed.byGroup).toHaveLength(2);
    const studio = r.churned.observed.byGroup.find((g) => g.tier === "studio")!;
    expect(studio.pricingCohort).toBe("current");
    expect(studio.billingCadence).toBe("annual");
    expect(studio.subscribers).toBe(1);
  });

  // order_placed is the migration timestamp for the bulk-imported records, so
  // their tenure is a floor, not a measurement. Mixing the two would restate
  // years of Color Happy history as three months.
  it("separates migrated subscribers, whose start date is unknown, from observed ones", () => {
    const r = computeLtv(
      [
        churned({ id: "1", manualOrigin: false }),
        churned({ id: "2", manualOrigin: true }),
      ],
      NOW
    );
    expect(r.churned.observed.subscribers).toBe(1);
    expect(r.churned.migrated.subscribers).toBe(1);
    expect(r.churned.migrated.tenureIsFloor).toBe(true);
    expect(r.churned.observed.tenureIsFloor).toBe(false);
  });

  it("estimates realised LTV for a churned monthly subscriber from elapsed billing periods", () => {
    // 6 months at $5.
    const r = computeLtv([churned({ id: "1", priceCents: 500 })], NOW);
    expect(r.churned.observed.avgLtvCents).toBe(3000);
  });

  it("charges an annual subscriber once per elapsed year, not once per month", () => {
    const r = computeLtv(
      [
        churned({
          id: "1",
          billingCadence: "annual",
          billingInterval: "12 month",
          priceCents: 12000,
          orderPlaced: new Date("2025-01-01T00:00:00Z"),
          cancelledOn: new Date("2026-07-01T00:00:00Z"), // 18 months -> 2 charges
        }),
      ],
      NOW
    );
    expect(r.churned.observed.avgLtvCents).toBe(24000);
  });

  it("reports a median alongside the mean", () => {
    const r = computeLtv(
      [
        churned({ id: "1", cancelledOn: new Date("2026-02-01T00:00:00Z") }), // 1
        churned({ id: "2", cancelledOn: new Date("2026-03-01T00:00:00Z") }), // 2
        churned({ id: "3", cancelledOn: new Date("2027-01-01T00:00:00Z") }), // 12
      ],
      NOW
    );
    // Middle value of {1.02, 1.94, 11.99} — a mean would read 4.98.
    expect(r.churned.observed.medianTenureMonths).toBeCloseTo(1.94, 1);
  });

  it("excludes price anomalies from LTV and counts them", () => {
    const r = computeLtv([churned({ id: "1", priceCents: 1938200, priceAnomaly: true })], NOW);
    expect(r.excluded.priceAnomalies).toBe(1);
    expect(r.churned.observed.subscribers).toBe(0);
  });

  it("returns nulls rather than NaN for an empty cohort", () => {
    const r = computeLtv([], NOW);
    expect(r.churned.observed.avgTenureMonths).toBeNull();
    expect(r.churned.observed.avgLtvCents).toBeNull();
    expect(r.active.observed.subscribers).toBe(0);
  });

  // A cancellation recorded before the start date is corrupt, not a negative
  // tenure to average in.
  it("drops rows whose cancellation precedes their start rather than averaging a negative", () => {
    const r = computeLtv(
      [churned({ id: "1", orderPlaced: new Date("2026-07-01T00:00:00Z"), cancelledOn: new Date("2026-01-01T00:00:00Z") })],
      NOW
    );
    expect(r.churned.observed.subscribers).toBe(0);
    expect(r.excluded.invalidDates).toBe(1);
  });
});

// ─── subscription_changes ──────────────────────────────────────────────

describe("computeChanges", () => {
  const start = new Date("2026-08-01T00:00:00Z");
  const end = new Date("2026-08-31T23:59:59Z");

  function snap(over: Partial<SnapshotFact> = {}): SnapshotFact {
    return {
      snapshotDate: "2026-08-01",
      subscriptionId: "1",
      tier: "spark",
      pricingCohort: "grandfathered",
      status: "ACTIVE",
      ...over,
    };
  }

  it("counts new subscriptions from order placed inside the range", () => {
    const r = computeChanges({
      facts: [
        fact({ id: "1", orderPlaced: new Date("2026-08-10T00:00:00Z") }),
        fact({ id: "2", orderPlaced: new Date("2026-07-10T00:00:00Z") }),
      ],
      tierChanges: [],
      snapshots: [],
      start,
      end,
    });
    expect(r.newSubscriptions.total).toBe(1);
  });

  // 4,017 of 4,390 records share two bulk-import timestamps. Counting those as
  // signups would report the migration as the best sales week in history.
  it("excludes bulk-migrated records from new subscriptions and says how many", () => {
    const r = computeChanges({
      facts: [
        fact({ id: "1", orderPlaced: new Date("2026-08-10T00:00:00Z"), manualOrigin: false }),
        fact({ id: "2", orderPlaced: new Date("2026-08-10T00:00:00Z"), manualOrigin: true }),
      ],
      tierChanges: [],
      snapshots: [],
      start,
      end,
    });
    expect(r.newSubscriptions.total).toBe(1);
    expect(r.newSubscriptions.excludedMigrated).toBe(1);
  });

  it("counts cancellations from cancelled_on inside the range", () => {
    const r = computeChanges({
      facts: [
        fact({ id: "1", status: "CANCELLED", cancelledOn: new Date("2026-08-15T00:00:00Z") }),
        fact({ id: "2", status: "CANCELLED", cancelledOn: new Date("2026-09-15T00:00:00Z") }),
      ],
      tierChanges: [],
      snapshots: [],
      start,
      end,
    });
    expect(r.cancellations.total).toBe(1);
  });

  it("nets new against cancelled", () => {
    const r = computeChanges({
      facts: [
        fact({ id: "1", orderPlaced: new Date("2026-08-10T00:00:00Z") }),
        fact({ id: "2", orderPlaced: new Date("2026-08-11T00:00:00Z") }),
        fact({ id: "3", status: "CANCELLED", cancelledOn: new Date("2026-08-15T00:00:00Z") }),
      ],
      tierChanges: [],
      snapshots: [],
      start,
      end,
    });
    expect(r.netChange).toBe(1);
  });

  it("names the source column behind each number", () => {
    const r = computeChanges({ facts: [], snapshots: [], tierChanges: [], start, end });
    expect(r.newSubscriptions.source).toMatch(/order_placed/);
    expect(r.cancellations.source).toMatch(/cancelled_on/);
  });

  // Transitions now come from Seal's log, not the snapshots, so a window the
  // snapshots barely touch is still answerable. The detailed rules live in
  // tests/domain/subscriptions/transitions.test.ts; this pins the wiring.
  it("answers transitions from the log even when snapshots cannot cover the range", () => {
    const r = computeChanges({
      facts: [],
      snapshots: [snap({ snapshotDate: "2026-09-03" })],
      tierChanges: [
        {
          subscriptionId: "1",
          at: "2026-08-15T12:00:00.000Z",
          from: "spark",
          to: "studio",
          pricingCohort: "grandfathered",
        },
      ],
      start,
      end,
    });
    expect(r.tierTransitions.available).toBe(true);
    if (r.tierTransitions.available) {
      expect(r.tierTransitions.upgraded).toBe(1);
      expect(r.tierTransitions.grandfatheredSparkToStudio).toBe(1);
      expect(r.tierTransitions.source).toMatch(/log/i);
    }
  });

  // A window entirely before Seal began logging must still refuse, or a
  // fabricated zero replaces an honest "cannot tell".
  it("still refuses a window that predates the log entirely", () => {
    const r = computeChanges({
      facts: [],
      snapshots: [],
      tierChanges: [],
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2026-03-31T00:00:00.000Z"),
    });
    expect(r.tierTransitions.available).toBe(false);
    expect(r.tierTransitions).not.toHaveProperty("upgraded");
  });

  it("builds a weekly series when asked", () => {
    const r = computeChanges({
      facts: [
        fact({ id: "1", orderPlaced: new Date("2026-08-04T00:00:00Z") }),
        fact({ id: "2", orderPlaced: new Date("2026-08-12T00:00:00Z") }),
        fact({ id: "3", status: "CANCELLED", cancelledOn: new Date("2026-08-12T00:00:00Z") }),
      ],
      tierChanges: [],
      snapshots: [],
      start,
      end,
      granularity: "week",
    });
    expect(r.series).not.toBeNull();
    const withActivity = r.series!.filter((p) => p.new > 0 || p.cancelled > 0);
    expect(withActivity).toHaveLength(2);
    expect(withActivity[0].new).toBe(1);
    expect(withActivity[1].new).toBe(1);
    expect(withActivity[1].cancelled).toBe(1);
  });

  it("returns no series unless a granularity is asked for", () => {
    const r = computeChanges({ facts: [], snapshots: [], tierChanges: [], start, end });
    expect(r.series).toBeNull();
  });
});
