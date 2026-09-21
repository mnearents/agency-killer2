import { describe, it, expect } from "vitest";
import {
  parseThreeplChargeCsv,
  parseMoneyToCents,
  parseNumber,
  chooseOrderColumn,
  labelCost,
  ORDER_NUMBER_PATTERN,
} from "@/domain/economics/parse-threepl-csv";

/** The real header, verbatim. */
const HEADER = [
  "Date (charge)", "Category (charge)", "Fee (charge)", "Type (charge)", "Label (charge)",
  "Description (charge)", "Unit rate (charge)", "Quantity (charge)", "Total (charge)",
  "Order # (shipment)", "Order date (shipment)", "Tracking # (shipment)", "Method (shipment)",
  "Box (shipment)", "Weight (shipment)", "Height (shipment)", "Length (shipment)",
  "Width (shipment)", "SKU units ordered (shipment)", "SKU units shipped (shipment)",
  "Country (shipment)", "State (shipment)", "City (shipment)", "Postal code (shipment)",
  "Ship to (shipment)", "SKUs ordered (shipment)", "SKUs shipped (shipment)",
  "Units ordered (shipment)", "Units shipped (shipment)", "SKU (product)", "Name (product)",
  "Weight in oz (product)", "Height (product)", "Length (product)", "Width (product)",
  "Bin type (bin storage)", "Days occupied (bin storage)", "Reason (return)",
  "SKU units returned (return)", "Units received (return)", "Units restocked (return)",
  "SKU units received (return)", "SKU units restocked (return)", "RMA tracking # (return)",
  "RMA carrier (return)", "RMA method (return)", "RMA box code (return)",
  "RMA box weight (return)", "RMA country (return)", "RMA state (return)", "RMA city (return)",
  "RMA postal code (return)", "RMA ship to (return)", "RMA quoted cost (return)",
  "Customer name (customer)", "Customer ID (customer)", "Bill # (bill)", "Period start (bill)",
  "Period end (bill)", "Billed label cost (label reconciliation)",
  "Reconciled label cost (label reconciliation)", "Units Shipped (shipping label)",
  "ORDER NUMBER", "F1",
];

/** Builds a tab-separated export from sparse {column: value} rows. */
function csv(rows: Record<string, string>[], header: string[] = HEADER): string {
  const lines = [header.join("\t")];
  for (const row of rows) {
    lines.push(header.map((col) => row[col] ?? "").join("\t"));
  }
  return lines.join("\n");
}

const shipping = (over: Record<string, string> = {}) => ({
  "Date (charge)": "2026-08-03",
  "Category (charge)": "Shipping",
  "Fee (charge)": "Label",
  "Total (charge)": "6.42",
  "Tracking # (shipment)": "9400111899",
  "ORDER NUMBER": "RH354748",
  "Order # (shipment)": "77012345",
  "Bill # (bill)": "B-1001",
  ...over,
});

