/**
 * Unit economics — cost of delivery, contribution margin, break-even aMER.
 *
 * Replaces Statlas at $500/mo, which is 27% of the 2026 ad budget going to the
 * tool that allocates it. The arithmetic is arithmetic; the reason to do it
 * in-house is that Statlas reports a single blended cost of delivery, and a
 * blend describes a business Rad & Happy does not operate:
 *
 *   RAD subscription    COD ~8-9%    break-even aMER ~1.09
 *   Digital printables  COD ~7-9%    break-even aMER ~1.09
 *   Physical goods      COD 50-65%   break-even aMER 2.0-2.9
 *
 * A single number between those is true of nothing.
 *
 * ## Two things this gets right that a flat percentage cannot
 *
 * **Payment fees are per transaction.** `(amount x pct) + fixed`, never a flat
 * rate. The 30c fixed fee dominates at low price points, and this business
 * bills 49,982 subscription orders averaging $6.56 — so fixed fees ($14,995)
 * exceed percentage fees ($8,855) on a product with otherwise no COGS.
 *
 * **Tax is excluded from revenue but included in fees.** Shopify's total price
 * includes tax; the processor charges on what was captured, while margin is
 * over what we keep. Statlas includes tax in revenue, which inflates it and
 * flatters COD%.
 */

import { describe, it, expect } from "vitest";
import {
  paymentFeeCents,
  computeUnitEconomics,
  breakEvenAmer,
  bandMargins,
  thresholdVerdict,
  type OrderForEconomics,
  type RateSettings,
} from "@/domain/economics/unit-economics";

const RATES: RateSettings = { paymentPctRate: 0.027, paymentFixedCents: 30 };

describe("paymentFeeCents: per transaction, never a flat rate", () => {
  it("charges the percentage plus the fixed fee", () => {
    expect(paymentFeeCents(10000, RATES)).toBe(300); // $100 -> 270 + 30
  });

  /**
   * The table from the spec. The effective rate more than doubles between a
   * $45 planner and a $5 grandfathered Spark, entirely because of the 30c.
   * A flat 2.7% would understate the subscription cost by two thirds.
   */
  it.each([
    [500, 8.7],
    [800, 6.5],
    [1500, 4.7],
    [4500, 3.4],
    [14400, 2.9],
  ])("gives an effective rate near the documented one for %i cents", (amount, expectedPct) => {
    const effective = (100 * paymentFeeCents(amount, RATES)) / amount;
    expect(effective).toBeCloseTo(expectedPct, 0);
  });

  it("rounds to whole cents rather than carrying fractions", () => {
    expect(Number.isInteger(paymentFeeCents(537, RATES))).toBe(true);
  });

  it("still charges the fixed fee on a zero-value order", () => {
    // A $0 order still costs a transaction. Returning 0 would hide it.
    expect(paymentFeeCents(0, RATES)).toBe(30);
  });
});

describe("breakEvenAmer", () => {
  it("is 1 / (1 - COD%)", () => {
    expect(breakEvenAmer(0.4556)).toBeCloseTo(1.837, 2);
    expect(breakEvenAmer(0.085)).toBeCloseTo(1.093, 2);
  });

  // A COD at or above 100% has no break-even: no amount of revenue covers it.
  it("reports no break-even rather than infinity or a negative", () => {
    expect(breakEvenAmer(1)).toBeNull();
    expect(breakEvenAmer(1.2)).toBeNull();
  });
});

/** A fully-costed $45 order: all of its line revenue has a landed cost. */
const order = (over: Partial<OrderForEconomics> = {}): OrderForEconomics => ({
  totalPriceCents: 4500,
  totalTaxCents: 0,
  productCostCents: 1442,
  lineRevenueCents: 4500,
  costedLineRevenueCents: 4500,
  ...over,
});

