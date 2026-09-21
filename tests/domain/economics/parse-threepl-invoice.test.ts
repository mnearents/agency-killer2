import { describe, it, expect } from "vitest";
import {
  parseInvoiceLines,
  reconcileInvoice,
  normaliseCategory,
  normaliseInvoiceDate,
  InvoiceParseError,
  ROUNDING_TOLERANCE_CENTS,
} from "@/domain/economics/parse-threepl-invoice";

/** The real invoice 720698, as pdfToLines renders it. */
const INVOICE_720698 = [
  "INVOICE",
  "Evobox",
  "Bill to Ship to",
  "Rad and Happy Rad and Happy",
  "Invoice details",
  "Invoice no.: 720698",
  "Invoice date: 09/08/2026",
  "Due date: 09/08/2026",
  "# Date Product or service Description Qty Rate Amount",
  "1. 09/04/2026 Sales Storage charges 1 $385.196 $385.20",
  "2. 09/04/2026 Sales Recurring charges 1 $125.00 $125.00",
  "3. 09/04/2026 Sales Order charges 1 $291.236 $291.24",
  "4. 09/04/2026 Sales Returns charges 1 $1.65 $1.65",
  "5. 09/04/2026 Sales Ad_Hoc charges 1 $8.19 $8.19",
  "Total",
  "$811.28",
];

describe("parseInvoiceLines", () => {
  it("reads the invoice number, which is the key the ledger joins on", () => {
    expect(parseInvoiceLines(INVOICE_720698).invoiceNumber).toBe("720698");
  });

  it("normalises the invoice date to ISO", () => {
    expect(parseInvoiceLines(INVOICE_720698).invoiceDate).toBe("2026-09-08");
  });

  it("reads every line item", () => {
    expect(parseInvoiceLines(INVOICE_720698).lines).toHaveLength(5);
  });

  it("reads the printed total", () => {
    expect(parseInvoiceLines(INVOICE_720698).totalCents).toBe(81128);
  });

  it("keeps the three-decimal rate as billed", () => {
    const order = parseInvoiceLines(INVOICE_720698).lines.find((l) => l.category === "order");
    expect(order?.rateCents).toBe(29124);
    expect(order?.amountCents).toBe(29124);
  });

  it("maps each description to the category the ledger uses", () => {
    expect(parseInvoiceLines(INVOICE_720698).lines.map((l) => l.category)).toEqual([
      "storage", "recurring", "order", "returns", "ad_hoc",
    ]);
  });

  // A layout change that stops the line-item regex matching would otherwise
  // record a $0.00 bill, which reads as a quiet period.
  it("throws rather than returning an invoice with no line items", () => {
    expect(() => parseInvoiceLines(["Invoice no.: 720698", "Total", "$811.28"])).toThrow(
      /zero line items/,
    );
  });

  // The strongest check available: if a line was not read, the rest no longer
  // add up to the printed total.
  it("throws when the lines do not sum to the printed total", () => {
    const missingALine = INVOICE_720698.filter((l) => !l.startsWith("3."));
    expect(() => parseInvoiceLines(missingALine)).toThrow(/does not add up/);
  });

  it("names both figures when it does not add up", () => {
    const missingALine = INVOICE_720698.filter((l) => !l.startsWith("3."));
    expect(() => parseInvoiceLines(missingALine)).toThrow(/520\.04 but the printed total is 811\.28/);
  });

  it("throws when there is no invoice number to reconcile against", () => {
    expect(() => parseInvoiceLines(["1. 09/04/2026 Sales Storage charges 1 $1.00 $1.00", "Total", "$1.00"]))
      .toThrow(InvoiceParseError);
  });

  it("throws when the total cannot be read", () => {
    expect(() => parseInvoiceLines(INVOICE_720698.slice(0, -2))).toThrow(/no readable total/);
  });

  it("reads a total printed on the same line as its label", () => {
    const inline = [...INVOICE_720698.slice(0, -2), "Total $811.28"];
    expect(parseInvoiceLines(inline).totalCents).toBe(81128);
  });
});

