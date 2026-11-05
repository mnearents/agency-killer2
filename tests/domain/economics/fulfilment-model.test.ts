import { describe, it, expect } from "vitest";
import { computeFulfilmentRates, type InvoiceLineInput } from "@/domain/economics/fulfilment-model";

const evobox = (category: string, amountCents: number, periodStart = "2026-10-17", periodEnd = "2026-10-30"): InvoiceLineInput =>
  ({ source: "evobox", category, amountCents, periodStart, periodEnd, shipments: null });
const carrier = (amountCents: number, shipments: number, periodStart = "2026-10-19", periodEnd = "2026-10-25"): InvoiceLineInput =>
  ({ source: "carrier", category: "postage", amountCents, periodStart, periodEnd, shipments });

/** 10 shipped orders on every day from 2026-10-01 to 2026-10-31. */
const shippedByDay = new Map(Array.from({ length: 31 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, "0")}`, 10]));

describe("computeFulfilmentRates", () => {
  // Bill 762890: $127.82 order + $17.50 ad hoc over 10/17-10/30, 140 shipped orders.
  it("averages pick/pack, ad hoc and returns over the shipped orders in the billed days", () => {
    const r = computeFulfilmentRates([evobox("order", 12_782), evobox("ad_hoc", 1_750)], shippedByDay, { start: "2026-10-18", end: "2026-10-29" });
    expect(r.rates.handling).toEqual({ perShippedOrderCents: 104, basis: "measured" }); // 14,532 / 140
    expect(r.coverage.handling).toMatchObject({ from: "2026-10-17", to: "2026-10-30", shippedOrders: 140, amountCents: 14_532 });
  });

  // Storage and the API fee do not grow with orders: overhead, not COD.
  it("keeps storage, the recurring fee and the minimum top-up out of the per-order rate", () => {
    const r = computeFulfilmentRates([evobox("order", 14_000), evobox("storage", 38_478), evobox("recurring", 12_500), evobox("minimum", 16_183)], shippedByDay, { start: "2026-10-18", end: "2026-10-29" });
    expect(r.rates.handling!.perShippedOrderCents).toBe(100);
    // 67,161 over 14 days, × 365/12.
    expect(r.fixedOverheadMonthlyCents).toBe(Math.round((67_161 / 14) * (365 / 12)));
  });

  it("prices postage per shipment from the carrier invoices' own counts", () => {
    const r = computeFulfilmentRates([carrier(32_639, 41)], shippedByDay, { start: "2026-10-19", end: "2026-10-25" });
    expect(r.rates.postage).toEqual({ perShipmentCents: 796, basis: "measured" });
  });

  // Applied to days no invoice covers, an average is an estimate, and says so.
  it("calls a rate estimated when the window runs outside the invoiced days", () => {
    const r = computeFulfilmentRates([evobox("order", 14_000), carrier(32_639, 41)], shippedByDay, { start: "2026-07-01", end: "2026-10-29" });
    expect(r.rates.handling!.basis).toBe("estimated");
    expect(r.rates.postage!.basis).toBe("estimated");
    expect(r.notes.join(" ")).toMatch(/applied beyond/);
  });

  // Nothing invoiced is missing, not free.
  it("returns null rates when nothing is invoiced", () => {
    const r = computeFulfilmentRates([], shippedByDay, { start: "2026-10-01", end: "2026-10-31" });
    expect(r.rates).toEqual({ handling: null, postage: null });
    expect(r.fixedOverheadMonthlyCents).toBeNull();
  });

  it("refuses to divide by zero shipped orders", () => {
    const r = computeFulfilmentRates([evobox("order", 14_000)], new Map(), { start: "2026-10-18", end: "2026-10-29" });
    expect(r.rates.handling).toBeNull();
    expect(r.notes.join(" ")).toMatch(/no shipped orders/);
  });

  // Weeks with no carrier invoice are gaps, and the coverage says how many days are held.
  it("counts the invoiced days, not the span between the first and last invoice", () => {
    const r = computeFulfilmentRates([carrier(100, 1, "2026-09-07", "2026-09-13"), carrier(100, 1, "2026-10-19", "2026-10-25")], shippedByDay, { start: "2026-10-19", end: "2026-10-25" });
    expect(r.coverage.postage).toMatchObject({ from: "2026-09-07", to: "2026-10-25", daysInvoiced: 14 });
  });
});
