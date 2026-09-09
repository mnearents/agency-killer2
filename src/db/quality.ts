/**
 * Data quality — whether the synced data can answer the questions asked of it.
 *
 * Separate from freshness on purpose. Freshness asks "did the feed run?", and a
 * feed can run perfectly while delivering rows that no analysis can classify.
 * `product_type` blank on 2,114 line items arrived through a healthy sync and
 * sat unnoticed for a year, surfacing only during an argument about AOV.
 *
 * These checks are not thresholds to tune. Each one counts rows that are
 * definitely unusable for a specific question, so a non-zero count is a fact
 * rather than a judgement.
 */

import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { shopifyLineItems } from "./schema";

export interface RawQualityCheck {
  check: string;
  table: string;
  /** What breaks downstream when these rows are present. */
  detail: string;
  affected: number;
  /** Rows inspected. Zero means the check had nothing to look at. */
  total: number;
}

export type QualityStatus = "ok" | "issue" | "unknown";

export interface QualityCheckResult extends RawQualityCheck {
  status: QualityStatus;
  /** Null when there was no denominator — a count alone invites a wrong read. */
  affectedPct: number | null;
}

export function classifyQuality(checks: RawQualityCheck[]): QualityCheckResult[] {
  return checks.map((c) => {
    // An empty table is not a clean one. The query inspected nothing, so it has
    // no evidence either way, and reporting "ok" here would be a success signal
    // with no work behind it — indistinguishable from a check that really ran.
    if (c.total === 0) {
      return { ...c, status: "unknown" as const, affectedPct: null };
    }

    return {
      ...c,
      status: c.affected > 0 ? ("issue" as const) : ("ok" as const),
      affectedPct: Math.round((c.affected / c.total) * 1000) / 10,
    };
  });
}

/** True unless every check ran and found nothing. Unknown is never safe. */
export function anyQualityIssue(results: QualityCheckResult[]): boolean {
  return results.some((r) => r.status !== "ok");
}

/**
 * Exported so the predicates can be read off the generated SQL.
 *
 * "No product behind this row" is also written in
 * `analytics.shopify_line_items.revenue_line`, and the two must agree. A check
 * reporting 138 where the view classifies 137 sends whoever notices hunting a
 * data problem that is really two spellings of one rule.
 */
export function buildQualityQuery(db: Db) {
  return db
    .select({
      total: sql<number>`COUNT(*)`,
      // Empty string and NULL are different faults and are reported apart:
      // '' is a real product whose type was never set in Shopify, NULL is a
      // custom line with no product behind it at all.
      blankType: sql<number>`COUNT(*) FILTER (WHERE ${shopifyLineItems.productType} = '')`,
      // All three id columns, not variant_id alone. "Coloring Tie Fabric
      // Markers" has a null variant_id but a real product_id and product_type,
      // and the looser predicate reports a usable row as unusable.
      noProduct: sql<number>`COUNT(*) FILTER (WHERE ${shopifyLineItems.variantId} IS NULL AND ${shopifyLineItems.productId} IS NULL AND ${shopifyLineItems.sku} IS NULL)`,
    })
    .from(shopifyLineItems);
}

export async function getDataQuality(db: Db): Promise<QualityCheckResult[]> {
  const [lineItems] = await buildQualityQuery(db);

  const total = Number(lineItems?.total ?? 0);

  return classifyQuality([
    {
      check: "line items with a blank product_type",
      table: "shopify_line_items",
      detail:
        "Real products whose type was never set in Shopify. They cannot be split into physical vs digital revenue by product_type, and because the untyped products skew cheap, excluding them biases average order value upward.",
      affected: Number(lineItems?.blankType ?? 0),
      total,
    },
    {
      check: "line items with no product behind them",
      table: "shopify_line_items",
      detail:
        "Custom lines typed straight onto an order — no variant_id, product_id or sku. They are subscription plan changes, marketplace fees and test rows rather than products, so they belong in no product revenue line.",
      affected: Number(lineItems?.noProduct ?? 0),
      total,
    },
  ]);
}
