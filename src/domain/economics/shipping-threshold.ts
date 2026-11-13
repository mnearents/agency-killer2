/**
 * Is free shipping over $60 helping or hurting margin? — pure.
 *
 * Shipped physical orders banded by SUBTOTAL (merchandise after discounts,
 * before shipping and tax), which is what a free-shipping threshold is set
 * on. Banding on the order total, as `margin_by_order_value` does, moves a
 * $55 cart paying $8.60 shipping into the $60-70 band and mixes paying
 * orders into the free side of the comparison.
 *
 * Each order's postage is its own label cost where known (`order-postage.ts`)
 * and the average per shipped order where not — counted, so a band priced on
 * averages says so. Label cost and weight are averaged over the orders that
 * have one, with the count.
 */

import { paymentFeeCents, postageMix, type FulfilmentRates, type OrderForEconomics, type RateSettings } from "./unit-economics";

export interface ThresholdOrder extends OrderForEconomics {
  /** Line items after discounts, before shipping and tax (Shopify's subtotal). */
  subtotalCents: number | null;
  /** What the customer paid for shipping, from Shopify: total − subtotal − tax. */
  shippingChargedCents: number | null;
  weightLb: number | null;
}

const BANDS: Array<{ label: string; minCents: number; maxCents: number | null }> = [
  ...Array.from({ length: 15 }, (_, i) => ({ label: `$${i * 10}-${(i + 1) * 10}`, minCents: i * 1000, maxCents: (i + 1) * 1000 })),
  { label: "$150+", minCents: 15000, maxCents: null },
];

export const THRESHOLD_BAND_LABELS = BANDS.map((b) => b.label);

export interface OrderSummary {
  orders: number;
  /** Share charged nothing for shipping, of those whose shipping charge is known. */
  freeShippingShare: number | null;
  avgShippingChargedCents: number | null;
  /** Over the orders whose own label cost is known — `labelCostKnownOrders` of them. */
  avgLabelCostCents: number | null;
  labelCostKnownOrders: number;
  /** Share of orders with their own label cost. */
  labelCostCoverage: number | null;
  avgWeightLb: number | null;
  weightKnownOrders: number;
  revenueCents: number;
  contributionMarginCents: number;
  avgContributionMarginCents: number | null;
  marginPct: number | null;
  postageKnownOrders: number;
  postageFallbackOrders: number;
  postageUnknownOrders: number;
}

const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * Contribution margin is revenue (total less tax, so shipping collected is
 * in it) less landed product cost, payment fees, handling and postage.
 */
export function summariseOrders(orders: ThresholdOrder[], rates: RateSettings, fulfilment: FulfilmentRates | undefined): OrderSummary {
  let revenueCents = 0;
  let costCents = 0;
  for (const o of orders) {
    revenueCents += o.totalPriceCents - (o.totalTaxCents ?? 0);
    costCents += o.productCostCents + paymentFeeCents(o.totalPriceCents, rates);
    if (o.shipped && fulfilment?.handling) costCents += fulfilment.handling.perShippedOrderCents;
  }
  const postage = postageMix(orders, fulfilment);
  const margin = revenueCents - costCents - postage.cents;

  const charged = orders.map((o) => o.shippingChargedCents).filter((c): c is number => c !== null);
  const labels = orders.map((o) => o.postage?.cents).filter((c): c is number => c !== undefined);
  const weights = orders.map((o) => o.weightLb).filter((w): w is number => w !== null);
  const avgCharged = mean(charged);
  const avgLabel = mean(labels);
  const avgWeight = mean(weights);

  return {
    orders: orders.length,
    freeShippingShare: charged.length === 0 ? null : charged.filter((c) => c === 0).length / charged.length,
    avgShippingChargedCents: avgCharged === null ? null : Math.round(avgCharged),
    avgLabelCostCents: avgLabel === null ? null : Math.round(avgLabel),
    labelCostKnownOrders: labels.length,
    labelCostCoverage: orders.length === 0 ? null : labels.length / orders.length,
    avgWeightLb: avgWeight === null ? null : Math.round(avgWeight * 100) / 100,
    weightKnownOrders: weights.length,
    revenueCents,
    contributionMarginCents: margin,
    avgContributionMarginCents: orders.length === 0 ? null : Math.round(margin / orders.length),
    marginPct: revenueCents === 0 ? null : margin / revenueCents,
    postageKnownOrders: postage.known,
    postageFallbackOrders: postage.fallback,
    postageUnknownOrders: postage.unknown,
  };
}

export function thresholdBands(
  orders: ThresholdOrder[],
  rates: RateSettings,
  fulfilment: FulfilmentRates | undefined,
): { bands: Array<OrderSummary & { label: string }>; unbanded: number } {
  const banded = orders.filter((o) => o.subtotalCents !== null);
  return {
    bands: BANDS.map((band) => ({
      label: band.label,
      ...summariseOrders(
        banded.filter((o) => o.subtotalCents! >= band.minCents && (band.maxCents === null || o.subtotalCents! < band.maxCents)),
        rates,
        fulfilment,
      ),
    })),
    unbanded: orders.length - banded.length,
  };
}
