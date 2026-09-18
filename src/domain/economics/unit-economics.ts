/**
 * Unit economics — cost of delivery, contribution margin, break-even aMER.
 *
 * Replaces Statlas at $500/mo, which is 27% of the 2026 ad budget going to the
 * tool that allocates it. The arithmetic is arithmetic; the reason to do it
 * in-house is that Statlas reports one blended cost of delivery, and a blend
 * describes a business Rad & Happy does not operate:
 *
 *   RAD subscription    COD ~8-9%    break-even aMER ~1.09
 *   Digital printables  COD ~7-9%    break-even aMER ~1.09
 *   Physical goods      COD 50-65%   break-even aMER 2.0-2.9
 *
 * A single number between those is true of nothing, which is why callers get
 * one result per business line and never a blend unless they ask.
 *
 * ## Definitions, per #34
 *
 *   Order Revenue       = gross - discounts + shipping collected, TAX EXCLUDED
 *   Cost of Delivery    = landed product cost + fulfilment + payment processing
 *   Contribution Margin = Order Revenue - COD - Ad Spend
 *   Break-even aMER     = 1 / (1 - COD%)
 *
 * ## Two things a flat percentage cannot express
 *
 * **Payment fees are per transaction.** `(amount x pct) + fixed`. The 30c fee
 * dominates at low price points, and this business bills 49,982 subscription
 * orders averaging $6.56 — so fixed fees ($14,995) exceed percentage fees
 * ($8,855) on a product with otherwise no COGS. A flat 2.7% understates the
 * subscription cost by roughly two thirds.
 *
 * **Tax leaves revenue but stays in fees.** Shopify's total price includes tax;
 * the processor charges on what was captured, while margin is over what we
 * keep. Statlas includes tax in revenue, which inflates it and flatters COD%.
 *
 * Pure functions only — no database, no clock.
 */

export interface RateSettings {
  /** 0.027 today. Effective-dated in `rate_settings`. */
  paymentPctRate: number;
  /** 30 cents today. The part that dominates at low price points. */
  paymentFixedCents: number;
}

export interface OrderForEconomics {
  /** As captured, tax included — this is what the processor charges on. */
  totalPriceCents: number;
  totalTaxCents: number;
  /**
   * Landed cost of the lines that have one. Counted even when `costIsKnown` is
   * false: a partly-costed order still tells you something, and discarding it
   * lowers the COD floor below what the evidence supports.
   */
  productCostCents: number;
  /**
   * Line-item revenue on this order, before discounts and excluding shipping.
   *
   * The base for cost coverage. Order revenue is the wrong base: it is net of
   * discounts and includes shipping, neither of which any landed cost attaches
   * to, so a percentage over it compares two different things.
   */
  lineRevenueCents: number;
  /**
   * The part of `lineRevenueCents` whose variant has a landed cost recorded.
   *
   * Separate from a cost of 0 because digital products genuinely cost nothing
   * while a planner with nothing entered is a gap, and counting the second as
   * zero makes every margin quietly optimistic.
   *
   * Measured per line rather than per order. One uncosted line used to make an
   * order's whole revenue uncosted, which reported 71.6% coverage against
   * production where 89.8% of line revenue was in fact costed — #83's mistake
   * surviving in the metric after it was fixed in the numerator.
   */
  costedLineRevenueCents: number;
}

export type CostBasis = "measured" | "estimated" | "missing";

export interface CostComponent {
  label: string;
  cents: number;
  basis: CostBasis;
}

export interface UnitEconomicsResult {
  orders: number;
  revenueCents: number;
  aovCents: number;
  components: CostComponent[];
  /** Split out because the fixed half is the non-obvious cost here. */
  paymentFees: { percentageCents: number; fixedCents: number };
  codCents: number;
  /** Null when there are no orders — never 0, which would read as free. */
  codPct: number | null;
  contributionMarginCents: number;
  breakEvenAmer: number | null;
  /** Share of LINE-ITEM revenue whose landed product cost is recorded. */
  cogsCoveragePct: number;
  /** Cost categories not included. Non-empty means the COD is a floor. */
  missing: string[];
  /** False while any component is missing. A COD without fulfilment is not a COD. */
  complete: boolean;
  note?: string;
}

/**
 * `(amount x pct) + fixed`, rounded to whole cents.
 *
 * The fixed fee applies to every transaction including a zero-value one — a $0
 * order still costs a transaction, and returning 0 would hide it.
 */
