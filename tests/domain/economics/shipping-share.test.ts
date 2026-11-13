import { describe, it, expect } from "vitest";
import { ordersOverShippingShare, type ShareOrder } from "@/domain/economics/shipping-share";

const o = (orderNumber: string, revenueCents: number, labelCents: number | null, codes: string[] = []): ShareOrder => ({
  orderNumber, orderedAt: "2026-10-01", netRevenueCents: revenueCents, labelCostCents: labelCents, labelSource: labelCents === null ? null : "shiphero", discountCodes: codes, shippingChargedCents: 0,
});

describe("ordersOverShippingShare", () => {
  it("lists orders whose label cost is over the share of net revenue, worst first", () => {
    const r = ordersOverShippingShare([o("RH1", 2000, 900), o("RH2", 10000, 900), o("RH3", 2500, 1000)], 0.3);
    expect(r.orders.map((x) => [x.orderNumber, x.labelShare])).toEqual([["RH1", 0.45], ["RH3", 0.4]]);
  });

  it("groups them by discount code, so a promotion that loses money on shipping shows", () => {
    const r = ordersOverShippingShare([o("RH1", 2000, 900, ["FREESHIP"]), o("RH3", 2500, 1000, ["FREESHIP", "VIP"]), o("RH4", 1500, 800)], 0.3);
    expect(r.byDiscountCode).toEqual([
      { code: "FREESHIP", orders: 2, labelCostCents: 1900, netRevenueCents: 4500 },
      { code: "VIP", orders: 1, labelCostCents: 1000, netRevenueCents: 2500 },
      { code: "(no code)", orders: 1, labelCostCents: 800, netRevenueCents: 1500 },
    ]);
  });

  // Unknown postage cannot be judged either way, so it is counted, not passed.
  it("counts the orders it could not judge for want of a label cost", () => {
    const r = ordersOverShippingShare([o("RH1", 2000, 900), o("RH2", 2000, null)], 0.3);
    expect(r).toMatchObject({ judged: 1, unjudged: 1 });
  });

  it("treats an order with no revenue as over any share", () => {
    expect(ordersOverShippingShare([o("RH1", 0, 500)], 0.3).orders).toHaveLength(1);
  });
});
