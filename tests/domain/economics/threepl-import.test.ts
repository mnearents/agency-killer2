import { describe, it, expect } from "vitest";
import { planThreeplImport, planRecurringCost } from "@/domain/economics/threepl-import";
import { parseThreeplChargeCsv } from "@/domain/economics/parse-threepl-csv";

const HEADER =
  "Date (charge),Category (charge),Fee (charge),Total (charge)," +
  "Order # (shipment),Tracking # (shipment),Bill # (bill),Period start (bill),Period end (bill)," +
  "Billed label cost (label reconciliation),Reconciled label cost (label reconciliation),ORDER NUMBER";

interface RowSpec {
  date?: string; category?: string; fee?: string; total?: string;
  order?: string; tracking?: string; bill?: string;
  start?: string; end?: string; billed?: string; reconciled?: string;
}

function csv(specs: RowSpec[]): string {
  const lines = [HEADER];
  for (const s of specs) {
    lines.push([
      s.date ?? "2026-08-25", s.category ?? "order", s.fee ?? "STANDARD PICK FEE",
      s.total ?? "1.10", s.order ?? "", s.tracking ?? "", s.bill ?? "720698",
      s.start ?? "2026-08-22", s.end ?? "2026-09-04", s.billed ?? "", s.reconciled ?? "", "",
    ].join(","));
  }
  return lines.join("\n");
}

const plan = (specs: RowSpec[], known: string[] = [], existingRowCount = 0) =>
  planThreeplImport({ parsed: parseThreeplChargeCsv(csv(specs)), knownOrderNumbers: known, existingRowCount });

describe("planThreeplImport", () => {
  it("plans one insert per charge row", () => {
    const result = plan([{ order: "RH354748" }, { order: "RH354749" }], ["RH354748", "RH354749"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.values).toHaveLength(2);
  });

  it("totals the bill in cents", () => {
    const result = plan([{ total: "1.10", order: "RH354748" }, { total: "385.26", order: "RH354748" }], ["RH354748"]);
    if (result.ok) expect(result.plan.result.totalCents).toBe(38636);
  });

  it("summarises by category, largest first", () => {
    const result = plan(
      [{ category: "order", total: "1.10", order: "RH354748" }, { category: "storage", total: "385.26" }],
      ["RH354748"],
    );
    if (result.ok) {
      expect(result.plan.result.byCategory[0]).toEqual({ category: "storage", rows: 1, cents: 38526 });
    }
  });

  // A bill whose references match nothing still imports cleanly and leaves
  // every charge attributed to no order — downstream that reads as a line
  // that cost nothing to fulfil, not as a broken import.
  it("refuses a bill whose order references match nothing", () => {
    const result = plan([{ order: "RH999999", tracking: "94001" }], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exist in shopify_orders/);
  });

  it("names unmatched references in the refusal, so a systematic mismatch is diagnosable", () => {
    const result = plan([{ order: "RH999999" }], []);
    if (!result.ok) expect(result.error).toContain("RH999999");
  });

  it("imports when some references match, and warns about the rest", () => {
    const result = plan([{ order: "RH354748" }, { order: "RH999999" }], ["RH354748"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.result.orders).toEqual({
        referenced: 2, matched: 1, unmatchedExamples: ["RH999999"],
      });
      expect(result.plan.result.warnings.join(" ")).toMatch(/not in shopify_orders/);
    }
  });

  // Storage-only bills reference no orders at all; that is not a failure.
  it("accepts a bill that references no orders", () => {
    const result = plan([{ category: "storage", total: "385.26" }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.result.orders.referenced).toBe(0);
  });

  it("refuses an export with no bill number, which could not be replaced safely", () => {
    const result = plan([{ bill: "", order: "RH354748" }], ["RH354748"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No bill number/);
  });

  it("refuses an export covering more than one bill", () => {
    const result = plan([{ bill: "720698" }, { bill: "720699" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/covers 2 bills/);
  });

  it("reports how many rows a re-import replaces", () => {
    const result = plan([{ order: "RH354748" }], ["RH354748"], 201);
    if (result.ok) expect(result.plan.result.replaced).toBe(201);
  });

  // Postage is the largest component of physical COD, and a bill without it
  // looks complete.
  it("warns when no row carries a carrier label cost", () => {
    const result = plan([{ order: "RH354748", tracking: "94001" }], ["RH354748"]);
    if (result.ok) {
      expect(result.plan.result.warnings.join(" ")).toMatch(/handling only/);
    }
  });

  it("does not warn about postage when a label cost is present", () => {
    const result = plan([{ order: "RH354748", billed: "6.42" }], ["RH354748"]);
    if (result.ok) {
      expect(result.plan.result.warnings.join(" ")).not.toMatch(/handling only/);
    }
  });

  it("surfaces recurring charges as candidates for recurring_costs", () => {
    const result = plan(
      [{ category: "recurring", fee: "API CONNECTION", total: "125.00" }, { order: "RH354748" }],
      ["RH354748"],
    );
    if (result.ok) {
      expect(result.plan.result.recurringFound).toEqual([{ fee: "API CONNECTION", cents: 12500 }]);
    }
  });

  it("carries the resolved order number onto the row it will insert", () => {
    const result = plan([{ order: "RH354748" }], ["RH354748"]);
    if (result.ok) expect(result.plan.values[0].orderNumber).toBe("RH354748");
  });

  // Two identical pick fees on one order are two charges, not a duplicate.
  it("gives repeated identical charge lines distinct ids", () => {
    const spec = { order: "RH354748", total: "1.10" };
    const result = plan([spec, spec], ["RH354748"]);
    if (result.ok) {
      expect(result.plan.values[0].id).not.toBe(result.plan.values[1].id);
    }
  });

  it("scopes every row id to the bill, so bills cannot collide", () => {
    const result = plan([{ order: "RH354748" }], ["RH354748"]);
    if (result.ok) expect(result.plan.values[0].id.startsWith("720698:")).toBe(true);
  });

  it("is deterministic — the same export plans the same ids twice", () => {
    const a = plan([{ order: "RH354748" }], ["RH354748"]);
    const b = plan([{ order: "RH354748" }], ["RH354748"]);
    if (a.ok && b.ok) expect(a.plan.values[0].id).toBe(b.plan.values[0].id);
  });
});

describe("planRecurringCost", () => {
  const input = { name: "API CONNECTION", amountCents: 12500, effectiveFrom: "2026-08-22", cadence: "per_bill_period" };

  it("opens a row the first time a cost is seen", () => {
    const p = planRecurringCost(undefined, input);
    expect(p.action).toBe("opened");
    expect(p.closeId).toBeNull();
    expect(p.insert?.amountCents).toBe(12500);
  });

  // Re-importing the same bill must not stack duplicate rows.
  it("does nothing when the amount is unchanged", () => {
    const p = planRecurringCost({ id: "x", amountCents: 12500 }, input);
    expect(p.action).toBe("unchanged");
    expect(p.insert).toBeNull();
    expect(p.closeId).toBeNull();
  });

  // Editing in place would restate history: a margin computed for March has
  // to use March's costs.
  it("closes the old row and opens a new one when the amount moves", () => {
    const p = planRecurringCost({ id: "old", amountCents: 10000 }, input);
    expect(p.action).toBe("changed");
    expect(p.closeId).toBe("old");
    expect(p.previousCents).toBe(10000);
    expect(p.insert?.effectiveFrom).toBe("2026-08-22");
  });

  it("marks a cost the importer found as coming from the 3PL, not a human", () => {
    expect(planRecurringCost(undefined, input).insert?.source).toBe("threepl");
  });
});