describe("parseThreeplChargeCsv", () => {
  it("parses a charge row from the real header", () => {
    const { rows } = parseThreeplChargeCsv(csv([shipping()]));
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("Shipping");
    expect(rows[0].totalCents).toBe(642);
    expect(rows[0].billNumber).toBe("B-1001");
  });

  // The grain is the charge, not the shipment. A storage row has no tracking
  // number and a shipping row has no bin — both must survive the same parser.
  it("parses a storage row that carries no shipment context", () => {
    const { rows } = parseThreeplChargeCsv(
      csv([{
        "Date (charge)": "2026-08-31",
        "Category (charge)": "Storage",
        "Total (charge)": "118.40",
        "Bin type (bin storage)": "Large",
        "Days occupied (bin storage)": "31",
        "SKU (product)": "RAD-PLANNER-2026",
      }]),
    );
    expect(rows[0].binType).toBe("Large");
    expect(rows[0].daysOccupied).toBe(31);
    expect(rows[0].trackingNumber).toBeNull();
    expect(rows[0].orderNumber).toBeNull();
  });

  it("parses a return row with its RMA cost", () => {
    const { rows } = parseThreeplChargeCsv(
      csv([{
        "Date (charge)": "2026-08-12",
        "Category (charge)": "Returns",
        "Total (charge)": "4.10",
        "Reason (return)": "Damaged",
        "Units received (return)": "2",
        "Units restocked (return)": "1",
        "RMA quoted cost (return)": "3.75",
        "RMA carrier (return)": "USPS",
      }]),
    );
    expect(rows[0].returnReason).toBe("Damaged");
    expect(rows[0].unitsRestocked).toBe(1);
    expect(rows[0].rmaQuotedCostCents).toBe(375);
  });

  it("reports columns it does not map instead of dropping them", () => {
    const { unknownColumns } = parseThreeplChargeCsv(csv([shipping()]));
    expect(unknownColumns).toContain("F1");
    expect(unknownColumns).toContain("Ship to (shipment)");
  });

  it("keeps the value of an unmapped column in extra", () => {
    const { rows } = parseThreeplChargeCsv(csv([shipping({ F1: "whatever-this-is" })]));
    expect(rows[0].extra.F1).toBe("whatever-this-is");
  });

  it("keeps the whole row for audit", () => {
    const { rows } = parseThreeplChargeCsv(csv([shipping()]));
    expect(rows[0].raw["Tracking # (shipment)"]).toBe("9400111899");
  });

  // A truncated or wrong export must not import as zero rows and read as a
  // quiet month.
  it("throws when a required column is absent", () => {
    expect(() => parseThreeplChargeCsv(csv([{}], ["Date (charge)", "F1"]))).toThrow(
      /missing required column/,
    );
  });

  it("throws on an empty file rather than returning no rows", () => {
    expect(() => parseThreeplChargeCsv("")).toThrow(/empty/);
  });

  it("handles comma-delimited exports with quoted fields", () => {
    const content = [
      "Date (charge),Category (charge),Total (charge),Description (charge)",
      `2026-08-03,Shipping,"1,204.50","Pick, pack and label"`,
    ].join("\n");
    const { rows } = parseThreeplChargeCsv(content);
    expect(rows[0].totalCents).toBe(120450);
    expect(rows[0].description).toBe("Pick, pack and label");
  });
});

describe("chooseOrderColumn", () => {
  // Two columns can carry an order reference and which one is undocumented.
  // Guessing wrong imports every charge unattributed — a silent zero.
  it("picks the column whose values look like Shopify order names", () => {
    const choice = chooseOrderColumn([
      { "Order # (shipment)": "77012345", "ORDER NUMBER": "RH354748" },
      { "Order # (shipment)": "77012346", "ORDER NUMBER": "RH354749" },
    ]);
    expect(choice.chosen).toBe("ORDER NUMBER");
    expect(choice.resolved).toBe(2);
  });

  it("picks the other column when that is the one carrying them", () => {
    const choice = chooseOrderColumn([
      { "Order # (shipment)": "RH354748", "ORDER NUMBER": "" },
    ]);
    expect(choice.chosen).toBe("Order # (shipment)");
  });

  it("chooses nothing when neither column carries an order name", () => {
    const choice = chooseOrderColumn([{ "Order # (shipment)": "77012345", "ORDER NUMBER": "" }]);
    expect(choice.chosen).toBeNull();
    expect(choice.resolved).toBe(0);
  });

  it("reports both candidates so the choice can be audited", () => {
    const choice = chooseOrderColumn([
      { "Order # (shipment)": "77012345", "ORDER NUMBER": "RH354748" },
    ]);
    expect(choice.candidates).toEqual([
      { column: "Order # (shipment)", present: 1, matching: 0 },
      { column: "ORDER NUMBER", present: 1, matching: 1 },
    ]);
  });

  // A shipment charge with no usable reference is the case that costs money
  // silently: its cost lands in no order and the line simply looks cheaper.
  it("counts shipment charges left without an order reference", () => {
    const choice = chooseOrderColumn([
      { "ORDER NUMBER": "RH354748", "Tracking # (shipment)": "94001" },
      { "ORDER NUMBER": "", "Tracking # (shipment)": "94002" },
    ]);
    expect(choice.resolved).toBe(1);
    expect(choice.unresolved).toBe(1);
  });

  it("records which column an order number came from", () => {
    const { rows } = parseThreeplChargeCsv(csv([shipping()]));
    expect(rows[0].orderNumberSource).toBe("ORDER NUMBER");
  });

  it("normalises case so the join is not defeated by it", () => {
    const { rows } = parseThreeplChargeCsv(csv([shipping({ "ORDER NUMBER": "rh354748" })]));
    expect(rows[0].orderNumber).toBe("RH354748");
  });

  it("accepts the -EXC exchange suffix that 6 live orders carry", () => {
    expect(ORDER_NUMBER_PATTERN.test("RH305038-EXC")).toBe(true);
  });
});