export function paymentFeeCents(amountCents: number, rates: RateSettings): number {
  return Math.round(amountCents * rates.paymentPctRate) + rates.paymentFixedCents;
}

/**
 * The revenue multiple on ad spend at which contribution margin reaches zero.
 *
 * Null at or above 100% COD: there is no multiple that covers it, and
 * returning Infinity or a negative would be a number someone could act on.
 */
export function breakEvenAmer(codPct: number): number | null {
  if (codPct >= 1) return null;
  return 1 / (1 - codPct);
}

/** Named here so the string in the result and the one in `missing` cannot drift. */
const FULFILMENT_LABEL = "Fulfilment (3PL labels, pick/pack, storage)";

export function computeUnitEconomics(
  orders: OrderForEconomics[],
  rates: RateSettings
): UnitEconomicsResult {
  if (orders.length === 0) {
    return {
      orders: 0,
      revenueCents: 0,
      aovCents: 0,
      components: [],
      paymentFees: { percentageCents: 0, fixedCents: 0 },
      codCents: 0,
      // Null, not 0. A cost of delivery of zero would read as free.
      codPct: null,
      contributionMarginCents: 0,
      breakEvenAmer: null,
      cogsCoveragePct: 0,
      missing: [FULFILMENT_LABEL],
      complete: false,
      note: "No orders in this window, so nothing was computed.",
    };
  }

  let revenueCents = 0;
  let productCostCents = 0;
  let percentageCents = 0;
  let fixedCents = 0;
  let lineRevenueCents = 0;
  let costedLineRevenueCents = 0;

  for (const o of orders) {
    // Tax leaves revenue; the processor still charged on it.
    const exTax = o.totalPriceCents - (o.totalTaxCents ?? 0);
    revenueCents += exTax;

    percentageCents += Math.round(o.totalPriceCents * rates.paymentPctRate);
    fixedCents += rates.paymentFixedCents;

    // The known part counts even when the order is not fully costed. Adding
    // nothing unless every line has a cost throws away real evidence and
    // produces a floor lower than the data supports — conservative in the
    // wrong direction is still wrong. The same applies to the coverage
    // figure, which is why it is summed per line here and not per order.
    productCostCents += o.productCostCents;
    lineRevenueCents += o.lineRevenueCents;
    costedLineRevenueCents += o.costedLineRevenueCents;
  }

  const paymentCents = percentageCents + fixedCents;
  const codCents = productCostCents + paymentCents;

  // Over line revenue, named in the field's docstring. A coverage figure over
  // order revenue divides costed line revenue by a base that includes shipping
  // and is net of discounts.
  const cogsCoveragePct = lineRevenueCents === 0 ? 0 : costedLineRevenueCents / lineRevenueCents;

  const components: CostComponent[] = [
    {
      label: "Landed product cost",
      cents: productCostCents,
      // Not "measured" while any revenue is uncosted. Run against production
      // before costs had synced, the physical line showed a 3.31% COD against
      // an expected 50-65% — payment fees wearing a margin's clothes.
      basis: cogsCoveragePct === 1 ? "measured" : "missing",
    },
    { label: "Payment processing", cents: paymentCents, basis: "measured" },
    // Present with a zero and a basis of `missing`, rather than absent. A
    // component nobody listed is a component nobody notices is unaccounted.
    { label: FULFILMENT_LABEL, cents: 0, basis: "missing" },
  ];

  const missing = components
    .filter((c) => c.basis === "missing")
    .map((c) =>
      c.label === "Landed product cost"
        ? `Landed product cost for ${((1 - cogsCoveragePct) * 100).toFixed(0)}% of line-item revenue`
        : c.label
    );

  return {
    orders: orders.length,
    revenueCents,
    aovCents: Math.round(revenueCents / orders.length),
    components,
    paymentFees: { percentageCents, fixedCents },
    codCents,
    codPct: revenueCents === 0 ? null : codCents / revenueCents,
    contributionMarginCents: revenueCents - codCents,
    breakEvenAmer: revenueCents === 0 ? null : breakEvenAmer(codCents / revenueCents),
    cogsCoveragePct,
    missing,
    complete: missing.length === 0,
  };
}

