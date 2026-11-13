/**
 * What each order's labels cost, and where the figure came from.
 *
 * Precedence: the hand-imported shipment export (`threepl_shipments`, the
 * "invoice" figure the existing tools use) where every one of the order's
 * rows is known; else ShipHero's label cost (`shiphero_labels`) where every
 * included label is known; else unknown. A part-known order is unknown —
 * its known labels are a floor, not its postage.
 *
 * A ShipHero label counts when its status is one INCLUDED_LABEL_STATUSES
 * names and neither it nor its shipment is refunded.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { INCLUDED_LABEL_STATUSES } from "./shiphero-transform";

export type PostageSource = "invoice" | "shiphero";

export interface InvoiceSide {
  rows: number;
  known: number;
  cents: number | null;
}

export interface ShipHeroSide {
  /** Included labels: live status, not refunded. */
  labels: number;
  known: number;
  cents: number | null;
}

export function resolvePostage(invoice: InvoiceSide | null, shiphero: ShipHeroSide | null): { cents: number; source: PostageSource } | null {
  if (invoice && invoice.rows > 0 && invoice.known === invoice.rows && invoice.cents !== null) return { cents: invoice.cents, source: "invoice" };
  if (shiphero && shiphero.labels > 0 && shiphero.known === shiphero.labels && shiphero.cents !== null) return { cents: shiphero.cents, source: "shiphero" };
  return null;
}

export interface OrderPostage {
  postage: { cents: number; source: PostageSource } | null;
  invoice: InvoiceSide | null;
  shiphero: ShipHeroSide | null;
  /** ShipHero's labels first (they cover more), else the export's. */
  weightLb: number | null;
}

const INCLUDED = sql.raw(`ARRAY[${INCLUDED_LABEL_STATUSES.map((s) => `'${s}'`).join(",")}]::text[]`);

/** The CTEs both sides are read from, one row per order on each. */
const SIDES = sql`
  inv AS (
    SELECT t.order_number,
           COUNT(*)::int AS rows,
           -- 'zero' is a genuine zero from a carrier that bills through the
           -- 3PL; 'unbilled' is unknown.
           COUNT(*) FILTER (WHERE t.postage_basis IN ('billed', 'zero'))::int AS known,
           SUM(COALESCE(t.label_cost_cents, 0)) FILTER (WHERE t.postage_basis IN ('billed', 'zero'))::int AS cents,
           SUM(t.weight_lb) AS weight_lb
    FROM threepl_shipments t
    WHERE t.order_number IS NOT NULL
    GROUP BY t.order_number
  ),
  sh AS (
    SELECT s.shopify_order_id,
           COUNT(*) FILTER (WHERE x.included)::int AS labels,
           COUNT(*) FILTER (WHERE x.included AND l.cost_cents IS NOT NULL)::int AS known,
           SUM(l.cost_cents) FILTER (WHERE x.included)::int AS cents,
           SUM(l.weight_lb) FILTER (WHERE x.included) AS weight_lb
    FROM shiphero_shipments s
    JOIN shiphero_labels l ON l.shipment_id = s.id
    CROSS JOIN LATERAL (
      SELECT (l.status = ANY(${INCLUDED}) AND COALESCE(l.refunded, 0) = 0 AND COALESCE(s.refunded, 0) = 0) AS included
    ) x
    WHERE s.shopify_order_id IS NOT NULL
    GROUP BY s.shopify_order_id
  )`;

interface SideRow {
  id: string;
  order_number: string | null;
  inv_rows: number | null;
  inv_known: number | null;
  inv_cents: number | null;
  inv_weight: number | null;
  sh_labels: number | null;
  sh_known: number | null;
  sh_cents: number | null;
  sh_weight: number | null;
}

