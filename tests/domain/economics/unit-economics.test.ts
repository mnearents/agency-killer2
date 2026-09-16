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

const order = (over: Partial<OrderForEconomics> = {}): OrderForEconomics => ({
  totalPriceCents: 4500,
  totalTaxCents: 0,
  productCostCents: 1442,
  costIsKnown: true,
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
  it("reports what fraction of revenue has a known product cost", () => {
    const r = computeUnitEconomics(
      [order({ costIsKnown: true }), order({ costIsKnown: false, productCostCents: 0 })],
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
    const known = computeUnitEconomics([order({ costIsKnown: true })], RATES);
    const unknown = computeUnitEconomics([order({ costIsKnown: false })], RATES);
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
    order({ costIsKnown: false, productCostCents: 0, ...over });

  it("names missing product costs alongside missing fulfilment", () => {
    const r = computeUnitEconomics([uncosted()], RATES);
    expect(r.missing.some((m) => /product cost/i.test(m))).toBe(true);
    expect(r.missing.some((m) => /fulfilment/i.test(m))).toBe(true);
  });

  it("says how much of the revenue is uncosted, not merely that some is", () => {
    const r = computeUnitEconomics([order(), uncosted()], RATES);
    expect(r.missing.find((m) => /product cost/i.test(m))).toMatch(/50/);
  });

  it("does not name it when every order has a recorded cost", () => {
    const r = computeUnitEconomics([order({ costIsKnown: true })], RATES);
    expect(r.missing.some((m) => /product cost/i.test(m))).toBe(false);
  });

  // The landed-cost component itself must not read as measured when it isn't.
  it("marks the product cost component as missing rather than measured", () => {
    const r = computeUnitEconomics([uncosted()], RATES);
    expect(r.components.find((c) => /product cost/i.test(c.label))!.basis).toBe("missing");
  });

  it("still marks it measured when coverage is complete", () => {
    const r = computeUnitEconomics([order({ costIsKnown: true })], RATES);
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
  const partly = (over: Partial<OrderForEconomics> = {}) =>
    order({ productCostCents: 1000, costIsKnown: false, ...over });

  it("counts the product cost it does know", () => {
    const r = computeUnitEconomics([partly()], RATES);
    expect(r.components.find((c) => /product cost/i.test(c.label))!.cents).toBe(1000);
  });

  it("still reports the order as not fully costed", () => {
    expect(computeUnitEconomics([partly()], RATES).cogsCoveragePct).toBe(0);
  });

  it("raises the COD floor rather than understating it", () => {
    const withPartial = computeUnitEconomics([partly()], RATES).codCents;
    const withNone = computeUnitEconomics([partly({ productCostCents: 0 })], RATES).codCents;
    expect(withPartial).toBeGreaterThan(withNone);
  });

  // Coverage still measures confidence, not how much cost was found.
  it("keeps coverage and cost separate", () => {
    const r = computeUnitEconomics([order({ costIsKnown: true }), partly()], RATES);
    expect(r.cogsCoveragePct).toBeCloseTo(0.5, 5);
    expect(r.components.find((c) => /product cost/i.test(c.label))!.cents).toBe(1442 + 1000);
  });
});
