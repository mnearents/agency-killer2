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
   * Whether a landed cost was actually recorded.
   *
   * Separate from a cost of 0 because digital products genuinely cost nothing
   * while a planner with nothing entered is a gap, and counting the second as
   * zero makes every margin quietly optimistic.
   */
  costIsKnown: boolean;
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
  /** Share of revenue whose landed product cost is actually known. */
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
  let revenueWithKnownCost = 0;

  for (const o of orders) {
    // Tax leaves revenue; the processor still charged on it.
    const exTax = o.totalPriceCents - (o.totalTaxCents ?? 0);
    revenueCents += exTax;

    percentageCents += Math.round(o.totalPriceCents * rates.paymentPctRate);
    fixedCents += rates.paymentFixedCents;

    // The known part counts even when the order is not fully costed. Adding
    // nothing unless every line has a cost throws away real evidence and
    // produces a floor lower than the data supports — conservative in the
    // wrong direction is still wrong.
    productCostCents += o.productCostCents;
    if (o.costIsKnown) revenueWithKnownCost += exTax;
  }

  const paymentCents = percentageCents + fixedCents;
  const codCents = productCostCents + paymentCents;

  const cogsCoveragePct = revenueCents === 0 ? 0 : revenueWithKnownCost / revenueCents;

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
        ? `Landed product cost for ${((1 - cogsCoveragePct) * 100).toFixed(0)}% of revenue`
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
