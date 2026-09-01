import { describe, it, expect } from "vitest";
import { createDb } from "@/db/client";
import { buildInventoryItemsQuery } from "@/domain/inventory/queries";

// postgres-js connects lazily, so this never opens a socket — we only
// inspect the SQL the query builder generates.
const db = createDb("postgres://user:pass@localhost:5432/test");

const { sql } = buildInventoryItemsQuery(db, new Date("2026-08-02T00:00:00Z")).toSQL();

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
});