/**
 * ─── Margin by order value ────────────────────────────────────────────
 *
 * #34 asks for this to answer one question: does free shipping over $60
 * subsidise the worst orders? "If margin at $61-70 is worse than at $50-59,
 * the threshold is subsidising the worst orders and should move to $65 or $70."
 *
 * Bands are open at the bottom and closed at the top, so an order at exactly
 * $60 sits in the $60-70 band — the side of the threshold where shipping
 * becomes free, which is the behaviour being tested.
 */
const BANDS: Array<{ label: string; minCents: number; maxCents: number | null }> = [
  { label: "$0-20", minCents: 0, maxCents: 2000 },
  { label: "$20-40", minCents: 2000, maxCents: 4000 },
  { label: "$40-50", minCents: 4000, maxCents: 5000 },
  { label: "$50-60", minCents: 5000, maxCents: 6000 },
  { label: "$60-70", minCents: 6000, maxCents: 7000 },
  { label: "$70-80", minCents: 7000, maxCents: 8000 },
  { label: "$80-100", minCents: 8000, maxCents: 10000 },
  { label: "$100+", minCents: 10000, maxCents: null },
];

/** The two bands the threshold question turns on. */
const BELOW_THRESHOLD = "$50-60";
const ABOVE_THRESHOLD = "$60-70";

export interface BandMargin {
  label: string;
  orders: number;
  revenueCents: number;
  productCostCents: number;
  paymentCents: number;
  marginCents: number;
  /** Null when the band is empty — never 0, which would read as no margin. */
  marginPct: number | null;
}

export function bandMargins(orders: OrderForEconomics[], rates: RateSettings): BandMargin[] {
  // Every band is returned, including empty ones: an absent band reads as "no
  // data here" when it means "no orders here".
  return BANDS.map((band) => {
    const inBand = orders.filter(
      (o) =>
        o.totalPriceCents >= band.minCents &&
        (band.maxCents === null || o.totalPriceCents < band.maxCents)
    );

    let revenueCents = 0;
    let productCostCents = 0;
    let paymentCents = 0;

    for (const o of inBand) {
      revenueCents += o.totalPriceCents - (o.totalTaxCents ?? 0);
      productCostCents += o.productCostCents;
      paymentCents += paymentFeeCents(o.totalPriceCents, rates);
    }

    const marginCents = revenueCents - productCostCents - paymentCents;

    return {
      label: band.label,
      orders: inBand.length,
      revenueCents,
      productCostCents,
      paymentCents,
      marginCents,
      marginPct: revenueCents === 0 ? null : marginCents / revenueCents,
    };
  });
}

export interface ThresholdVerdict {
  /** Null when it cannot be decided, never false — those are different. */
  subsidising: boolean | null;
  belowPct: number | null;
  abovePct: number | null;
  reason: string;
}

/**
 * The threshold test, as a verdict rather than two numbers to interpret.
 *
 * Provisional by construction: the cost the threshold actually absorbs is the
 * shipping label, and that is not in the database. What this can establish is
 * whether losing the shipping REVENUE is on its own enough to make the larger
 * order worse. Against production it is not.
 */
export function thresholdVerdict(bands: BandMargin[]): ThresholdVerdict {
  const below = bands.find((b) => b.label === BELOW_THRESHOLD);
  const above = bands.find((b) => b.label === ABOVE_THRESHOLD);

  if (!below?.orders || !above?.orders || below.marginPct === null || above.marginPct === null) {
    return {
      subsidising: null,
      belowPct: below?.marginPct ?? null,
      abovePct: above?.marginPct ?? null,
      reason:
        `Cannot be decided: no orders in ${!below?.orders ? BELOW_THRESHOLD : ABOVE_THRESHOLD}. ` +
        `Both bands need orders before the comparison means anything.`,
    };
  }

  const subsidising = above.marginPct < below.marginPct;

  return {
    subsidising,
    belowPct: below.marginPct,
    abovePct: above.marginPct,
    reason:
      `${ABOVE_THRESHOLD} margin is ${(100 * above.marginPct).toFixed(1)}% against ` +
      `${(100 * below.marginPct).toFixed(1)}% at ${BELOW_THRESHOLD}. ` +
      (subsidising
        ? `The band above the threshold is worse, which is what moving it to $65 or $70 would address.`
        : `The band above the threshold is no worse, so the threshold is not subsidising on this evidence.`) +
      ` PROVISIONAL: fulfilment cost is not in the database, and the shipping label is the cost the ` +
      `threshold actually absorbs. This compares margin net of product cost and payment fees only.`,
  };
}
