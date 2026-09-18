import { describe, it, expect } from "vitest";
import { computeAmer } from "@/domain/economics/amer";
import type { OrderForEconomics, RateSettings } from "@/domain/economics/unit-economics";

const RATES: RateSettings = { paymentPctRate: 0.027, paymentFixedCents: 30 };

/** An order with no product cost recorded, which is the uncosted case. */
const uncosted = (cents: number): OrderForEconomics => ({
  totalPriceCents: cents,
  totalTaxCents: 0,
  productCostCents: 0,
  lineRevenueCents: cents,
  costedLineRevenueCents: 0,
});

/** An order whose landed cost is known, so the COD over it is complete. */
const costed = (cents: number, costCents: number): OrderForEconomics => ({
  totalPriceCents: cents,
  totalTaxCents: 0,
  productCostCents: costCents,
  lineRevenueCents: cents,
  costedLineRevenueCents: cents,
});

/**
 * ─── aMER (#34) ───────────────────────────────────────────────────────
 *
 *   aMER            = New Order Revenue / Total Ad Spend
 *   Break-even aMER = 1 / (1 - COD%)
 *
 * The comparison is the whole point: aMER on its own is a ratio with no scale.
 * Against production, the paid era ran between 0.51 and 5.33 with a typical
 * month near 2.0, and whether that is good depends entirely on a cost of
 * delivery that differs by a factor of six across the business's three lines.
 *
 * So break-even is computed over the NEW-CUSTOMER revenue mix specifically —
 * not blended across all orders, and not taken from one line. Those customers
 * are what the spend bought, and their cost of delivery is the one that
 * decides whether the spend paid for itself.
 */
describe("computeAmer: the ratio", () => {
  it("divides new-customer revenue by ad spend", () => {
    const r = computeAmer({
      spendCents: 100_000,
      rates: RATES,
      byLine: [{ line: "physical", orders: [costed(150_000, 50_000)] }],
    });
    expect(r.amer).toBeCloseTo(1.5, 3);
  });

  it("counts revenue across every line in the numerator", () => {
    const r = computeAmer({
      spendCents: 100_000,
      rates: RATES,
      byLine: [
        { line: "physical", orders: [costed(60_000, 20_000)] },
        { line: "subscription", orders: [costed(40_000, 0)] },
      ],
    });
    expect(r.newRevenueCents).toBe(100_000);
    expect(r.amer).toBeCloseTo(1, 3);
  });

  /**
   * Zero spend does not make a business infinitely efficient. aMER is
   * undefined there, and an Infinity — or a large number from a near-zero
   * denominator — is the kind of figure that gets quoted.
   *
   * This is not hypothetical: Meta spend has been exactly zero since
   * 2026-03-29, so every default window today hits this branch.
   */
  it("returns null, not Infinity, when nothing was spent", () => {
    const r = computeAmer({
      spendCents: 0,
      rates: RATES,
      byLine: [{ line: "physical", orders: [costed(150_000, 50_000)] }],
    });
    expect(r.amer).toBeNull();
    expect(r.verdict).toBe("undecidable");
    expect(r.reason).toMatch(/no ad spend/i);
  });

  // Spend with nothing to show for it is a real answer, and it is zero.
  it("reports an aMER of zero when spend bought no new customers", () => {
    const r = computeAmer({ spendCents: 100_000, rates: RATES, byLine: [] });
    expect(r.amer).toBe(0);
    expect(r.newOrders).toBe(0);
  });
});

describe("computeAmer: break-even over the mix that was bought", () => {
  /**
   * A fully-costed physical order: $1,500 revenue, $500 landed cost, plus
   * payment fees of $40.80 (2.7% + 30c). COD is $540.80 of $1,500 = 36.05%,
   * and break-even is 1/(1 - 0.3605) = 1.564.
   */
  it("computes break-even from the cost of delivery of the new-customer orders", () => {
    const r = computeAmer({
      spendCents: 100_000,
      rates: RATES,
      byLine: [{ line: "physical", orders: [costed(150_000, 50_000)] }],
    });
    expect(r.codPct).toBeCloseTo(0.3605, 4);
    expect(r.breakEvenAmer).toBeCloseTo(1.564, 3);
  });

  /**
   * The mix matters more than either line. A month that acquired mostly
   * subscribers breaks even at a far lower aMER than one that sold planners,
   * and a break-even taken from the wrong line points the wrong way by a
   * factor of two.
   */
  it("weights break-even by what the spend actually bought", () => {
    const subscriptionHeavy = computeAmer({
      spendCents: 100_000,
      rates: RATES,
      byLine: [
        { line: "subscription", orders: Array.from({ length: 90 }, () => costed(1_000, 0)) },
        { line: "physical", orders: [costed(10_000, 5_000)] },
      ],
    });
    const physicalHeavy = computeAmer({
      spendCents: 100_000,
      rates: RATES,
      byLine: [
        { line: "subscription", orders: [costed(1_000, 0)] },
        { line: "physical", orders: Array.from({ length: 9 }, () => costed(10_000, 5_000)) },
      ],
    });
    expect(subscriptionHeavy.breakEvenAmer!).toBeLessThan(physicalHeavy.breakEvenAmer!);
  });

  it("reports each line's share of the new revenue", () => {
    const r = computeAmer({
      spendCents: 100_000,
      rates: RATES,
      byLine: [
        { line: "physical", orders: [costed(75_000, 25_000)] },
        { line: "subscription", orders: [costed(25_000, 0)] },
      ],
    });
    const physical = r.lines.find((l) => l.line === "physical")!;
    expect(physical.shareOfNewRevenue).toBeCloseTo(0.75, 3);
    expect(physical.newOrders).toBe(1);
  });

  // An empty line is reported with a zero share rather than dropped: absent
  // reads as "no data for this line", which is a different claim.
  it("keeps a line that acquired nobody", () => {
    const r = computeAmer({
      spendCents: 100_000,
      rates: RATES,
      byLine: [
        { line: "physical", orders: [costed(100_000, 30_000)] },
        { line: "digital", orders: [] },
      ],
    });
    const digital = r.lines.find((l) => l.line === "digital")!;
    expect(digital.newOrders).toBe(0);
    expect(digital.shareOfNewRevenue).toBe(0);
  });
});

