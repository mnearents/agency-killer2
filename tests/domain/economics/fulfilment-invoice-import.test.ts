import { describe, it, expect } from "vitest";
import { evoboxInvoiceRows, carrierInvoiceRows, classifyInvoicePdf, shippingInvoiceRows } from "@/domain/economics/fulfilment-invoice-import";
import type { ThreeplInvoice } from "@/domain/economics/parse-threepl-invoice";
import type { CarrierInvoice } from "@/domain/economics/parse-carrier-invoice";

const evobox: ThreeplInvoice = {
  invoiceNumber: "762890",
  invoiceDate: "2026-11-03",
  servicePeriod: { start: "2026-10-17", end: "2026-10-30", inferred: false },
  lines: [
    { category: "order", description: "Order charges", quantity: 1, rateCents: 12782, amountCents: 12782 },
    { category: "storage", description: "Storage charges", quantity: 1, rateCents: 38478, amountCents: 38478 },
  ],
  totalCents: 51260,
};

describe("evoboxInvoiceRows", () => {
  it("stores one row per line over the bill's service period", () => {
    expect(evoboxInvoiceRows(evobox, "Invoice_762890_from_Evobox.pdf")).toEqual([
      expect.objectContaining({ source: "evobox", invoiceNumber: "762890", issued: "2026-11-03", periodStart: "2026-10-17", periodEnd: "2026-10-30", periodInferred: 0, category: "order", amountCents: 12782 }),
      expect.objectContaining({ category: "storage", amountCents: 38478, sourceFile: "Invoice_762890_from_Evobox.pdf" }),
    ]);
  });

  it("marks an inferred period", () => {
    const rows = evoboxInvoiceRows({ ...evobox, servicePeriod: { start: "2026-08-22", end: "2026-09-04", inferred: true } }, "x.pdf");
    expect(rows[0].periodInferred).toBe(1);
  });

  // Without days, a bill cannot be placed against the orders it served.
  it("refuses a bill with no service period", () => {
    expect(() => evoboxInvoiceRows({ ...evobox, servicePeriod: null }, "x.pdf")).toThrow(/no service period/);
  });
});

describe("carrierInvoiceRows", () => {
  const carrier: CarrierInvoice = {
    invoiceNumber: "S2R9HH6VMZSN", issued: "2026-10-26", periodStart: "2026-10-19", periodEnd: "2026-10-25",
    carriers: [{ carrier: "Cirro", shipments: 21, amountCents: 18291 }, { carrier: "USPS", shipments: 20, amountCents: 14348 }],
    shipments: 41, totalCents: 32639,
  };

  it("stores one postage row per carrier with its shipment count", () => {
    expect(carrierInvoiceRows(carrier, "week.pdf")).toEqual([
      expect.objectContaining({ source: "carrier", category: "postage", carrier: "Cirro", shipments: 21, amountCents: 18291, periodStart: "2026-10-19", periodEnd: "2026-10-25" }),
      expect.objectContaining({ carrier: "USPS", shipments: 20, amountCents: 14348 }),
    ]);
  });
});

describe("classifyInvoicePdf", () => {
  it("tells the three kinds of PDF apart by content", () => {
    expect(classifyInvoicePdf(["SUMMARY OF CHARGES BY CARRIER", "Cirro 21 $182.91"])).toBe("carrier");
    expect(classifyInvoicePdf(["Invoice no.: 20980", "1. Shipping $81.47", "Total", "$81.47"])).toBe("shipping");
    expect(classifyInvoicePdf(["Invoice no.: 762890", "1. Sales Order charges 1 $127.82 $127.82"])).toBe("evobox");
  });
});

describe("shippingInvoiceRows", () => {
  // Invoice 20621, dated Tuesday 09/08, is the $178.63 carrier bill for Mon
  // 8/31 to Sun 9/6: the week ending the Sunday before the invoice.
  it("stores the weekly Shipping invoice as postage for the week before its date", () => {
    const rows = shippingInvoiceRows(["Invoice no.: 20621", "Invoice date: 09/08/2026", "1. Shipping $178.63", "Total", "$178.63"], "Invoice_20621_from_Evobox.pdf");
    expect(rows).toEqual([expect.objectContaining({
      source: "evobox-shipping", invoiceNumber: "20621", issued: "2026-09-08", periodStart: "2026-08-31", periodEnd: "2026-09-06",
      periodInferred: 1, category: "postage", carrier: null, shipments: null, amountCents: 17_863,
    })]);
  });

  it("takes the previous week when the invoice is dated on a Monday", () => {
    const rows = shippingInvoiceRows(["Invoice no.: 20664", "Invoice date: 09/14/2026", "1. Shipping $212.01", "Total", "$212.01"], "x.pdf");
    expect(rows[0]).toMatchObject({ periodStart: "2026-09-07", periodEnd: "2026-09-13" });
  });

  it("refuses an invoice whose line does not match its total", () => {
    expect(() => shippingInvoiceRows(["Invoice no.: 1", "Invoice date: 09/14/2026", "1. Shipping $212.01", "Total", "$9.99"], "x.pdf")).toThrow(/add up/);
  });
});