function toOrderPostage(r: SideRow): OrderPostage {
  const invoice = r.inv_rows === null ? null : { rows: Number(r.inv_rows), known: Number(r.inv_known), cents: r.inv_cents === null ? null : Number(r.inv_cents) };
  const shiphero = r.sh_labels === null ? null : { labels: Number(r.sh_labels), known: Number(r.sh_known), cents: r.sh_cents === null ? null : Number(r.sh_cents) };
  const weight = r.sh_weight ?? r.inv_weight;
  return { postage: resolvePostage(invoice, shiphero), invoice, shiphero, weightLb: weight === null ? null : Number(weight) };
}

/** Postage for every order created in [startDate, endDate], keyed by Shopify order id. */
export async function getOrderPostage(db: Db, startDate: string, endDate: string): Promise<Map<string, OrderPostage>> {
  const rows = (await db.execute(sql`
    WITH ${SIDES}
    SELECT o.id, o.order_number,
           inv.rows AS inv_rows, inv.known AS inv_known, inv.cents AS inv_cents, inv.weight_lb AS inv_weight,
           sh.labels AS sh_labels, sh.known AS sh_known, sh.cents AS sh_cents, sh.weight_lb AS sh_weight
    FROM shopify_orders o
    LEFT JOIN inv ON inv.order_number = o.order_number
    LEFT JOIN sh ON sh.shopify_order_id = o.id
    WHERE o.order_created_at >= ${startDate}::date
      AND o.order_created_at < (${endDate}::date + 1)
      AND (inv.order_number IS NOT NULL OR sh.shopify_order_id IS NOT NULL)
  `)) as unknown as SideRow[];
  return new Map(rows.map((r) => [r.id, toOrderPostage(r)]));
}

export interface SourceComparison {
  orders: number;
  identical: number;
  /** ShipHero minus invoice, averaged. Null when nothing overlapped — not zero. */
  meanDifferenceCents: number | null;
  meanAbsoluteDifferenceCents: number | null;
  overFiftyCents: number;
  largest: Array<{ orderNumber: string | null; invoiceCents: number; shipheroCents: number; differenceCents: number }>;
}

export function compareSources(rows: Array<{ orderNumber: string | null; invoiceCents: number; shipheroCents: number }>): SourceComparison {
  if (rows.length === 0) return { orders: 0, identical: 0, meanDifferenceCents: null, meanAbsoluteDifferenceCents: null, overFiftyCents: 0, largest: [] };
  const diffs = rows.map((r) => ({ ...r, differenceCents: r.shipheroCents - r.invoiceCents }));
  return {
    orders: rows.length,
    identical: diffs.filter((d) => d.differenceCents === 0).length,
    meanDifferenceCents: Math.round(diffs.reduce((s, d) => s + d.differenceCents, 0) / rows.length),
    meanAbsoluteDifferenceCents: Math.round(diffs.reduce((s, d) => s + Math.abs(d.differenceCents), 0) / rows.length),
    overFiftyCents: diffs.filter((d) => Math.abs(d.differenceCents) > 50).length,
    largest: [...diffs].sort((a, b) => Math.abs(b.differenceCents) - Math.abs(a.differenceCents)).slice(0, 10),
  };
}

/**
 * Orders whose postage both sources know in full, compared. This is how we
 * learn whether ShipHero's `cost` is what the 3PL bills or the carrier's own
 * rate: a gap is reported, never averaged away.
 */
export async function getPostageOverlap(db: Db): Promise<SourceComparison> {
  const rows = (await db.execute(sql`
    WITH ${SIDES}
    SELECT o.order_number, inv.cents AS invoice_cents, sh.cents AS shiphero_cents
    FROM shopify_orders o
    JOIN inv ON inv.order_number = o.order_number
    JOIN sh ON sh.shopify_order_id = o.id
    WHERE inv.rows > 0 AND inv.known = inv.rows AND inv.cents IS NOT NULL
      AND sh.labels > 0 AND sh.known = sh.labels AND sh.cents IS NOT NULL
  `)) as unknown as Array<{ order_number: string | null; invoice_cents: number; shiphero_cents: number }>;
  return compareSources(rows.map((r) => ({ orderNumber: r.order_number, invoiceCents: Number(r.invoice_cents), shipheroCents: Number(r.shiphero_cents) })));
}