describe("parseMoneyToCents", () => {
  it("converts dollars to cents", () => {
    expect(parseMoneyToCents("6.42")).toBe(642);
  });

  it("strips currency symbols and thousands separators", () => {
    expect(parseMoneyToCents("$1,204.50")).toBe(120450);
  });

  it("reads parentheses as a credit", () => {
    expect(parseMoneyToCents("(12.00)")).toBe(-1200);
  });

  it("reads a leading minus as a credit", () => {
    expect(parseMoneyToCents("-12.00")).toBe(-1200);
  });

  // A blank amount and a zero amount need opposite handling, and collapsing
  // them is how "no recorded cost" becomes indistinguishable from "free" (#91).
  it("returns null for a blank, not zero", () => {
    expect(parseMoneyToCents(null)).toBeNull();
    expect(parseMoneyToCents("")).toBeNull();
  });

  it("keeps a genuine zero as zero", () => {
    expect(parseMoneyToCents("0.00")).toBe(0);
  });

  it("returns null for something that is not a number", () => {
    expect(parseMoneyToCents("n/a")).toBeNull();
  });

  it("rounds half-cents rather than truncating", () => {
    expect(parseMoneyToCents("0.005")).toBe(1);
  });
});

describe("parseNumber", () => {
  it("parses a quantity", () => {
    expect(parseNumber("31")).toBe(31);
  });

  it("returns null for a blank rather than zero", () => {
    expect(parseNumber("")).toBeNull();
  });

  it("keeps a genuine zero", () => {
    expect(parseNumber("0")).toBe(0);
  });
});

describe("labelCost", () => {
  const row = (over: Partial<{ billed: number | null; reconciled: number | null }>) =>
    ({
      billedLabelCostCents: over.billed ?? null,
      reconciledLabelCostCents: over.reconciled ?? null,
    }) as never;

  // Reconciled is what the carrier actually charged after weighing the parcel.
  it("prefers the reconciled cost and says so", () => {
    expect(labelCost(row({ billed: 642, reconciled: 711 }))).toEqual({
      cents: 711,
      basis: "reconciled",
    });
  });

  // Not every row is adjusted, so billed is normal rather than degraded — but
  // the caller is still told which figure it got.
  it("falls back to billed and names that basis", () => {
    expect(labelCost(row({ billed: 642 }))).toEqual({ cents: 642, basis: "billed" });
  });

  it("reports none rather than zero when neither is present", () => {
    expect(labelCost(row({}))).toEqual({ cents: null, basis: "none" });
  });

  it("does not treat a zero reconciled cost as missing", () => {
    expect(labelCost(row({ billed: 642, reconciled: 0 }))).toEqual({
      cents: 0,
      basis: "reconciled",
    });
  });
});
