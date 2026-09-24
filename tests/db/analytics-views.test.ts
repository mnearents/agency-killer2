/**
 * Fitness tests over the analytics view definitions.
 *
 * These views are the MCP `query` tool's whole surface. A wrong number here is
 * not caught by any other test: the tool faithfully returns whatever the view
 * says, and the domain code that guards the same data (classifyItem's ACTIVE
 * filter) is bypassed entirely by raw SQL.
 *
 * Asserted against the LAST definition of each view across all migrations, so
 * a later migration that recreates one without its filters goes red.
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

function latestViewComment(view: string): string {
  const matches = [
    ...allMigrationSql().matchAll(
      new RegExp(`COMMENT ON VIEW ${view.replace(".", "\\.")} IS([\\s\\S]*?);`, "g")
    ),
  ];
  if (matches.length === 0) throw new Error(`no COMMENT ON VIEW found for ${view}`);
  return matches[matches.length - 1][1];
}

describe("analytics.shopify_inventory", () => {
  it("excludes non-ACTIVE products, which are retired stock counted again", () => {
    expect(latestViewBody("analytics.shopify_inventory")).toMatch(
      /product_status\s*=\s*'ACTIVE'/
    );
  });

  it("excludes untracked variants, whose quantity is sentinel or negative noise", () => {
    expect(latestViewBody("analytics.shopify_inventory")).toMatch(/tracked\s*=\s*1/);
  });

  it("documents both distortions so the exclusion is not mistaken for a bug", () => {
    const comment = latestViewComment("analytics.shopify_inventory");
    expect(comment).toMatch(/untracked/i);
    expect(comment).toMatch(/ACTIVE/);
  });

  // unit_cost_cents was synced all along and absent from the view, so no
  // column matching '%cost%' existed anywhere in the analytics schema and
  // margin was unanswerable from SQL.
  it("exposes unit cost, so margin is computable", () => {
    expect(latestViewBody("analytics.shopify_inventory")).toMatch(/unit_cost_cents/);
  });

  // Media Mail is priced per pound with no zones, so weight is a direct input
  // to per-SKU contribution.
  it("exposes a normalised weight in pounds", () => {
    expect(latestViewBody("analytics.shopify_inventory")).toMatch(/weight_lb/);
  });

  // A margin computed over partial cost data is a floor, and the comment is
  // the only place a SQL caller will learn that.
  it("says cost coverage is partial and the margin is a floor", () => {
    const comment = latestViewComment("analytics.shopify_inventory");
    expect(comment).toMatch(/COVERAGE IS PARTIAL/i);
    expect(comment).toMatch(/FLOOR/i);
  });

  // gross_margin_rate excludes postage, pick and pack, storage, returns and
  // processing. A SKU at 0.6 there is not 60% contribution.
  it("says the margin column is product margin only", () => {
    expect(latestColumnComment("analytics.shopify_inventory.gross_margin_rate"))
      .toMatch(/PRODUCT margin only/);
  });
});

describe("analytics.shopify_orders", () => {
  it("exposes is_recurring_reliable, so the flag cannot be trusted by default", () => {
    expect(latestViewBody("analytics.shopify_orders")).toMatch(
      /AS\s+is_recurring_reliable/
    );
  });

  it("dates the reliable window from the 2026-06-01 billing cycle", () => {
    expect(latestViewBody("analytics.shopify_orders")).toMatch(/2026-06-01/);
  });

  it("omits the utm columns, which are null on every order", () => {
    const body = latestViewBody("analytics.shopify_orders");
    for (const col of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
      expect(body).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it("records that the cutover is a real billing day, not a migration dump", () => {
    const comment = latestColumnComment(
      "analytics.shopify_orders.is_recurring_reliable"
    );
    expect(comment).toMatch(/billing day/i);
    expect(comment).toMatch(/coverage/i);
  });

  it("documents the is_recurring undercount and the missing attribution", () => {
    const comment = latestViewComment("analytics.shopify_orders");
    expect(comment).toMatch(/2026-06-01/);
    expect(comment).toMatch(/is_recurring/);
    expect(comment).toMatch(/utm/i);
  });
});
