/**
 * aMER — new order revenue against ad spend, measured against break-even.
 *
 * #34:
 *
 *   aMER            = New Order Revenue / Total Ad Spend
 *   Break-even aMER = 1 / (1 - COD%)
 *
 * The comparison is the whole point. aMER on its own is a ratio with no scale:
 * against production the paid era ran between 0.51 and 5.33 with a typical
 * month near 2.0, and whether 2.0 is good depends entirely on a cost of
 * delivery that differs by a factor of six across the three business lines.
 *
 * ## Break-even is computed over the mix that was bought
 *
 * Not blended across every order in the window, and not taken from one line.
 * The new customers are what the spend bought, so their cost of delivery is
 * the one that decides whether the spend paid for itself. A month that
 * acquired mostly subscribers breaks even near 1.09; a month that sold
 * planners needs 2.0-2.9, and using the wrong one points the wrong way by a
 * factor of two.
 *
 * ## Why there is often no verdict
 *
 * Fulfilment cost is not in the database, so COD is understated, so break-even
 * is understated too. That makes the two comparisons asymmetric:
 *
 *   aMER BELOW an understated break-even → below the real one too. Safe.
 *   aMER ABOVE an understated break-even → says nothing. The real break-even
 *                                          is higher and may be above it.
 *
 * So `above-break-even` is withheld until the cost side is complete. It is the
 * optimistic direction on the one number that authorises spending.
 *
 * Pure functions only — no database, no clock.
 */

import {
  breakEvenAmer,
  paymentFeeCents,
  type OrderForEconomics,
  type RateSettings,
} from "./unit-economics";

const FULFILMENT_LABEL = "Fulfilment (3PL labels, pick/pack, storage)";

export interface AmerLineInput {
  line: string;
  /** First orders of customers acquired in the window. Not every order they placed. */
  orders: OrderForEconomics[];
}

export interface AmerInput {
  /** Total ad spend across the channels in scope. Zero is a real value here. */
  spendCents: number;
  rates: RateSettings;
  byLine: AmerLineInput[];
  /**
   * 3PL cost attributable to these orders, when it is known.
   *
   * Absent rather than zero by default: a fulfilment cost of nothing and a
   * fulfilment cost nobody has entered produce very different break-evens, and
   * only one of them is a measurement.
   */
  fulfilmentCents?: number;
}

export interface AmerLine {
  line: string;
  newOrders: number;
  newRevenueCents: number;
  /** 0 when the line acquired nobody, which is why empty lines are kept. */
  shareOfNewRevenue: number;
}

export type AmerVerdict = "above-break-even" | "below-break-even" | "undecidable";

export interface AmerResult {
  spendCents: number;
  newOrders: number;
  newRevenueCents: number;
  /** Null when nothing was spent. Undefined, never Infinity. */
  amer: number | null;
  codPct: number | null;
  breakEvenAmer: number | null;
  /** `floor` while a cost category is missing — the real break-even is higher. */
  breakEvenBound: "measured" | "floor";
  verdict: AmerVerdict;
  reason: string;
  lines: AmerLine[];
  missing: string[];
}

export function computeAmer(input: AmerInput): AmerResult {
  const { spendCents, rates, byLine } = input;

  let newRevenueCents = 0;
  let newOrders = 0;
  let productCostCents = 0;
  let paymentCents = 0;
  let lineRevenueCents = 0;
  let costedLineRevenueCents = 0;

  const lineTotals: Array<{ line: string; orders: number; revenueCents: number }> = [];

  for (const { line, orders } of byLine) {
    let lineRevenue = 0;
    for (const o of orders) {
      // Tax leaves revenue; the processor still charged on it.
      const exTax = o.totalPriceCents - (o.totalTaxCents ?? 0);
      lineRevenue += exTax;
      productCostCents += o.productCostCents;
      paymentCents += paymentFeeCents(o.totalPriceCents, rates);
      lineRevenueCents += o.lineRevenueCents;
      costedLineRevenueCents += o.costedLineRevenueCents;
    }
    newRevenueCents += lineRevenue;
    newOrders += orders.length;
    lineTotals.push({ line, orders: orders.length, revenueCents: lineRevenue });
  }

  const missing: string[] = [];
  if (lineRevenueCents > 0 && costedLineRevenueCents < lineRevenueCents) {
    const uncosted = 1 - costedLineRevenueCents / lineRevenueCents;
    missing.push(
      `Landed product cost for ${(100 * uncosted).toFixed(0)}% of new-customer line-item revenue`
    );
  }
  if (input.fulfilmentCents === undefined) missing.push(FULFILMENT_LABEL);

  const codCents = productCostCents + paymentCents + (input.fulfilmentCents ?? 0);
  const codPct = newRevenueCents === 0 ? null : codCents / newRevenueCents;
  const breakEven = codPct === null ? null : breakEvenAmer(codPct);
  const breakEvenBound = missing.length === 0 ? "measured" : "floor";

  const lines: AmerLine[] = lineTotals.map((l) => ({
    line: l.line,
    newOrders: l.orders,
    newRevenueCents: l.revenueCents,
    shareOfNewRevenue: newRevenueCents === 0 ? 0 : l.revenueCents / newRevenueCents,
  }));

  // Zero spend is not infinite efficiency. It is a question with no answer,
  // and today it is the answer for every window after 2026-03-29.
  const amer = spendCents === 0 ? null : newRevenueCents / spendCents;

  const base = {
    spendCents,
    newOrders,
    newRevenueCents,
    amer,
    codPct,
    breakEvenAmer: breakEven,
    breakEvenBound: breakEvenBound as "measured" | "floor",
    lines,
    missing,
  };

  if (amer === null) {
    return {
      ...base,
      verdict: "undecidable",
      reason:
        "There was no ad spend in this window, so aMER is undefined. It is not zero and not " +
        "infinite — there is no ratio to take.",
    };
  }

  if (breakEven === null) {
    return {
      ...base,
      verdict: "undecidable",
      reason:
        codPct === null
          ? "No new customers were acquired in this window, so there is no cost of delivery to break even against."
          : `Cost of delivery is ${(100 * codPct).toFixed(1)}% of new-customer revenue, so no aMER breaks even.`,
    };
  }

  const above = amer >= breakEven;

  // Below an understated break-even is below the real one too, so that verdict
  // survives the missing costs. Above it does not.
  if (!above) {
    return {
      ...base,
      verdict: "below-break-even",
      reason:
        `aMER of ${amer.toFixed(2)} against a break-even of ${breakEven.toFixed(2)}. ` +
        (breakEvenBound === "floor"
          ? `Break-even is a floor here (missing ${missing.join(", ")}), and the real one is ` +
            `higher — so this is below break-even by more than the gap shown.`
          : `This spend did not pay for itself.`),
    };
  }

  if (breakEvenBound === "floor") {
    return {
      ...base,
      verdict: "undecidable",
      reason:
        `aMER of ${amer.toFixed(2)} is above a break-even of ${breakEven.toFixed(2)}, but that ` +
        `break-even is a floor: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not in ` +
        `the cost of delivery, so the real break-even is higher and may be above this aMER. ` +
        `Being over an understated bar is not evidence of clearing the real one.`,
    };
  }

  return {
    ...base,
    verdict: "above-break-even",
    reason:
      `aMER of ${amer.toFixed(2)} against a break-even of ${breakEven.toFixed(2)}, over a ` +
      `complete cost of delivery. This spend paid for itself on first orders alone.`,
  };
}
