import { describe, it, expect } from "vitest";
import { thresholdBands, summariseOrders, THRESHOLD_BAND_LABELS, type ThresholdOrder } from "@/domain/economics/shipping-threshold";
import type { FulfilmentRates, RateSettings } from "@/domain/economics/unit-economics";

const RATES: RateSettings = { paymentPctRate: 0.03, paymentFixedCents: 30 };
const FULFIL: FulfilmentRates = { handling: { perShippedOrderCents: 300, basis: "measured" }, postage: { perShippedOrderCents: 700, basis: "measured" } };

const o = (subtotal: number, over: Partial<ThresholdOrder> = {}): ThresholdOrder => ({
  totalPriceCents: subtotal, totalTaxCents: 0, productCostCents: 0, lineRevenueCents: subtotal, costedLineRevenueCents: subtotal,
  shipped: true, subtotalCents: subtotal, shippingChargedCents: 0, weightLb: null, postage: null, ...over,
});

describe("thresholdBands", () => {
  it("bands in $10 steps to $150, then $150+", () => {
    expect(THRESHOLD_BAND_LABELS).toEqual([
      "$0-10", "$10-20", "$20-30", "$30-40", "$40-50", "$50-60", "$60-70", "$70-80",
      "$80-90", "$90-100", "$100-110", "$110-120", "$120-130", "$130-140", "$140-150", "$150+",
    ]);
  });

  // The threshold is on the merchandise subtotal: a $55 cart paying $8.60
  // shipping is a below-threshold order, though its total is $63.60.
  it("bands on the subtotal, not on a total that includes shipping", () => {
    const { bands } = thresholdBands([o(5500, { totalPriceCents: 6360, shippingChargedCents: 860 })], RATES, FULFIL);
    expect(bands.find((b) => b.label === "$50-60")!.orders).toBe(1);
    expect(bands.find((b) => b.label === "$60-70")!.orders).toBe(0);
  });

  it("puts an order at exactly $60 in the band above", () => {
    const { bands } = thresholdBands([o(6000)], RATES, FULFIL);
    expect(bands.find((b) => b.label === "$60-70")!.orders).toBe(1);
  });

  it("counts orders it cannot band rather than dropping them silently", () => {
    expect(thresholdBands([o(5000, { subtotalCents: null })], RATES, FULFIL).unbanded).toBe(1);
  });
});

describe("summariseOrders", () => {
  it("reports free-shipping share, shipping charged, label cost, weight and margin", () => {
    const s = summariseOrders([
      o(6500, { totalPriceCents: 6500, shippingChargedCents: 0, weightLb: 2, postage: { cents: 900, source: "shiphero" } }),
      o(5500, { totalPriceCents: 6360, shippingChargedCents: 860, weightLb: 1, postage: { cents: 700, source: "invoice" } }),
    ], RATES, FULFIL);
    expect(s).toMatchObject({
      orders: 2,
      freeShippingShare: 0.5,
      avgShippingChargedCents: 430,
      avgLabelCostCents: 800,
      labelCostKnownOrders: 2,
      avgWeightLb: 1.5,
      postageKnownOrders: 2, postageFallbackOrders: 0, postageUnknownOrders: 0,
      labelCostCoverage: 1,
    });
    // Revenue 6500 + 6360; product 0; payment (195+30)+(191+30); handling 600; postage 1600.
    expect(s.contributionMarginCents).toBe(12860 - 446 - 600 - 1600);
  });

  // Label cost is averaged over the orders whose label is known, and says how many.
  it("averages label cost over known orders only, and prices the rest on the average", () => {
    const s = summariseOrders([o(6500, { postage: { cents: 1000, source: "shiphero" } }), o(6500)], RATES, FULFIL);
    expect(s).toMatchObject({ avgLabelCostCents: 1000, labelCostKnownOrders: 1, postageFallbackOrders: 1, labelCostCoverage: 0.5 });
  });

  it("is null, not zero, where there is nothing to average", () => {
    const s = summariseOrders([], RATES, FULFIL);
    expect(s).toMatchObject({ orders: 0, freeShippingShare: null, avgLabelCostCents: null, avgWeightLb: null, marginPct: null, labelCostCoverage: null });
  });
});
