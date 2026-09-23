/**
 * Reads over the fulfilment cost tables (#34).
 *
 * Three facts shape every function here, and each is a way the numbers can
 * mislead if it is not carried alongside them:
 *
 * 1. **Postage is only known for some shipments.** Labels billed to the DHL
 *    eCommerce account export at $0.00 and are stored NULL. Any sum over
 *    `label_cost_cents` is a sum over the shipments that have one, so every
 *    return here reports coverage next to the total.
 * 2. **The charge ledger is not the whole bill.** It itemises handling and
 *    omits postage, which sits in the invoice's `Order charges` line. A period
 *    total from `threepl_charges` alone understates what was invoiced.
 * 3. **Only some periods have been imported.** A month with no bill loaded
 *    looks exactly like a month that cost nothing, so the periods actually
 *    held are returned rather than assumed.
 */

import { sql, and, gte, lte, isNotNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { threeplCharges, threeplShipments, recurringCosts } from "@/db/schema";

export interface ChargePeriod {
  billNumber: string;
  periodStart: string | null;
  periodEnd: string | null;
  rows: number;
  totalCents: number;
}

/** Which bills are loaded. A month with no bill is not a cheap month. */
export async function getChargePeriods(db: Db): Promise<ChargePeriod[]> {
  const rows = await db
    .select({
      billNumber: threeplCharges.billNumber,
      periodStart: sql<string | null>`min(${threeplCharges.periodStart})::text`,
      periodEnd: sql<string | null>`max(${threeplCharges.periodEnd})::text`,
      rows: sql<number>`count(*)::int`,
      totalCents: sql<number>`coalesce(sum(${threeplCharges.totalCents}), 0)::int`,
    })
    .from(threeplCharges)
    .groupBy(threeplCharges.billNumber)
    .orderBy(sql`min(${threeplCharges.periodStart})`);
  return rows;
}

export interface ChargeBreakdown {
  category: string;
  fee: string;
  rows: number;
  totalCents: number;
}

export async function getChargeBreakdown(
  db: Db,
  range?: { from: string; to: string },
): Promise<ChargeBreakdown[]> {
  const where = range
    ? and(gte(threeplCharges.chargeDate, range.from), lte(threeplCharges.chargeDate, range.to))
    : undefined;

  return db
    .select({
      category: sql<string>`coalesce(${threeplCharges.category}, '(none)')`,
      fee: sql<string>`coalesce(${threeplCharges.fee}, '(none)')`,
      rows: sql<number>`count(*)::int`,
      totalCents: sql<number>`coalesce(sum(${threeplCharges.totalCents}), 0)::int`,
    })
    .from(threeplCharges)
    .where(where)
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`coalesce(sum(${threeplCharges.totalCents}), 0) desc`);
}

export interface PostageByMethod {
  shippingMethod: string;
  shipments: number;
  /** Shipments whose postage the 3PL billed, so we know it. */
  billed: number;
  /** Shipments billed to an account we cannot see. Cost unknown, not zero. */
  unbilled: number;
  knownCostCents: number;
  chargedCents: number;
  avgWeightLb: number | null;
}

export async function getPostageByMethod(
  db: Db,
  range?: { from: string; to: string },
): Promise<PostageByMethod[]> {
  const where = range
    ? and(gte(threeplShipments.createdAt, range.from), lte(threeplShipments.createdAt, range.to))
    : undefined;

  return db
    .select({
      shippingMethod: sql<string>`coalesce(${threeplShipments.shippingMethod}, '(none)')`,
      shipments: sql<number>`count(*)::int`,
      billed: sql<number>`count(*) filter (where ${threeplShipments.postageBasis} = 'billed')::int`,
      unbilled: sql<number>`count(*) filter (where ${threeplShipments.postageBasis} = 'unbilled')::int`,
      knownCostCents: sql<number>`coalesce(sum(${threeplShipments.labelCostCents}), 0)::int`,
      chargedCents: sql<number>`coalesce(sum(${threeplShipments.shippingChargedCents}), 0)::int`,
      avgWeightLb: sql<number | null>`round(avg(${threeplShipments.weightLb})::numeric, 2)`,
    })
    .from(threeplShipments)
    .where(where)
    .groupBy(sql`1`)
    .orderBy(sql`count(*) desc`);
}

export interface ShipmentWindow {
  shipments: number;
  billed: number;
  unbilled: number;
  knownCostCents: number;
  chargedCents: number;
  firstShipment: string | null;
  lastShipment: string | null;
}

