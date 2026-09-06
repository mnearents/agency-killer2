import { describe, it, expect } from "vitest";
import {
  computeTransitions,
  LOG_COVERAGE_START,
  type TierChangeFact,
  type SnapshotFact,
  type SubscriptionFact,
} from "@/domain/subscriptions/analytics";

const change = (o: Partial<TierChangeFact> = {}): TierChangeFact => ({
  subscriptionId: "s1",
  at: "2026-06-13T22:50:20.000Z",
  from: "spark",
  to: "studio",
  pricingCohort: "grandfathered",
  ...o,
});

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function ok(result: ReturnType<typeof computeTransitions>) {
  if (!result.available) throw new Error(`expected available, got: ${result.reason}`);
  return result;
}

describe("computeTransitions", () => {
  // The whole point of the log backfill: June is now answerable. Before this,
  // any window ending before 2026-09-02 returned available:false.
  it("answers a window that ended before daily snapshots began", () => {
    const r = ok(computeTransitions([change()], [], [], d("2026-06-01"), d("2026-06-30")));
    expect(r.upgraded).toBe(1);
    expect(r.downgraded).toBe(0);
  });

  it("names the log as the source, not the snapshots", () => {
    const r = ok(computeTransitions([change()], [], [], d("2026-06-01"), d("2026-06-30")));
    expect(r.source).toContain("log");
  });

  it("counts a studio-to-spark move as a downgrade", () => {
    const r = ok(
      computeTransitions([change({ from: "studio", to: "spark" })], [], [], d("2026-06-01"), d("2026-06-30"))
    );
    expect(r.upgraded).toBe(0);
    expect(r.downgraded).toBe(1);
  });

  it("counts the grandfathered Spark to Studio path separately", () => {
    const r = ok(
      computeTransitions(
        [change(), change({ subscriptionId: "s2", pricingCohort: "current" })],
        [],
        [],
        d("2026-06-01"),
        d("2026-06-30")
      )
    );
    expect(r.upgraded).toBe(2);
    expect(r.grandfatheredSparkToStudio).toBe(1);
  });

  it("leaves out changes that fall outside the window", () => {
    const r = ok(
      computeTransitions(
        [change({ at: "2026-06-13T22:50:20.000Z" }), change({ subscriptionId: "s2", at: "2026-07-13T22:50:20.000Z" })],
        [],
        [],
        d("2026-06-01"),
        d("2026-06-30")
      )
    );
    expect(r.upgraded).toBe(1);
  });

  it("includes a change that lands on the last day of the window", () => {
    const r = ok(
      computeTransitions([change({ at: "2026-06-30T23:59:59.000Z" })], [], [], d("2026-06-01"), d("2026-06-30"))
    );
    expect(r.upgraded).toBe(1);
  });

  // One subscription was swapped back and forth fourteen times. Counting each
  // event would report fourteen upgrades where the customer ended up exactly
  // where they started.
  it("counts a subscription once, by where it ended up", () => {
    const r = ok(
      computeTransitions(
        [
          change({ at: "2026-06-21T02:17:26.000Z", from: "spark", to: "studio" }),
          change({ at: "2026-06-21T02:26:44.000Z", from: "studio", to: "spark" }),
          change({ at: "2026-06-21T02:34:16.000Z", from: "spark", to: "studio" }),
        ],
        [],
        [],
        d("2026-06-01"),
        d("2026-06-30")
      )
    );
    expect(r.upgraded).toBe(1);
    expect(r.downgraded).toBe(0);
    expect(r.transitions).toBe(3);
    expect(r.churnedSubscriptions).toBe(1);
  });

  it("reports a subscription that ended where it started as neither", () => {
    const r = ok(
      computeTransitions(
        [
          change({ at: "2026-06-21T02:17:26.000Z", from: "spark", to: "studio" }),
          change({ at: "2026-06-21T02:26:44.000Z", from: "studio", to: "spark" }),
        ],
        [],
        [],
        d("2026-06-01"),
        d("2026-06-30")
      )
    );
    expect(r.upgraded).toBe(0);
    expect(r.downgraded).toBe(0);
    expect(r.churnedSubscriptions).toBe(1);
  });

  // A tier we could not identify is not evidence of movement in either
  // direction, and must not be quietly counted as one.
  it("ignores a move into an unrecognised tier", () => {
    const r = ok(
      computeTransitions([change({ to: "unknown" })], [], [], d("2026-06-01"), d("2026-06-30"))
    );
    expect(r.upgraded).toBe(0);
    expect(r.downgraded).toBe(0);
  });

  it("reports the paths taken", () => {
    const r = ok(computeTransitions([change()], [], [], d("2026-06-01"), d("2026-06-30")));
    expect(r.byPath).toEqual([{ from: "spark/grandfathered", to: "studio/grandfathered", subscribers: 1 }]);
  });

  // The 14076883 signature. Seal logs no price entry when the price follows
  // the variant, so "no price entry in the log" is true of every single tier
  // change ever recorded and discriminates nothing. The subscription's current
  // price against the grid for the tier it now sits on is the real test — that
  // is what found 14101980, a live Studio subscriber still billed $12/yr.
  describe("mispriced after a move", () => {
    const fact = (o: Partial<SubscriptionFact> = {}): SubscriptionFact =>
      ({
        id: "s1",
        status: "ACTIVE",
        tier: "studio",
        pricingCohort: "grandfathered",
        billingInterval: "1 month",
        billingCadence: "monthly",
        priceCents: 1200,
        priceAnomaly: false,
        inDunning: false,
        manualOrigin: false,
        orderPlaced: null,
        cancelledOn: null,
        ...o,
      }) as SubscriptionFact;

    it("reports nothing when the price matches the grid for the new tier", () => {
      const r = ok(computeTransitions([change()], [], [fact()],d("2026-06-01"), d("2026-06-30")));
      expect(r.mispricedAfterChange).toEqual([]);
    });

    // Upgraded to Studio, still paying Spark's $5. The log records the tier
    // move and says nothing about price, which is why this check exists.
    it("reports a subscription left on the old tier's price", () => {
      const r = ok(
        computeTransitions([change()], [], [fact({ priceCents: 500 })],d("2026-06-01"), d("2026-06-30"))
      );
      expect(r.mispricedAfterChange).toEqual([
        {
          subscriptionId: "s1",
          tier: "studio",
          pricingCohort: "grandfathered",
          billingInterval: "1 month",
          priceDollars: 5,
          expectedDollars: 12,
        },
      ]);
    });

    // priceAnomaly only fires above 2x expected, so an UNDERCHARGE — the whole
    // shape of this bug — is invisible to it. Depending on that flag here would
    // have missed all three live cases.
    it("reports an undercharge the priceAnomaly flag does not catch", () => {
      const r = ok(
        computeTransitions(
          [change()],
          [],
          [fact({ priceCents: 500, priceAnomaly: false })],
          d("2026-06-01"),
          d("2026-06-30")
        )
      );
      expect(r.mispricedAfterChange).toHaveLength(1);
    });

    it("leaves out a subscription that did not move in the window", () => {
      const r = ok(
        computeTransitions(
          [change()],
          [],
          [fact(), fact({ id: "s2", priceCents: 500 })],
          d("2026-06-01"),
          d("2026-06-30")
        )
      );
      expect(r.mispricedAfterChange).toEqual([]);
    });

    // A plan with no grid entry has no expected price, so there is nothing to
    // compare against. Calling that mispriced would be a fabricated finding.
    it("says nothing about a plan the grid does not cover", () => {
      const r = ok(
        computeTransitions(
          [change()],
          [],
          [fact({ billingInterval: "3 month", priceCents: 500 })],
          d("2026-06-01"),
          d("2026-06-30")
        )
      );
      expect(r.mispricedAfterChange).toEqual([]);
    });

    it("says nothing about a subscription whose price is unknown", () => {
      const r = ok(
        computeTransitions([change()], [], [fact({ priceCents: null })],d("2026-06-01"), d("2026-06-30"))
      );
      expect(r.mispricedAfterChange).toEqual([]);
    });

    // A cancelled subscriber is not being billed, so a stale price on one is
    // not a live billing bug and would only bury the ones that are.
    it("leaves out a cancelled subscription", () => {
      const r = ok(
        computeTransitions(
          [change()],
          [],
          [fact({ status: "CANCELLED", priceCents: 500 })],
          d("2026-06-01"),
          d("2026-06-30")
        )
      );
      expect(r.mispricedAfterChange).toEqual([]);
    });
  });

  describe("coverage honesty", () => {
    // Seal's log starts 2026-05-22. A window reaching further back is
    // answerable, but the answer is a floor, and saying so is the difference
    // between "nobody upgraded in April" and "we cannot see April".
    it("flags a window that reaches back before the log begins", () => {
      const r = ok(computeTransitions([change()], [], [], d("2026-01-01"), d("2026-06-30")));
      expect(r.coversRequestedRange).toBe(false);
      expect(r.caveat).toContain(LOG_COVERAGE_START);
    });

    it("does not flag a window that sits inside the log's coverage", () => {
      const r = ok(computeTransitions([change()], [], [], d("2026-06-01"), d("2026-06-30")));
      expect(r.coversRequestedRange).toBe(true);
      expect(r.caveat).toBeNull();
    });

    // Returning zero for a window we cannot see at all would be a fabricated
    // number, which is the exact failure the old available:false guarded.
    it("refuses a window that ends before the log begins", () => {
      const r = computeTransitions([], [], [], d("2026-01-01"), d("2026-03-31"));
      expect(r.available).toBe(false);
      if (!r.available) expect(r.reason).toContain(LOG_COVERAGE_START);
    });

    it("reports zero rather than refusing when the window is covered and nothing moved", () => {
      const r = ok(computeTransitions([], [], [], d("2026-06-01"), d("2026-06-30")));
      expect(r.upgraded).toBe(0);
      expect(r.downgraded).toBe(0);
    });
  });

  describe("snapshot corroboration", () => {
    const snap = (date: string, id: string, tier: string): SnapshotFact => ({
      snapshotDate: date,
      subscriptionId: id,
      tier,
      pricingCohort: "grandfathered",
      status: "ACTIVE",
    });

    it("reports agreement when the snapshots see the same move", () => {
      const r = ok(
        computeTransitions(
          [change({ subscriptionId: "s1", at: "2026-09-03T01:24:28.000Z" })],
          [snap("2026-09-02", "s1", "spark"), snap("2026-09-05", "s1", "studio")],
          [],
          d("2026-09-02"),
          d("2026-09-05")
        )
      );
      expect(r.snapshotCheck).toEqual({ compared: true, from: "2026-09-02", to: "2026-09-05", upgraded: 1, downgraded: 0 });
    });

    // Snapshots are a daily photograph; the log is the event. A change made
    // after the day's snapshot was written is invisible to the photograph, so
    // disagreement is expected and must not be reported as an error.
    it("still answers from the log when the snapshots disagree", () => {
      const r = ok(
        computeTransitions(
          [change({ subscriptionId: "s1", at: "2026-09-02T23:07:18.000Z" })],
          [snap("2026-09-02", "s1", "studio"), snap("2026-09-05", "s1", "studio")],
          [],
          d("2026-09-02"),
          d("2026-09-05")
        )
      );
      expect(r.upgraded).toBe(1);
      expect(r.snapshotCheck).toEqual({
        compared: true,
        from: "2026-09-02",
        to: "2026-09-05",
        upgraded: 0,
        downgraded: 0,
      });
    });

    it("says the snapshots could not be compared when the window has fewer than two", () => {
      const r = ok(computeTransitions([change()], [], [], d("2026-06-01"), d("2026-06-30")));
      expect(r.snapshotCheck).toEqual({ compared: false });
    });
  });
});