describe("computeUnitEconomics", () => {
  it("excludes tax from revenue but charges fees on the full captured amount", () => {
    const r = computeUnitEconomics([order({ totalPriceCents: 11000, totalTaxCents: 1000 })], RATES);
    expect(r.revenueCents).toBe(10000);
    // 11000 captured -> 297 + 30
    expect(r.components.find((c) => c.label === "Payment processing")!.cents).toBe(327);
  });

  /**
   * Rounded per transaction, not over the total. 4500 x 0.027 is 121.5, which
   * is 122 cents charged twice — 244, not the 243 you get by rounding 9000 x
   * 0.027 once. The processor charges per transaction and so does this; over
   * 49,982 subscription orders the two models differ by a couple of hundred
   * dollars.
   */
  it("splits payment fees into percentage and fixed, rounding per transaction", () => {
    const r = computeUnitEconomics([order(), order()], RATES);
    expect(r.paymentFees).toEqual({ percentageCents: 244, fixedCents: 60 });
  });

  it("computes COD, contribution margin and break-even together", () => {
    const r = computeUnitEconomics([order()], RATES);
    // 4500 revenue; 1442 product + (122 + 30) payment = 1594
    expect(r.codCents).toBe(1594);
    expect(r.codPct).toBeCloseTo(0.354, 3);
    expect(r.contributionMarginCents).toBe(4500 - 1594);
    expect(r.breakEvenAmer).toBeCloseTo(1.549, 2);
  });

  /**
   * "Must state which components are measured vs estimated and report
   * cogs_coverage_pct." A COD computed over orders whose product cost is
   * unknown is a guess, and it has to say so rather than quietly treating the
   * unknown as zero.
   */
  it("reports what fraction of line-item revenue has a known product cost", () => {
    const r = computeUnitEconomics(
      [order(), order({ costedLineRevenueCents: 0, productCostCents: 0 })],
      RATES
    );
    expect(r.cogsCoveragePct).toBeCloseTo(0.5, 5);
  });

  it("names fulfilment as missing rather than omitting it", () => {
    const r = computeUnitEconomics([order()], RATES);
    expect(r.missing).toContain("Fulfilment (3PL labels, pick/pack, storage)");
    expect(r.components.find((c) => c.basis === "missing")).toBeTruthy();
  });

  /**
   * The headline number must not read as complete when a whole cost category
   * is absent. A 35% COD that omits fulfilment is not a 35% COD.
   */
  it("marks the result incomplete while any component is missing", () => {
    expect(computeUnitEconomics([order()], RATES).complete).toBe(false);
  });

  it("returns a stated empty result rather than dividing by zero", () => {
    const r = computeUnitEconomics([], RATES);
    expect(r.orders).toBe(0);
    expect(r.codPct).toBeNull();
    expect(r.breakEvenAmer).toBeNull();
    expect(r.note).toMatch(/no orders/i);
  });

  // An unknown cost counted as zero makes the margin look better than it is.
  it("does not treat an unknown product cost as zero in the coverage figure", () => {
    const known = computeUnitEconomics([order()], RATES);
    const unknown = computeUnitEconomics([order({ costedLineRevenueCents: 0 })], RATES);
    expect(known.cogsCoveragePct).toBe(1);
    expect(unknown.cogsCoveragePct).toBe(0);
  });
});

/**
 * A cost of delivery computed over orders with no recorded product cost is
 * payment fees wearing a margin's clothes.
 *
 * Run against production before the inventory sync had populated costs, the
 * physical line reported a COD of 3.31% — against an expected 50-65%. Every
 * flag was correct: `complete: false`, `cogsCoveragePct: 0`. But the headline
 * percentage was the most readable thing in the output, and a number that
 * prominent will be quoted regardless of what sits beside it.
 *
 * So incomplete cost coverage joins `missing`, which is the field a caller
 * already has to consult. One gap, one place to look.
 */