describe("normaliseCategory", () => {
  // "Ad_Hoc charges" on the invoice is `ad_hoc` in the ledger; if the two
  // disagree the reconciliation reports a phantom gap in one and a phantom
  // surplus in the other.
  it("matches the ledger's spelling", () => {
    expect(normaliseCategory("Ad_Hoc charges")).toBe("ad_hoc");
    expect(normaliseCategory("Storage charges")).toBe("storage");
    expect(normaliseCategory("Order charges")).toBe("order");
  });

  it("handles a singular 'charge'", () => {
    expect(normaliseCategory("Storage charge")).toBe("storage");
  });

  it("collapses spaces and hyphens the way the ledger does", () => {
    expect(normaliseCategory("Ad Hoc charges")).toBe("ad_hoc");
  });
});

describe("normaliseInvoiceDate", () => {
  it("converts US format to ISO", () => {
    expect(normaliseInvoiceDate("09/08/2026")).toBe("2026-09-08");
  });

  it("pads a single-digit month and day", () => {
    expect(normaliseInvoiceDate("9/8/2026")).toBe("2026-09-08");
  });

  it("returns null rather than guessing at an unreadable date", () => {
    expect(normaliseInvoiceDate("not a date")).toBeNull();
    expect(normaliseInvoiceDate(null)).toBeNull();
  });
});

describe("reconcileInvoice", () => {
  const invoice = parseInvoiceLines(INVOICE_720698);
  /** The real ledger totals for the same bill. */
  const LEDGER = [
    { category: "storage", cents: 38526 },
    { category: "order", cents: 16150 },
    { category: "recurring", cents: 12500 },
    { category: "returns", cents: 165 },
    { category: "ad_hoc", cents: 819 },
  ];

  // This is the check that found the postage.
  it("flags the category the invoice charges but the ledger does not itemise", () => {
    const r = reconcileInvoice(invoice, LEDGER);
    expect(r.unexplained).toHaveLength(1);
    expect(r.unexplained[0]).toMatchObject({ category: "order", gapCents: 12974 });
  });

  it("explains the gap in words, not just a number", () => {
    expect(reconcileInvoice(invoice, LEDGER).notes[0]).toMatch(/129\.74 more than the ledger/);
  });

  // 35 storage rows rounded individually against one rounded invoice line is
  // arithmetic, not a missing charge.
  it("treats a few cents of per-row rounding as explained", () => {
    const r = reconcileInvoice(invoice, LEDGER);
    expect(r.byCategory.find((c) => c.category === "storage")?.gapCents).toBe(-6);
    expect(r.unexplained.map((c) => c.category)).not.toContain("storage");
  });

  it("reports the overall gap against the printed total", () => {
    expect(reconcileInvoice(invoice, LEDGER).gapCents).toBe(12968);
  });

  it("sorts categories by how far apart they are", () => {
    expect(reconcileInvoice(invoice, LEDGER).byCategory[0].category).toBe("order");
  });

  it("finds nothing unexplained when the two agree", () => {
    const exact = [
      { category: "storage", cents: 38520 },
      { category: "order", cents: 29124 },
      { category: "recurring", cents: 12500 },
      { category: "returns", cents: 165 },
      { category: "ad_hoc", cents: 819 },
    ];
    const r = reconcileInvoice(invoice, exact);
    expect(r.unexplained).toEqual([]);
    expect(r.gapCents).toBe(0);
  });

  // A category the ledger has and the invoice does not is the same problem in
  // reverse, and must not be dropped just because the invoice never named it.
  it("reports a category present only in the ledger", () => {
    const r = reconcileInvoice(invoice, [...LEDGER, { category: "mystery", cents: 5000 }]);
    expect(r.unexplained.map((c) => c.category)).toContain("mystery");
    expect(r.byCategory.find((c) => c.category === "mystery")?.gapCents).toBe(-5000);
  });

  it("uses a tolerance below anything that could hide a real fee", () => {
    expect(ROUNDING_TOLERANCE_CENTS).toBeLessThanOrEqual(100);
  });
});
