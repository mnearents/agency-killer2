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

  it("documents the is_recurring undercount and the missing attribution", () => {
    const comment = latestViewComment("analytics.shopify_orders");
    expect(comment).toMatch(/2026-06-01/);
    expect(comment).toMatch(/is_recurring/);
    expect(comment).toMatch(/utm/i);
  });
});