describe("incomplete cost coverage is a named gap, not a footnote", () => {
  const uncosted = (over: Partial<OrderForEconomics> = {}) =>
    order({ costedLineRevenueCents: 0, productCostCents: 0, ...over });

  it("names missing product costs alongside missing fulfilment", () => {
    const r = computeUnitEconomics([uncosted()], RATES);
    expect(r.missing.some((m) => /product cost/i.test(m))).toBe(true);
    expect(r.missing.some((m) => /fulfilment/i.test(m))).toBe(true);
  });

  it("says how much of the line revenue is uncosted, not merely that some is", () => {
    const r = computeUnitEconomics([order(), uncosted()], RATES);
    expect(r.missing.find((m) => /product cost/i.test(m))).toMatch(/50/);
  });

  it("does not name it when every order has a recorded cost", () => {
    const r = computeUnitEconomics([order()], RATES);
    expect(r.missing.some((m) => /product cost/i.test(m))).toBe(false);
  });

  // The landed-cost component itself must not read as measured when it isn't.
  it("marks the product cost component as missing rather than measured", () => {
    const r = computeUnitEconomics([uncosted()], RATES);
    expect(r.components.find((c) => /product cost/i.test(c.label))!.basis).toBe("missing");
  });

  it("still marks it measured when coverage is complete", () => {
    const r = computeUnitEconomics([order()], RATES);
    expect(r.components.find((c) => /product cost/i.test(c.label))!.basis).toBe("measured");
  });
});

/**
 * A partly-costed order contributes the part that is known.
 *
 * The first version added nothing at all unless every line on the order had a
 * cost. Against production that reported 27% coverage on physical goods where
 * ~80% of the revenue was in fact costed — and, worse, threw away the known
 * costs on those orders, so the COD floor was lower than the evidence
 * supported.
 *
 * Conservative in the wrong direction is still wrong. A floor built from less
 * evidence than you have is a worse floor.
 */
describe("partially costed orders", () => {
  /** $10 of line revenue is costed, $10 is not. Half the order is known. */
  const partly = (over: Partial<OrderForEconomics> = {}) =>
    order({
      productCostCents: 1000,
      lineRevenueCents: 2000,
      costedLineRevenueCents: 1000,
      ...over,
    });

  it("counts the product cost it does know", () => {
    const r = computeUnitEconomics([partly()], RATES);
    expect(r.components.find((c) => /product cost/i.test(c.label))!.cents).toBe(1000);
  });

  it("raises the COD floor rather than understating it", () => {
    const withPartial = computeUnitEconomics([partly()], RATES).codCents;
    const withNone = computeUnitEconomics([partly({ productCostCents: 0 })], RATES).codCents;
    expect(withPartial).toBeGreaterThan(withNone);
  });

  /**
   * ─── Coverage is over line revenue, not over whole orders ───────────
   *
   * This used to be all-or-nothing: one uncosted line made the entire order's
   * revenue uncosted. Measured against production, 89.8% of line-item revenue
   * carries a landed cost while the metric reported 71.6% — the same mistake
   * #83 fixed in the numerator, still living in the coverage figure.
   *
   * It is not cosmetic. Coverage is what holds `complete` at false and every
   * aMER verdict at `undecidable`, so understating it by eighteen points
   * suppresses conclusions the data supports.
   */
  it("counts the costed half of a half-costed order", () => {
    expect(computeUnitEconomics([partly()], RATES).cogsCoveragePct).toBeCloseTo(0.5, 5);
  });

  it("weights coverage by line revenue, not by order count", () => {
    const big = partly({ lineRevenueCents: 90_000, costedLineRevenueCents: 90_000 });
    const small = partly({ lineRevenueCents: 10_000, costedLineRevenueCents: 0 });
    expect(computeUnitEconomics([big, small], RATES).cogsCoveragePct).toBeCloseTo(0.9, 5);
  });

  // A fully costed order is still exactly 1, so `complete` remains reachable.
  it("reports full coverage when every line is costed", () => {
    const r = computeUnitEconomics(
      [order({ lineRevenueCents: 5000, costedLineRevenueCents: 5000 })],
      RATES
    );
    expect(r.cogsCoveragePct).toBe(1);
  });

  it("reports no coverage when no line is costed", () => {
    const r = computeUnitEconomics(
      [order({ lineRevenueCents: 5000, costedLineRevenueCents: 0, productCostCents: 0 })],
      RATES
    );
    expect(r.cogsCoveragePct).toBe(0);
  });

  // Coverage still measures confidence, not how much cost was found.
  it("keeps coverage and cost separate", () => {
    const r = computeUnitEconomics(
      [order({ lineRevenueCents: 2000, costedLineRevenueCents: 2000 }), partly()],
      RATES
    );
    expect(r.cogsCoveragePct).toBeCloseTo(0.75, 5);
    expect(r.components.find((c) => /product cost/i.test(c.label))!.cents).toBe(1442 + 1000);
  });
});