/**
 * ─── The verdict, and when there isn't one ────────────────────────────
 *
 * Fulfilment cost is not in the database, so every COD is understated, so
 * every break-even aMER is understated too. That makes the two possible
 * comparisons asymmetric, and the asymmetry is the useful part:
 *
 *   aMER BELOW an understated break-even  → below the real one too. SAFE.
 *   aMER ABOVE an understated break-even  → says nothing. The real break-even
 *                                           is higher and may be above it.
 *
 * Reporting "above break-even" on incomplete costs would be the optimistic
 * direction on the one number that authorises spending.
 */
describe("computeAmer: the verdict respects which way the costs are wrong", () => {
  it("calls it below break-even, and means it, when the aMER is under a floor", () => {
    const r = computeAmer({
      spendCents: 200_000,
      rates: RATES,
      byLine: [{ line: "physical", orders: [uncosted(100_000)] }],
    });
    expect(r.amer).toBeCloseTo(0.5, 3);
    expect(r.verdict).toBe("below-break-even");
  });

  it("refuses to call it above break-even while a cost category is missing", () => {
    const r = computeAmer({
      spendCents: 10_000,
      rates: RATES,
      byLine: [{ line: "physical", orders: [uncosted(100_000)] }],
    });
    expect(r.amer).toBeCloseTo(10, 3);
    expect(r.verdict).toBe("undecidable");
    expect(r.reason).toMatch(/break-even is understated|higher/i);
  });

  /**
   * Fulfilment is missing on nearly every call today, which is enough on its
   * own to hold the bound at `floor`. That makes the landed-cost gap easy to
   * lose: it could stop being reported entirely and every result would look
   * the same. It is the larger gap of the two — 76% of new-customer revenue
   * against production — so it is asserted where fulfilment cannot cover for
   * it.
   */
  it("reports uncosted revenue even when fulfilment is known", () => {
    const r = computeAmer({
      spendCents: 10_000,
      rates: RATES,
      byLine: [{ line: "physical", orders: [uncosted(100_000), costed(100_000, 30_000)] }],
      fulfilmentCents: 5_000,
    });
    expect(r.missing.join(" ")).toMatch(/Landed product cost for 50% of new-customer line-item revenue/);
    expect(r.breakEvenBound).toBe("floor");
    expect(r.verdict).toBe("undecidable");
  });

  it("names break-even as a floor while any cost is missing", () => {
    const r = computeAmer({
      spendCents: 10_000,
      rates: RATES,
      byLine: [{ line: "physical", orders: [uncosted(100_000)] }],
    });
    expect(r.breakEvenBound).toBe("floor");
    expect(r.missing.join(" ")).toMatch(/Fulfilment/i);
  });

  /**
   * The complete case has to be reachable, or the guard above is a permanent
   * refusal dressed as a check. Once fulfilment lands this is the branch that
   * answers the question.
   */
  it("calls it above break-even once nothing is missing", () => {
    const r = computeAmer({
      spendCents: 10_000,
      rates: RATES,
      byLine: [{ line: "physical", orders: [costed(100_000, 30_000)] }],
      fulfilmentCents: 5_000,
    });
    expect(r.breakEvenBound).toBe("measured");
    expect(r.verdict).toBe("above-break-even");
    expect(r.missing).toEqual([]);
  });

  it("still calls it below break-even when nothing is missing", () => {
    const r = computeAmer({
      spendCents: 500_000,
      rates: RATES,
      byLine: [{ line: "physical", orders: [costed(100_000, 30_000)] }],
      fulfilmentCents: 5_000,
    });
    expect(r.verdict).toBe("below-break-even");
  });

  // Fulfilment belongs in the cost of delivery, not beside it.
  it("counts a supplied fulfilment cost in the cost of delivery", () => {
    const without = computeAmer({
      spendCents: 10_000,
      rates: RATES,
      byLine: [{ line: "physical", orders: [costed(100_000, 30_000)] }],
    });
    const with_ = computeAmer({
      spendCents: 10_000,
      rates: RATES,
      byLine: [{ line: "physical", orders: [costed(100_000, 30_000)] }],
      fulfilmentCents: 20_000,
    });
    expect(with_.codPct!).toBeGreaterThan(without.codPct!);
    expect(with_.breakEvenAmer!).toBeGreaterThan(without.breakEvenAmer!);
  });

  // At or above 100% COD there is no aMER that breaks even.
  it("returns a null break-even when the cost of delivery reaches revenue", () => {
    const r = computeAmer({
      spendCents: 10_000,
      rates: RATES,
      byLine: [{ line: "physical", orders: [costed(100_000, 100_000)] }],
      fulfilmentCents: 10_000,
    });
    expect(r.breakEvenAmer).toBeNull();
    expect(r.verdict).toBe("undecidable");
  });
});
