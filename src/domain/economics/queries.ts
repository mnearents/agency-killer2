/**
 * Reads for the unit economics engine. No writes.
 *
 * Orders are joined to the landed cost of what was in them, which is the only
 * reason this needs a query layer at all — the arithmetic above it is pure.
 */

import { and, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { metaInsights, rateSettings } from "@/db/schema";
import type { OrderForEconomics, RateSettings } from "./unit-economics";
import { classifyBusinessLine, type OrderLineFacts } from "./classify";

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


/**
 * The row's four classifier flags, as the pure rule wants them.
 *
 * The rule lives in `classify.ts` rather than in a SQL CASE so that it can be
 * tested — the query counts, the rule decides.
 *
 * Exported for that test. A misspelled key here reads as `undefined`, which is
 * falsy, so a typo in `has_tracked_inventory` would quietly move every physical
 * order into digital and nothing else would change.
 */
export function lineOf(r: {
  has_subscription_type: boolean;
  has_untyped_without_inventory: boolean;
  has_tracked_inventory: boolean;
  has_known_physical_type: boolean;
}): BusinessLine {
  const facts: OrderLineFacts = {
    hasSubscriptionType: Boolean(r.has_subscription_type),
    hasUntypedWithoutInventory: Boolean(r.has_untyped_without_inventory),
    hasTrackedInventory: Boolean(r.has_tracked_inventory),
    hasKnownPhysicalType: Boolean(r.has_known_physical_type),
  };
  return classifyBusinessLine(facts);
}

export interface OrdersByLine {
  line: BusinessLine;
  orders: OrderForEconomics[];
}

/**
 * Orders in a window, split by business line, each carrying the landed cost of
 * its contents.
 *
 * Cost coverage is carried per line, not per order: `lineRevenueCents` is what
 * the line items came to and `costedLineRevenueCents` is the part of it whose
 * variant has a landed cost. An order with one uncosted line used to count as
 * wholly uncosted, which reported 71.6% coverage against production where
 * 89.8% of line revenue was costed.
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
        BOOL_OR(li.product_type = 'Subscription') AS has_subscription_type,
        -- Never a product: a plan change, a proration, a subscription gift.
        BOOL_OR(li.product_type IS NULL AND inv.id IS NULL) AS has_untyped_without_inventory,
        -- Only a physical thing has a stock count, which is why this outranks
        -- a blank product_type on 1,742 line items. See #43.
        BOOL_OR(inv.tracked = 1) AS has_tracked_inventory,
        BOOL_OR(li.product_type IS NOT NULL
                AND li.product_type <> ''
                AND li.product_type NOT IN (${sql.raw(DIGITAL_TYPES_SQL)})
                AND li.product_type <> 'Subscription') AS has_known_physical_type,
        -- Cost of the goods, times quantity.
        COALESCE(SUM(inv.unit_cost_cents * li.quantity), 0) AS product_cost_cents,
        -- Coverage is measured over line revenue, so a partly-costed order
        -- contributes the part that is costed rather than nothing at all.
        COALESCE(SUM(li.price_cents * li.quantity), 0) AS line_revenue_cents,
        COALESCE(SUM(CASE WHEN inv.unit_cost_cents IS NOT NULL
                          THEN li.price_cents * li.quantity ELSE 0 END), 0)
          AS costed_line_revenue_cents
      FROM shopify_orders o
      JOIN shopify_line_items li ON li.order_id = o.id
      LEFT JOIN shopify_inventory inv ON inv.id = li.variant_id
      WHERE o.order_created_at >= ${startDate}::date
        AND o.order_created_at < (${endDate}::date + 1)
      GROUP BY o.id, o.total_price_cents, o.total_tax_cents
    )
    SELECT
      has_subscription_type, has_untyped_without_inventory,
      has_tracked_inventory, has_known_physical_type,
      total_price_cents, total_tax_cents, product_cost_cents,
      line_revenue_cents, costed_line_revenue_cents
    FROM per_order
  `)) as unknown as Array<{
    has_subscription_type: boolean;
    has_untyped_without_inventory: boolean;
    has_tracked_inventory: boolean;
    has_known_physical_type: boolean;
    total_price_cents: number;
    total_tax_cents: number;
    product_cost_cents: number;
    line_revenue_cents: number;
    costed_line_revenue_cents: number;
  }>;

  const byLine = new Map<BusinessLine, OrderForEconomics[]>(
    BUSINESS_LINES.map((l) => [l, []])
  );

  for (const r of rows) {
    byLine.get(lineOf(r))?.push({
      totalPriceCents: Number(r.total_price_cents),
      totalTaxCents: Number(r.total_tax_cents),
      productCostCents: Number(r.product_cost_cents),
      lineRevenueCents: Number(r.line_revenue_cents),
      costedLineRevenueCents: Number(r.costed_line_revenue_cents),
    });
  }

  return [...byLine.entries()].map(([line, orders]) => ({ line, orders }));
}


/**
 * ─── aMER inputs ──────────────────────────────────────────────────────
 */

/**
 * The ad channels whose spend is in the warehouse.
 *
 * Meta is the only one. That is a fact about our data, not about the business,
 * and the tool says so — a caller asking for "all channels" must not read the
 * answer as covering Google or TikTok simply because nothing said otherwise.
 */
export const AD_CHANNELS = ["meta"] as const;
export type AdChannel = (typeof AD_CHANNELS)[number];

export interface AdSpend {
  channel: AdChannel;
  spendCents: number;
  /** Days in the window with any delivery. Zero of N is a real answer. */
  daysWithSpend: number;
}

/**
 * Ad spend per channel over a window.
 *
 * Every channel in scope is returned, including one that spent nothing. An
 * absent channel reads as "we do not track it"; a channel with zero reads as
 * "it did not run", and those lead to opposite conclusions.
 */
export async function getAdSpend(
  db: Db,
  startDate: string,
  endDate: string,
  channel?: AdChannel
): Promise<AdSpend[]> {
  const wanted = channel ? [channel] : [...AD_CHANNELS];
  const out: AdSpend[] = [];

  if (wanted.includes("meta")) {
    const [row] = (await db.execute(sql`
      SELECT COALESCE(SUM(spend_cents), 0) AS spend_cents,
             COUNT(DISTINCT date::date) AS days_with_spend
      FROM ${metaInsights}
      WHERE date >= ${startDate}::date AND date < (${endDate}::date + 1)
    `)) as unknown as Array<{ spend_cents: number; days_with_spend: number }>;
    out.push({
      channel: "meta",
      spendCents: Number(row?.spend_cents ?? 0),
      daysWithSpend: Number(row?.days_with_spend ?? 0),
    });
  }

  return out;
}

export interface NewCustomerOrders {
  byLine: OrdersByLine[];
  /**
   * Orders whose customer's lifetime order count is unknown, so whether the
   * order was a first cannot be decided. Never folded into either side.
   */
  undecidableOrders: number;
}

/**
 * First-ever orders placed in a window, split by business line.
 *
 * "First-ever" is not "earliest order we hold". Order history begins
 * 2025-07-22 and 34,415 customers bought only before that, so the earliest
 * held order is routinely a repeat purchase. Shopify's own `orders_count` is
 * the lifetime figure, and a customer whose lifetime count equals the number
 * of orders we hold is one whose whole history is in the warehouse — for them,
 * and only them, the earliest held order is the first one.
 *
 * Against production that is 1,933 of the 8,567 customers with an order in the
 * window; the other 6,634 have orders we do not hold and were already
 * customers. A customer with no lifetime count at all is undecidable and is
 * counted separately rather than assumed either way.
 */
export async function getNewCustomerOrders(
  db: Db,
  startDate: string,
  endDate: string
): Promise<NewCustomerOrders> {
  const rows = (await db.execute(sql`
    WITH held AS (
      SELECT customer_id, COUNT(*) AS held_orders, MIN(order_created_at) AS first_held
      FROM shopify_orders
      WHERE customer_id IS NOT NULL
      GROUP BY customer_id
    ),
    first_orders AS (
      SELECT o.id,
             -- NULL when Shopify's lifetime count is missing: undecidable, not new.
             CASE WHEN c.orders_count IS NULL THEN NULL
                  ELSE c.orders_count = h.held_orders END AS whole_history_held
      FROM shopify_orders o
      JOIN held h ON h.customer_id = o.customer_id AND h.first_held = o.order_created_at
      JOIN shopify_customers c ON c.id = o.customer_id
      WHERE o.order_created_at >= ${startDate}::date
        AND o.order_created_at < (${endDate}::date + 1)
    ),
    per_order AS (
      SELECT
        o.id,
        o.total_price_cents,
        COALESCE(o.total_tax_cents, 0) AS total_tax_cents,
        BOOL_OR(li.product_type = 'Subscription') AS has_subscription_type,
        -- Never a product: a plan change, a proration, a subscription gift.
        BOOL_OR(li.product_type IS NULL AND inv.id IS NULL) AS has_untyped_without_inventory,
        -- Only a physical thing has a stock count, which is why this outranks
        -- a blank product_type on 1,742 line items. See #43.
        BOOL_OR(inv.tracked = 1) AS has_tracked_inventory,
        BOOL_OR(li.product_type IS NOT NULL
                AND li.product_type <> ''
                AND li.product_type NOT IN (${sql.raw(DIGITAL_TYPES_SQL)})
                AND li.product_type <> 'Subscription') AS has_known_physical_type,
        COALESCE(SUM(inv.unit_cost_cents * li.quantity), 0) AS product_cost_cents,
        COALESCE(SUM(li.price_cents * li.quantity), 0) AS line_revenue_cents,
        COALESCE(SUM(CASE WHEN inv.unit_cost_cents IS NOT NULL
                          THEN li.price_cents * li.quantity ELSE 0 END), 0)
          AS costed_line_revenue_cents,
        fo.whole_history_held
      FROM first_orders fo
      JOIN shopify_orders o ON o.id = fo.id
      JOIN shopify_line_items li ON li.order_id = o.id
      LEFT JOIN shopify_inventory inv ON inv.id = li.variant_id
      GROUP BY o.id, o.total_price_cents, o.total_tax_cents, fo.whole_history_held
    )
    SELECT
      has_subscription_type, has_untyped_without_inventory,
      has_tracked_inventory, has_known_physical_type,
      total_price_cents, total_tax_cents, product_cost_cents,
      line_revenue_cents, costed_line_revenue_cents,
      whole_history_held
    FROM per_order
  `)) as unknown as Array<{
    has_subscription_type: boolean;
    has_untyped_without_inventory: boolean;
    has_tracked_inventory: boolean;
    has_known_physical_type: boolean;
    total_price_cents: number;
    total_tax_cents: number;
    product_cost_cents: number;
    line_revenue_cents: number;
    costed_line_revenue_cents: number;
    whole_history_held: boolean | null;
  }>;

  const byLine = new Map<BusinessLine, OrderForEconomics[]>(
    BUSINESS_LINES.map((l) => [l, []])
  );
  let undecidableOrders = 0;

  for (const r of rows) {
    if (r.whole_history_held === null) {
      undecidableOrders++;
      continue;
    }
    if (!r.whole_history_held) continue;
    byLine.get(lineOf(r))?.push({
      totalPriceCents: Number(r.total_price_cents),
      totalTaxCents: Number(r.total_tax_cents),
      productCostCents: Number(r.product_cost_cents),
      lineRevenueCents: Number(r.line_revenue_cents),
      costedLineRevenueCents: Number(r.costed_line_revenue_cents),
    });
  }

  return {
    byLine: [...byLine.entries()].map(([line, orders]) => ({ line, orders })),
    undecidableOrders,
  };
}
