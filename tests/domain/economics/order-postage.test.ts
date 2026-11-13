import { describe, it, expect } from "vitest";
import { resolvePostage, compareSources } from "@/domain/economics/order-postage";

const inv = (rows: number, known: number, cents: number | null) => ({ rows, known, cents });
const sh = (labels: number, known: number, cents: number | null) => ({ labels, known, cents });

describe("resolvePostage", () => {
  it("takes the invoice figure where every one of the order's rows is known", () => {
    expect(resolvePostage(inv(1, 1, 812), sh(1, 1, 825))).toEqual({ cents: 812, source: "invoice" });
  });

  it("falls back to ShipHero's label cost where the invoice has none", () => {
    expect(resolvePostage(null, sh(2, 2, 1650))).toEqual({ cents: 1650, source: "shiphero" });
    expect(resolvePostage(inv(1, 0, null), sh(1, 1, 825))).toEqual({ cents: 825, source: "shiphero" });
  });

  // A part-known order is not known: summing what is known would quote a floor as the cost.
  it("is unknown when any label on the order is unknown, in both sources", () => {
    expect(resolvePostage(inv(2, 1, 600), sh(2, 1, 600))).toBeNull();
    expect(resolvePostage(null, sh(1, 0, null))).toBeNull();
    expect(resolvePostage(null, null)).toBeNull();
  });

  it("is unknown for an order whose only ShipHero labels were excluded", () => {
    expect(resolvePostage(null, sh(0, 0, null))).toBeNull();
  });
});

describe("compareSources", () => {
  it("counts the orders with both, their mean difference and those over 50 cents apart", () => {
    const r = compareSources([
      { orderNumber: "RH1", invoiceCents: 800, shipheroCents: 800 },
      { orderNumber: "RH2", invoiceCents: 800, shipheroCents: 840 },
      { orderNumber: "RH3", invoiceCents: 1000, shipheroCents: 1200 },
    ]);
    expect(r).toMatchObject({ orders: 3, identical: 1, meanDifferenceCents: 80, overFiftyCents: 1 });
    expect(r.largest[0]).toEqual({ orderNumber: "RH3", invoiceCents: 1000, shipheroCents: 1200, differenceCents: 200 });
  });

  it("says nothing overlapped rather than reporting a zero difference", () => {
    expect(compareSources([])).toMatchObject({ orders: 0, meanDifferenceCents: null });
  });
});
