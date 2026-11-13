/**
 * What the ShipHero sync holds, and how far it can be trusted: shipments and
 * labels by month, the share of labels whose cost is known by month and by
 * carrier (with the dates each carrier's costs start and stop being known),
 * the label statuses actually seen, and ShipHero's shipping charge checked
 * against Shopify's for the same orders.
 */

import { desc, eq, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { syncRuns } from "@/db/schema";
import { INCLUDED_LABEL_STATUSES } from "./shiphero-transform";

const INCLUDED = sql.raw(`ARRAY[${INCLUDED_LABEL_STATUSES.map((s) => `'${s}'`).join(",")}]::text[]`);

export const SHIPHERO_SYNC_TASK = "sync:shiphero";
export const SHIPHERO_BILLING_PROBE_TASK = "probe:shiphero-billing";

export interface MonthCoverage {
  month: string;
  shipments: number;
  labels: number;
  /** Live, unrefunded labels — the ones postage is summed from. */
  includedLabels: number;
  knownLabels: number;
}

export interface CarrierCoverage {
  carrier: string;
  labels: number;
  knownLabels: number;
  firstLabel: string | null;
  lastLabel: string | null;
  firstKnown: string | null;
  lastKnown: string | null;
  firstUnknown: string | null;
  lastUnknown: string | null;
}

export interface ShipHeroCoverage {
  byMonth: MonthCoverage[];
  byMonthAndCarrier: Array<{ month: string; carrier: string; labels: number; knownLabels: number }>;
  byCarrier: CarrierCoverage[];
  statuses: Array<{ status: string; refunded: boolean; labels: number }>;
  /** Shipments that join no Shopify order — not costed against anything. */
  unmatchedShipments: number;
  shippingCharged: {
    orders: number;
    agree: number;
    disagree: number;
    examples: Array<{ orderNumber: string | null; shipheroCents: number; shopifyCents: number }>;
  };
}

const n = (v: unknown) => Number(v ?? 0);
const day = (v: unknown) => (v === null || v === undefined ? null : String(v));

export async function getShipHeroCoverage(db: Db): Promise<ShipHeroCoverage> {
  const labelled = sql`
    SELECT l.*, s.refunded AS shipment_refunded,
           to_char(COALESCE(l.created_date, s.created_date) AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
           (COALESCE(l.created_date, s.created_date) AT TIME ZONE 'UTC')::date AS day,
           (l.status = ANY(${INCLUDED}) AND COALESCE(l.refunded, 0) = 0 AND COALESCE(s.refunded, 0) = 0) AS included
    FROM shiphero_labels l JOIN shiphero_shipments s ON s.id = l.shipment_id`;

  const [months, labelMonths, monthCarrier, carriers, statuses, unmatched, charged] = await Promise.all([
    db.execute(sql`
      SELECT to_char(created_date AT TIME ZONE 'UTC', 'YYYY-MM') AS month, COUNT(*)::int AS shipments
      FROM shiphero_shipments GROUP BY 1 ORDER BY 1`),
    db.execute(sql`
      SELECT month, COUNT(*)::int AS labels,
             COUNT(*) FILTER (WHERE included)::int AS included_labels,
             COUNT(*) FILTER (WHERE included AND cost_cents IS NOT NULL)::int AS known_labels
      FROM (${labelled}) x GROUP BY month ORDER BY month`),
    db.execute(sql`
      SELECT month, COALESCE(carrier, '(none)') AS carrier, COUNT(*)::int AS labels,
             COUNT(*) FILTER (WHERE cost_cents IS NOT NULL)::int AS known_labels
      FROM (${labelled}) x WHERE included GROUP BY 1, 2 ORDER BY 1, 3 DESC`),
    db.execute(sql`
      SELECT COALESCE(carrier, '(none)') AS carrier, COUNT(*)::int AS labels,
             COUNT(*) FILTER (WHERE cost_cents IS NOT NULL)::int AS known_labels,
             MIN(day)::text AS first_label, MAX(day)::text AS last_label,
             MIN(day) FILTER (WHERE cost_cents IS NOT NULL)::text AS first_known,
             MAX(day) FILTER (WHERE cost_cents IS NOT NULL)::text AS last_known,
             MIN(day) FILTER (WHERE cost_cents IS NULL)::text AS first_unknown,
             MAX(day) FILTER (WHERE cost_cents IS NULL)::text AS last_unknown
      FROM (${labelled}) x WHERE included GROUP BY 1 ORDER BY 2 DESC`),
    db.execute(sql`
      SELECT COALESCE(l.status, '(none)') AS status, COALESCE(l.refunded, 0) = 1 AS refunded, COUNT(*)::int AS labels
      FROM shiphero_labels l GROUP BY 1, 2 ORDER BY 3 DESC`),
    db.execute(sql`
      SELECT COUNT(*)::int AS shipments FROM shiphero_shipments s
      WHERE s.shopify_order_id IS NULL OR NOT EXISTS (SELECT 1 FROM shopify_orders o WHERE o.id = s.shopify_order_id)`),
    // The shipping line is the order's, repeated on each of its shipments: one figure per order.
    db.execute(sql`
      SELECT o.order_number, MAX(s.shipping_charged_cents)::int AS shiphero_cents,
             (o.total_price_cents - o.subtotal_price_cents - COALESCE(o.total_tax_cents, 0))::int AS shopify_cents
      FROM shiphero_shipments s JOIN shopify_orders o ON o.id = s.shopify_order_id
      WHERE s.shipping_charged_cents IS NOT NULL AND o.subtotal_price_cents IS NOT NULL
      GROUP BY o.id, o.order_number, o.total_price_cents, o.subtotal_price_cents, o.total_tax_cents`),
  ]);

  const shipmentsByMonth = new Map((months as unknown as Array<{ month: string | null; shipments: number }>).map((r) => [r.month ?? "(no date)", n(r.shipments)]));
  const labelRows = labelMonths as unknown as Array<{ month: string | null; labels: number; included_labels: number; known_labels: number }>;
  const allMonths = [...new Set([...shipmentsByMonth.keys(), ...labelRows.map((r) => r.month ?? "(no date)")])].sort();
  const chargedRows = (charged as unknown as Array<{ order_number: string | null; shiphero_cents: number; shopify_cents: number }>).map((r) => ({
    orderNumber: r.order_number, shipheroCents: n(r.shiphero_cents), shopifyCents: n(r.shopify_cents),
  }));
  const disagreeing = chargedRows.filter((r) => r.shipheroCents !== r.shopifyCents);

  return {
    byMonth: allMonths.map((month) => {
      const l = labelRows.find((r) => (r.month ?? "(no date)") === month);
      return { month, shipments: shipmentsByMonth.get(month) ?? 0, labels: n(l?.labels), includedLabels: n(l?.included_labels), knownLabels: n(l?.known_labels) };
    }),
    byMonthAndCarrier: (monthCarrier as unknown as Array<{ month: string; carrier: string; labels: number; known_labels: number }>).map((r) => ({
      month: r.month, carrier: r.carrier, labels: n(r.labels), knownLabels: n(r.known_labels),
    })),
    byCarrier: (carriers as unknown as Array<Record<string, unknown>>).map((r) => ({
      carrier: String(r.carrier), labels: n(r.labels), knownLabels: n(r.known_labels),
      firstLabel: day(r.first_label), lastLabel: day(r.last_label), firstKnown: day(r.first_known), lastKnown: day(r.last_known),
      firstUnknown: day(r.first_unknown), lastUnknown: day(r.last_unknown),
    })),
    statuses: (statuses as unknown as Array<{ status: string; refunded: boolean; labels: number }>).map((r) => ({ status: r.status, refunded: Boolean(r.refunded), labels: n(r.labels) })),
    unmatchedShipments: n((unmatched as unknown as Array<{ shipments: number }>)[0]?.shipments),
    shippingCharged: {
      orders: chargedRows.length,
      agree: chargedRows.length - disagreeing.length,
      disagree: disagreeing.length,
      examples: disagreeing.slice(0, 10),
    },
  };
}

/** The latest sync and billing probe, as recorded in sync_runs. */
export async function getShipHeroRuns(db: Db) {
  const rows = await db
    .select()
    .from(syncRuns)
    .where(or(eq(syncRuns.task, SHIPHERO_SYNC_TASK), eq(syncRuns.task, SHIPHERO_BILLING_PROBE_TASK)))
    .orderBy(desc(syncRuns.startedAt))
    .limit(20);
  return {
    lastSync: rows.find((r) => r.task === SHIPHERO_SYNC_TASK) ?? null,
    lastBillingProbe: rows.find((r) => r.task === SHIPHERO_BILLING_PROBE_TASK) ?? null,
  };
}
