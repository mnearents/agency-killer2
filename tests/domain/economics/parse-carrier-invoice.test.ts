import { describe, it, expect } from "vitest";
import { parseCarrierInvoice, isCarrierInvoice, CarrierInvoiceParseError } from "@/domain/economics/parse-carrier-invoice";

/** The weekly label invoice for 9/7-9/13/2026, page 1 as pdfToLines renders it. */
const WEEK_0907 = [
  "5020 West 2700 North", "Building 1 Suite 70", "Lehi, UT 84043",
  "Billed To Date Issued Invoice Number Amount Due",
  "Rad and Happy 9/14/2026 Y7JQ5Q8W385F $212.01",
  "Due Date For Shipments Between",
  "Upon receipt 9/7/2026 - 9/13/2026",
  "SUMMARY OF CHARGES BY CARRIER",
  "CARRIER SHIPMENTS CHARGE",
  "Cirro 7 $68.64",
  "DHL eCommerce 11 $94.10",
  "FedEx 1 $25.68",
  "USPS 2 $23.59",
  "TOTAL 21 $212.01",
  "Page 1 / 3",
  "SUMMARY OF CHARGES BY CATEGORY",
  "CATEGORY LINE ITEMS CHARGE",
  "Transportation 21 $210.00",
  "TOTAL 21 $212.01",
];

describe("parseCarrierInvoice", () => {
  it("reads the invoice number, issue date and the week it covers", () => {
    expect(parseCarrierInvoice(WEEK_0907)).toMatchObject({
      invoiceNumber: "Y7JQ5Q8W385F", issued: "2026-09-14", periodStart: "2026-09-07", periodEnd: "2026-09-13",
    });
  });

  // Carrier names run to more than one word.
  it("reads every carrier with its shipments and charge", () => {
    expect(parseCarrierInvoice(WEEK_0907).carriers).toEqual([
      { carrier: "Cirro", shipments: 7, amountCents: 6864 },
      { carrier: "DHL eCommerce", shipments: 11, amountCents: 9410 },
      { carrier: "FedEx", shipments: 1, amountCents: 2568 },
      { carrier: "USPS", shipments: 2, amountCents: 2359 },
    ]);
  });

  it("checks the carriers against the printed total", () => {
    const r = parseCarrierInvoice(WEEK_0907);
    expect(r.totalCents).toBe(21_201);
    expect(r.shipments).toBe(21);
  });

  it("refuses an invoice whose carriers do not add up to its total", () => {
    const broken = WEEK_0907.map((l) => (l === "USPS 2 $23.59" ? "USPS 2 $3.59" : l));
    expect(() => parseCarrierInvoice(broken)).toThrow(CarrierInvoiceParseError);
    expect(() => parseCarrierInvoice(broken)).toThrow(/192\.01.*212\.01/);
  });

  it("refuses a page with no carrier summary", () => {
    expect(() => parseCarrierInvoice(WEEK_0907.slice(0, 7))).toThrow(/carrier/i);
  });
});

describe("isCarrierInvoice", () => {
  it("recognises the weekly label invoice and nothing else", () => {
    expect(isCarrierInvoice(WEEK_0907)).toBe(true);
    expect(isCarrierInvoice(["Invoice no.: 762890", "1. Sales Order charges 1 $127.82 $127.82"])).toBe(false);
  });
});
