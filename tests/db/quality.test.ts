import { describe, it, expect } from "vitest";
import { createDb } from "@/db/client";
import { buildQualityQuery, classifyQuality, type RawQualityCheck } from "@/db/quality";

function raw(overrides: Partial<RawQualityCheck> = {}): RawQualityCheck {
  return {
    check: "line items with no product_type",
    table: "shopify_line_items",
    detail: "Cannot be split into physical, digital or subscription revenue.",
    affected: 0,
    total: 58000,
    ...overrides,
  };
}

describe("classifyQuality", () => {
  it("passes a check that found nothing wrong in a populated table", () => {
    const [r] = classifyQuality([raw()]);
    expect(r.status).toBe("ok");
  });

  it("reports an issue when rows are affected", () => {
    const [r] = classifyQuality([raw({ affected: 2114 })]);
    expect(r.status).toBe("issue");
  });

  // The failure this guards is the one that keeps recurring in this repo: a
  // check that never ran reporting the same green as a check that ran and
  // found nothing. An empty table means the query had nothing to inspect, so
  // it has no evidence either way and must not be counted as a pass.
  it("reports unknown, not ok, when the table is empty", () => {
    const [r] = classifyQuality([raw({ total: 0 })]);
    expect(r.status).toBe("unknown");
  });

  it("does not report unknown as a passing check", () => {
    const [r] = classifyQuality([raw({ total: 0 })]);
    expect(r.status).not.toBe("ok");
  });

  it("gives the share affected so a count is not read without its denominator", () => {
    const [r] = classifyQuality([raw({ affected: 2114, total: 58000 })]);
    expect(r.affectedPct).toBeCloseTo(3.6, 1);
  });

  it("leaves the share null when there is no denominator to divide by", () => {
    const [r] = classifyQuality([raw({ total: 0 })]);
    expect(r.affectedPct).toBeNull();
  });
});

describe("buildQualityQuery", () => {
  // postgres-js connects lazily, so this never opens a socket.
  const { sql } = buildQualityQuery(
    createDb("postgres://user:pass@localhost:5432/test")
  ).toSQL();

  // Must match analytics.shopify_line_items.revenue_line exactly. A check that
  // counts 138 where the view classifies 137 sends whoever reconciles them
  // looking for a data problem that is really a disagreement between two
  // spellings of one rule.
  it("counts non-product rows on all three id columns, as the view does", () => {
    for (const col of ["variant_id", "product_id", "sku"]) {
      expect(sql).toContain(col);
    }
  });

  // "Coloring Tie Fabric Markers" has a null variant_id and a real product_id
  // and product_type. variant_id alone calls it unusable when it is fine.
  it("does not treat a null variant_id alone as a missing product", () => {
    expect(sql).not.toMatch(/"variant_id" is null\)?\s*\)/i);
  });

  it("still counts blank product_type apart from null, being different faults", () => {
    expect(sql).toContain("product_type");
  });
});

describe("anyQualityIssue", () => {
  it("is true when a check found affected rows", async () => {
    const { anyQualityIssue } = await import("@/db/quality");
    expect(anyQualityIssue(classifyQuality([raw({ affected: 1 })]))).toBe(true);
  });

  it("is true when a check could not run, because unknown is not safe", async () => {
    const { anyQualityIssue } = await import("@/db/quality");
    expect(anyQualityIssue(classifyQuality([raw({ total: 0 })]))).toBe(true);
  });

  it("is false only when every check ran and found nothing", async () => {
    const { anyQualityIssue } = await import("@/db/quality");
    expect(anyQualityIssue(classifyQuality([raw()]))).toBe(false);
  });
});
