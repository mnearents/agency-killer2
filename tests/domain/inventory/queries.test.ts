import { describe, it, expect } from "vitest";
import { createDb } from "@/db/client";
import { buildInventoryItemsQuery, inventoryWindows } from "@/domain/inventory/queries";

// postgres-js connects lazily, so this never opens a socket — we only
// inspect the SQL the query builder generates.
const db = createDb("postgres://user:pass@localhost:5432/test");

const RECENT = new Date("2026-08-09T00:00:00Z");
const ANNUAL = new Date("2025-09-08T00:00:00Z");
const { sql, params } = buildInventoryItemsQuery(db, RECENT, ANNUAL).toSQL();

// Drizzle emits these as Date objects here and as ISO strings under tsx.
// Comparing the rendered form silently compares two locale strings that are
// equal for the wrong reason, so compare the instant.
const at = (i: number) => new Date(params[i] as string | Date).getTime();

describe("buildInventoryItemsQuery", () => {
  it("qualifies the variant id that sales are matched against", () => {
    // Unqualified, this is ambiguous against shopify_orders.id and
    // shopify_line_items.id, and Postgres rejects the whole query.
    expect(sql).toContain('"shopify_inventory"."id"');
  });

  it("emits no bare quoted id reference", () => {
    expect(sql).not.toMatch(/=\s*"id"(?!\w)/);
  });

  it("matches sales to variants by variant id", () => {
    expect(sql).toContain("variant_id");
  });

  it("bounds sales by the order date window", () => {
    expect(sql).toContain("order_created_at");
  });

  // Two windows out of one join: the recent rate drives days of cover, the
  // annual rate drives dated-edition stranding. A dated product is seasonal by
  // construction, so a thirty-day window projected across a December deadline
  // reads whichever month it ran in as if it were the whole year.
  it("aggregates a recent and an annual sales figure separately", () => {
    expect(sql).toContain("units_sold_annual");
    expect(sql).toMatch(/FILTER\s*\(\s*WHERE/i);
  });

  // The quiet failure this catches: both figures built from the same date, so
  // the annual total silently becomes a second copy of the thirty-day total
  // and every dated projection is wrong by 12x with nothing to show for it.
  // Asserted on the emitted parameters, because the SQL text looks correct in
  // exactly that case.
  it("binds two different dates, not the same one twice", () => {
    expect(params).toHaveLength(2);
    expect(new Set([at(0), at(1)]).size).toBe(2);
  });

  // Found by running this against production, not by any assertion here: a
  // Date interpolated into a raw sql`` template reaches postgres-js unchanged
  // and is rejected at bind time, while the same Date passed through gte() is
  // serialized. The two bounds travel by different routes, so they need
  // different handling, and nothing about the generated SQL text shows it.
  it("binds the filter date as a string, not a raw Date postgres cannot send", () => {
    expect(typeof params[0]).toBe("string");
  });

  // The FILTER must carry the RECENT bound and the join's WHERE the ANNUAL
  // one. Reversed, the join scans thirty days and the annual total is thirty
  // days over again.
  it("narrows the recent figure inside a scan of the wider window", () => {
    const filterBinding = sql.search(/FILTER\s*\(\s*WHERE[^)]*\$(\d)/i);
    expect(filterBinding).toBeGreaterThanOrEqual(0);
    expect(sql).toMatch(/FILTER\s*\(\s*WHERE[^)]*\$1\s*\)/i);
    expect(at(0)).toBe(RECENT.getTime());
    expect(at(1)).toBe(ANNUAL.getTime());
    expect(at(1)).toBeLessThan(at(0));
  });
});

describe("inventoryWindows", () => {
  const NOW = new Date("2026-09-08T00:00:00Z");

  it("looks back thirty days for the recent rate", () => {
    expect(inventoryWindows(NOW).since.toISOString()).toBe("2026-08-09T00:00:00.000Z");
  });

  it("looks back a year for the rate dated editions project on", () => {
    expect(inventoryWindows(NOW).sinceAnnual.toISOString()).toBe("2025-09-08T00:00:00.000Z");
  });

  // The mutation that survives everything else: one window built from the
  // other's constant. No error, no missing column, just every dated projection
  // wrong by a factor of twelve.
  it("does not collapse the two windows onto one date", () => {
    const { since, sinceAnnual } = inventoryWindows(NOW);
    expect(sinceAnnual.getTime()).toBeLessThan(since.getTime());
    expect(since.getTime() - sinceAnnual.getTime()).toBeGreaterThan(300 * 24 * 3600 * 1000);
  });
});