export async function getShipmentWindow(
  db: Db,
  range?: { from: string; to: string },
): Promise<ShipmentWindow> {
  const where = range
    ? and(gte(threeplShipments.createdAt, range.from), lte(threeplShipments.createdAt, range.to))
    : undefined;

  const [row] = await db
    .select({
      shipments: sql<number>`count(*)::int`,
      billed: sql<number>`count(*) filter (where ${threeplShipments.postageBasis} = 'billed')::int`,
      unbilled: sql<number>`count(*) filter (where ${threeplShipments.postageBasis} = 'unbilled')::int`,
      knownCostCents: sql<number>`coalesce(sum(${threeplShipments.labelCostCents}), 0)::int`,
      chargedCents: sql<number>`coalesce(sum(${threeplShipments.shippingChargedCents}), 0)::int`,
      firstShipment: sql<string | null>`min(${threeplShipments.createdAt})::text`,
      lastShipment: sql<string | null>`max(${threeplShipments.createdAt})::text`,
    })
    .from(threeplShipments)
    .where(where);
  return row;
}

export interface ShipmentCostByProduct {
  title: string;
  shipments: number;
  billed: number;
  knownCostCents: number;
  chargedCents: number;
  avgWeightLb: number | null;
  avgLongestSideIn: number | null;
}

/**
 * Shipping cost per product, joined through the order.
 *
 * A parcel is not per-product — an order with three items is one label — so a
 * product's shipments are the parcels that contained it, and two products in
 * one box each count that box. Fine for "what does a wall calendar cost to
 * ship", wrong for summing across products, which is why nothing here totals
 * it.
 */
export async function getShipmentCostByProduct(
  db: Db,
  options: { titleLike?: string; limit: number },
): Promise<{ rows: ShipmentCostByProduct[]; matched: number }> {
  const filter = options.titleLike ? `%${options.titleLike}%` : "%";

  const rows = await db.execute(sql`
    with joined as (
      select li.title,
             s.id as shipment_id,
             s.postage_basis,
             s.label_cost_cents,
             s.shipping_charged_cents,
             s.weight_lb,
             greatest(coalesce(s.length_in,0), coalesce(s.width_in,0), coalesce(s.height_in,0)) as longest
      from threepl_shipments s
      join shopify_orders o on o.order_number = s.order_number
      join shopify_line_items li on li.order_id = o.id
      where li.title ilike ${filter}
    ), agg as (
      select title,
             count(distinct shipment_id)::int as shipments,
             count(distinct shipment_id) filter (where postage_basis = 'billed')::int as billed,
             coalesce(sum(label_cost_cents), 0)::int as "knownCostCents",
             coalesce(sum(shipping_charged_cents), 0)::int as "chargedCents",
             round(avg(weight_lb)::numeric, 2) as "avgWeightLb",
             round(avg(nullif(longest, 0))::numeric, 1) as "avgLongestSideIn"
      from joined group by title
    )
    select *, (select count(*)::int from agg) as matched
    from agg order by shipments desc limit ${options.limit}
  `);

  const list = rows as unknown as (ShipmentCostByProduct & { matched: number })[];
  return {
    rows: list.map(({ matched: _m, ...r }) => r),
    matched: list.length > 0 ? Number(list[0].matched) : 0,
  };
}

export interface RecurringCostRow {
  id: string;
  name: string;
  vendor: string | null;
  amountCents: number;
  cadence: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
}

export async function getRecurringCosts(
  db: Db,
  options: { openOnly: boolean },
): Promise<RecurringCostRow[]> {
  const rows = await db
    .select({
      id: recurringCosts.id,
      name: recurringCosts.name,
      vendor: recurringCosts.vendor,
      amountCents: recurringCosts.amountCents,
      cadence: recurringCosts.cadence,
      effectiveFrom: recurringCosts.effectiveFrom,
      effectiveTo: recurringCosts.effectiveTo,
      source: recurringCosts.source,
    })
    .from(recurringCosts)
    .where(options.openOnly ? sql`${recurringCosts.effectiveTo} is null` : undefined)
    .orderBy(recurringCosts.name, recurringCosts.effectiveFrom);
  return rows;
}

/** Normalises a cadence to a monthly figure so a total means something. */
export function monthlyEquivalentCents(amountCents: number, cadence: string): number | null {
  switch (cadence) {
    case "monthly":
      return amountCents;
    case "annual":
      return Math.round(amountCents / 12);
    // 26 bill periods a year, not 24 — the 3PL bills fortnightly.
    case "per_bill_period":
      return Math.round((amountCents * 26) / 12);
    default:
      return null;
  }
}
