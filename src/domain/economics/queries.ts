/**
 * Reads for the unit economics engine. No writes.
 *
 * Orders are joined to the landed cost of what was in them, which is the only
 * reason this needs a query layer at all — the arithmetic above it is pure.
 */

import { and, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rateSettings } from "@/db/schema";
import type { OrderForEconomics, RateSettings } from "./unit-economics";

/** The business lines #34 insists on keeping apart. */
export const BUSINESS_LINES = ["subscription", "digital", "physical"] as const;
export type BusinessLine = (typeof BUSINESS_LINES)[number];

/**
 * Product types that deliver nothing physical.
 *
 * `digital` and `subscription` are separated because their COD is similar but
 * their economics are not — a subscription bills repeatedly at a low ticket,
 * which is what makes the fixed payment fee dominate.
 */
const DIGITAL_TYPES = ["Pages", "Digital", "Font", "Class", "Activity Books"];

/**
 * Rendered as a SQL list rather than bound as a parameter: drizzle spreads a
 * JS array into separate placeholders, which `= ANY(...)` rejects.
 *
 * Safe to inline because this is a module constant, never caller input. The
 * quote-doubling is belt and braces so a type containing an apostrophe cannot
 * break the statement if someone adds one.
 */
const DIGITAL_TYPES_SQL = DIGITAL_TYPES.map((t) => `'${t.replace(/'/g, "''")}'`).join(", ");

/**
 * The rates in force on a date.
 *
 * Defaults are NOT applied here. A missing rate means the seed did not run,
 * and silently substituting 0.027 would produce a margin that looks computed
 * and is assumed.
 */
export async function getRateSettings(db: Db, on: string): Promise<RateSettings | null> {
  const rows = await db
    .select({ name: rateSettings.name, value: rateSettings.value })
    .from(rateSettings)
    .where(
      and(
        lte(rateSettings.effectiveFrom, on),
        or(isNull(rateSettings.effectiveTo), gte(rateSettings.effectiveTo, on))
      )
    );

  const byName = new Map(rows.map((r) => [r.name, r.value]));
  const pct = byName.get("payment_pct");
  const fixed = byName.get("payment_fixed_cents");
  if (pct === undefined || fixed === undefined) return null;

  const paymentPctRate = Number(pct);
  const paymentFixedCents = Number(fixed);
  if (!Number.isFinite(paymentPctRate) || !Number.isFinite(paymentFixedCents)) return null;

  return { paymentPctRate, paymentFixedCents };
}

export interface OrdersByLine {
  line: BusinessLine;
  orders: OrderForEconomics[];
}

/**
 * Orders in a window, split by business line, each carrying the landed cost of
 * its contents.
 *
 * `costIsKnown` is false when ANY line on the order lacks a recorded cost —
 * not when the sum happens to be zero. A partially-costed order produces a
 * partially-costed margin, and calling that measured would be the optimistic
 * direction.
 */
export async function getOrdersForEconomics(
  db: Db,
  startDate: string,
  endDate: string
): Promise<OrdersByLine[]> {
  const rows = (await db.execute(sql`
    WITH per_order AS (
      SELECT
        o.id,
        o.total_price_cents,
        COALESCE(o.total_tax_cents, 0) AS total_tax_cents,
        BOOL_OR(li.product_type = 'Subscription') AS has_subscription,
        BOOL_OR(li.product_type IS NOT NULL
                AND li.product_type NOT IN (${sql.raw(DIGITAL_TYPES_SQL)})
                AND li.product_type <> 'Subscription') AS has_physical,
        -- Cost of the goods, times quantity.
        COALESCE(SUM(inv.unit_cost_cents * li.quantity), 0) AS product_cost_cents,
        -- Every line has to have a cost for the order's cost to be known.
        BOOL_AND(inv.unit_cost_cents IS NOT NULL) AS cost_is_known
      FROM shopify_orders o
      JOIN shopify_line_items li ON li.order_id = o.id
      LEFT JOIN shopify_inventory inv ON inv.id = li.variant_id
      WHERE o.order_created_at >= ${startDate}::date
        AND o.order_created_at < (${endDate}::date + 1)
      GROUP BY o.id, o.total_price_cents, o.total_tax_cents
    )
    SELECT
      CASE
        WHEN has_subscription THEN 'subscription'
        WHEN has_physical THEN 'physical'
        ELSE 'digital'
      END AS line,
      total_price_cents, total_tax_cents, product_cost_cents, cost_is_known
    FROM per_order
  `)) as unknown as Array<{
    line: BusinessLine;
    total_price_cents: number;
    total_tax_cents: number;
    product_cost_cents: number;
    cost_is_known: boolean;
  }>;

  const byLine = new Map<BusinessLine, OrderForEconomics[]>(
    BUSINESS_LINES.map((l) => [l, []])
  );

  for (const r of rows) {
    byLine.get(r.line)?.push({
      totalPriceCents: Number(r.total_price_cents),
      totalTaxCents: Number(r.total_tax_cents),
      productCostCents: Number(r.product_cost_cents),
      costIsKnown: Boolean(r.cost_is_known),
    });
  }

  return [...byLine.entries()].map(([line, orders]) => ({ line, orders }));
}
