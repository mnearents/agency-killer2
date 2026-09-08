/**
 * Fitness tests over analytics.shopify_line_items.
 *
 * Kept apart from analytics-views.test.ts on purpose: that file and this one
 * are developed on separate branches, and a merge conflict inside a single
 * describe-list is resolved by deleting one side — which is a test that
 * silently stops running.
 *
 * Asserted against the LAST definition of the view across all migrations, so a
 * later migration that recreates it without the classification goes red.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.join(process.cwd(), "src/db/migrations");

function allMigrationSql(): string {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n");
}

function latestViewBody(view: string): string {
  const matches = [
    ...allMigrationSql().matchAll(
      new RegExp(`CREATE VIEW ${view.replace(".", "\\.")} AS([\\s\\S]*?);`, "g")
    ),
  ];
  if (matches.length === 0) throw new Error(`no CREATE VIEW found for ${view}`);
  return matches[matches.length - 1][1];
}

function latestColumnComment(column: string): string {
  const matches = [
    ...allMigrationSql().matchAll(
      new RegExp(`COMMENT ON COLUMN ${column.replace(/\./g, "\\.")} IS([\\s\\S]*?);`, "g")
    ),
  ];
  if (matches.length === 0) throw new Error(`no COMMENT ON COLUMN found for ${column}`);
  return matches[matches.length - 1][1];
}

describe("analytics.shopify_line_items revenue_line", () => {
  const body = () => latestViewBody("analytics.shopify_line_items");

  // The three-part key is the point. variant_id alone admits one real product
  // ("Coloring Tie Fabric Markers") that carries a product_id and a type, and
  // booking a real product as non-product is the same class of error in the
  // other direction.
  it("keys non_product on the absence of variant_id, product_id AND sku", () => {
    expect(body()).toMatch(
      /variant_id\s+IS\s+NULL[\s\S]{0,80}product_id\s+IS\s+NULL[\s\S]{0,80}sku\s+IS\s+NULL/i
    );
  });

  it("exposes revenue_line so a split never has to re-derive the rule", () => {
    expect(body()).toMatch(/AS\s+revenue_line/);
  });

  it("labels everything with a product behind it as product", () => {
    expect(body()).toMatch(/'product'/);
  });

  // Titles are an ongoing feed. "RAD Studio Upgrade: ... (june 2026 prorated)"
  // becomes a November title nobody wrote a pattern for, and the row silently
  // rejoins product revenue. Nothing here may depend on a title.
  it("classifies without reading title, which is an uncontrolled feed", () => {
    const classification = body().slice(body().indexOf("revenue_line") - 600);
    expect(classification).not.toMatch(/l\.title/);
    expect(body()).not.toMatch(/title\s+(I?LIKE|~|SIMILAR)/i);
  });

  it("marks negative non-product lines as a marketplace fee, not revenue", () => {
    expect(body()).toMatch(/price_cents\s*<\s*0[\s\S]{0,60}'marketplace_fee'/i);
  });

  // Matt's spec: report the residue rather than assign it. An unnamed bucket
  // gets read as zero; a named one gets read as work outstanding.
  it("names the residue unclassified instead of assigning it a revenue line", () => {
    expect(body()).toMatch(/'unclassified'/);
  });

  it("leaves non_product_kind null for products, so the flag is unambiguous", () => {
    expect(body()).toMatch(/AS\s+non_product_kind/);
  });

  it("keeps the columns 0016 added, which a bare recreate would drop", () => {
    for (const col of [
      "variant_title",
      "vendor",
      "total_discount_cents",
      "requires_shipping",
      "net_revenue_cents",
    ]) {
      expect(body()).toContain(col);
    }
  });
});

describe("analytics.shopify_line_items documentation", () => {
  it("records that test data is NOT identifiable, so nobody reads unclassified as clean", () => {
    const comment = latestColumnComment("analytics.shopify_line_items.non_product_kind");
    expect(comment).toMatch(/test/i);
    expect(comment).toMatch(/unclassified/i);
  });

  // The Seal test- tags are marketing cohorts on 42,107 of 54,225 orders. The
  // next person to reach for them needs the number, not a warning.
  it("names the Seal test- tags as cohort tags so they are not reused as a test flag", () => {
    const comment = latestColumnComment("analytics.shopify_line_items.non_product_kind");
    expect(comment).toMatch(/42,107/);
  });

  it("records the Studio upgrade revenue this deliberately leaves out", () => {
    const comment = latestColumnComment("analytics.shopify_line_items.revenue_line");
    expect(comment).toMatch(/1,908/);
  });
});