/**
 * ─── Margin by order value ────────────────────────────────────────────
 *
 * #34 asks for this to test one thing: whether free shipping over $60
 * subsidises the worst orders. "If margin at $61-70 is worse than at $50-59,
 * the threshold is subsidising the worst orders and should move to $65 or $70."
 *
 * Run against production, it does not. Margin sits between 63% and 69% across
 * every band above $20, and $60-70 (66.8%) is marginally BETTER than $50-60
 * (66.1%). Absolute contribution rises monotonically with band.
 *
 * The test is not conclusive, and the function says so: fulfilment is the cost
 * the threshold actually absorbs, and it is not in the database. What can be
 * measured is that losing the shipping revenue does not, on its own, make the
 * larger order worse.
 */
describe("bandMargins", () => {
  const o = (totalCents: number, over: Partial<OrderForEconomics> = {}) =>
    order({
      totalPriceCents: totalCents,
      totalTaxCents: 0,
      productCostCents: 0,
      lineRevenueCents: totalCents,
      costedLineRevenueCents: totalCents,
      ...over,
    });

  it("puts each order in the band its value falls in", () => {
    const bands = bandMargins([o(1500), o(2500), o(6500)], RATES);
    const counts = Object.fromEntries(bands.map((b) => [b.label, b.orders]));
    expect(counts["$0-20"]).toBe(1);
    expect(counts["$20-40"]).toBe(1);
    expect(counts["$60-70"]).toBe(1);
  });

  // The boundary is the whole question, so it is pinned rather than assumed.
  it("puts an order at exactly the threshold in the band above", () => {
    const bands = bandMargins([o(6000)], RATES);
    expect(bands.find((b) => b.label === "$60-70")!.orders).toBe(1);
    expect(bands.find((b) => b.label === "$50-60")!.orders).toBe(0);
  });

  it("reports every band, including the empty ones", () => {
    const bands = bandMargins([o(4500)], RATES);
    expect(bands.length).toBeGreaterThan(5);
    // An absent band would read as "no data here" rather than "no orders here".
    expect(bands.every((b) => typeof b.orders === "number")).toBe(true);
  });

  it("computes margin per band, net of product cost and payment fees", () => {
    const [band] = bandMargins([o(10000, { productCostCents: 3000 })], RATES).filter((b) => b.orders > 0);
    // 10000 - 3000 - (270 + 30)
    expect(band.marginCents).toBe(6700);
    expect(band.marginPct).toBeCloseTo(0.67, 2);
  });

  it("reports null margin for an empty band rather than zero", () => {
    const empty = bandMargins([o(4500)], RATES).find((b) => b.orders === 0)!;
    expect(empty.marginPct).toBeNull();
  });

  /**
   * The answer to the threshold question, as a computed verdict rather than a
   * number a reader has to interpret — and explicitly provisional, because the
   * cost it turns on is missing.
   */
  it("compares the bands either side of the threshold", () => {
    const worse = bandMargins(
      [o(5500, { productCostCents: 1000 }), o(6500, { productCostCents: 4000 })],
      RATES
    );
    expect(thresholdVerdict(worse).subsidising).toBe(true);

    const fine = bandMargins(
      [o(5500, { productCostCents: 4000 }), o(6500, { productCostCents: 1000 })],
      RATES
    );
    expect(thresholdVerdict(fine).subsidising).toBe(false);
  });

  it("refuses a verdict when either band has no orders", () => {
    const v = thresholdVerdict(bandMargins([o(500)], RATES));
    expect(v.subsidising).toBeNull();
    expect(v.reason).toMatch(/no orders/i);
  });

  it("says the verdict is provisional while fulfilment is unknown", () => {
    const v = thresholdVerdict(bandMargins([o(5500), o(6500)], RATES));
    expect(v.reason).toMatch(/fulfilment/i);
  });
});
