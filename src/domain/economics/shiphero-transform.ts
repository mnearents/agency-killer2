/**
 * ShipHero shipments → rows — pure.
 *
 * ShipHero's values are strings: money as dollars ("8.25"), dates in UTC with
 * no zone ("2026-11-09T18:32:28"), weights and dimensions with their unit
 * attached ("3.6500 lb", "4.0000 inch"). A unit this does not recognise is
 * NULL, never assumed to be pounds or inches.
 *
 * Only the fields named here leave this module. The node is typed loosely
 * because it arrives from the network; nothing is spread from it, so a
 * customer field that ever came back with it is dropped, not stored.
 */

import type { ShipheroLabelRow, ShipheroShipmentRow } from "@/db/schema";

/**
 * Label statuses counted as a live label's cost. Only "valid" has been seen
 * (2026-11-13). Any other status is excluded from postage and reported by
 * the coverage figures, so a void or a new state is noticed rather than
 * silently summed.
 */
export const INCLUDED_LABEL_STATUSES = ["valid"] as const;

export interface RawShippingLine {
  title?: string | null;
  carrier?: string | null;
  method?: string | null;
  price?: string | null;
}

export interface RawLabel {
  id: string;
  carrier?: string | null;
  shipping_name?: string | null;
  shipping_method?: string | null;
  cost?: string | null;
  status?: string | null;
  refunded?: boolean | null;
  created_date?: string | null;
  package_number?: number | null;
  box_name?: string | null;
  carrier_account_id?: string | null;
  source?: string | null;
  dimensions?: { weight?: string | null; height?: string | null; width?: string | null; length?: string | null } | null;
}

export interface RawShipment {
  id: string;
  legacy_id?: number | null;
  created_date?: string | null;
  total_packages?: number | null;
  shipped_off_shiphero?: boolean | null;
  refunded?: boolean | null;
  dropshipment?: boolean | null;
  order?: {
    order_number?: string | null;
    partner_order_id?: string | null;
    shop_name?: string | null;
    order_date?: string | null;
    source?: string | null;
    shipping_lines?: RawShippingLine | RawShippingLine[] | null;
  } | null;
  shipping_labels?: RawLabel[] | null;
}

export function parseMoneyCents(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export type LabelCostBasis = "reported" | "zero-reported" | "absent";

/** A reported 0.00 is a label billed elsewhere: unknown, not free. */
export function parseLabelCost(v: string | null | undefined): { cents: number | null; basis: LabelCostBasis } {
  const cents = parseMoneyCents(v);
  if (cents === null) return { cents: null, basis: "absent" };
  if (cents === 0) return { cents: null, basis: "zero-reported" };
  return { cents, basis: "reported" };
}

const WEIGHT_TO_LB: Record<string, number> = { lb: 1, lbs: 1, pound: 1, pounds: 1, oz: 1 / 16, ounce: 1 / 16, ounces: 1 / 16, kg: 2.2046226218, g: 0.0022046226218 };
const LENGTH_TO_IN: Record<string, number> = { in: 1, inch: 1, inches: 1, cm: 1 / 2.54, mm: 1 / 25.4 };

function withUnit(v: string | null | undefined, table: Record<string, number>): number | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(-?\d+(?:\.\d+)?)\s*([A-Za-z]+)$/);
  if (!m) return null;
  const factor = table[m[2].toLowerCase()];
  if (factor === undefined) return null;
  return Math.round(Number(m[1]) * factor * 10_000) / 10_000;
}

export const parseWeightLb = (v: string | null | undefined) => withUnit(v, WEIGHT_TO_LB);
export const parseLengthIn = (v: string | null | undefined) => withUnit(v, LENGTH_TO_IN);

/** ShipHero's dates are UTC without a zone; an explicit zone is kept. */
export function parseShipHeroDate(v: string | null | undefined): Date | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const s = v.trim();
  const zoned = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
  const d = new Date(zoned);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function shopifyOrderGid(partnerOrderId: string | null | undefined): string | null {
  return typeof partnerOrderId === "string" && /^\d+$/.test(partnerOrderId.trim()) ? `gid://shopify/Order/${partnerOrderId.trim()}` : null;
}

const flag = (v: boolean | null | undefined) => (v === null || v === undefined ? null : v ? 1 : 0);
const text = (v: string | null | undefined) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export function toShipHeroRows(node: RawShipment, syncedAt: Date): { shipment: ShipheroShipmentRow; labels: ShipheroLabelRow[] } {
  const order = node.order ?? null;
  const rawLines = order?.shipping_lines ?? null;
  const lines = rawLines === null ? [] : Array.isArray(rawLines) ? rawLines : [rawLines];
  const prices = lines.map((l) => parseMoneyCents(l.price));
  const charged = prices.length === 0 || prices.some((p) => p === null) ? null : (prices as number[]).reduce((a, b) => a + b, 0);
  const first = lines[0] ?? null;

  const shipment: ShipheroShipmentRow = {
    id: node.id,
    legacyId: typeof node.legacy_id === "number" ? node.legacy_id : null,
    orderNumber: text(order?.order_number),
    partnerOrderId: text(order?.partner_order_id),
    shopifyOrderId: shopifyOrderGid(order?.partner_order_id),
    shopName: text(order?.shop_name),
    orderSource: text(order?.source),
    createdDate: parseShipHeroDate(node.created_date),
    totalPackages: typeof node.total_packages === "number" ? node.total_packages : null,
    shippedOffShiphero: flag(node.shipped_off_shiphero),
    dropshipment: flag(node.dropshipment),
    refunded: flag(node.refunded),
    shippingLineTitle: text(first?.title),
    shippingLineCarrier: text(first?.carrier),
    shippingLineMethod: text(first?.method),
    shippingChargedCents: charged,
    syncedAt,
  };

  const labels: ShipheroLabelRow[] = (node.shipping_labels ?? []).map((l) => {
    const cost = parseLabelCost(l.cost);
    return {
      id: l.id,
      shipmentId: node.id,
      carrier: text(l.carrier),
      shippingMethod: text(l.shipping_method),
      shippingName: text(l.shipping_name),
      carrierAccountId: text(l.carrier_account_id),
      costCents: cost.cents,
      costBasis: cost.basis,
      status: text(l.status),
      refunded: flag(l.refunded),
      boxName: text(l.box_name),
      packageNumber: typeof l.package_number === "number" ? l.package_number : null,
      weightLb: parseWeightLb(l.dimensions?.weight),
      lengthIn: parseLengthIn(l.dimensions?.length),
      widthIn: parseLengthIn(l.dimensions?.width),
      heightIn: parseLengthIn(l.dimensions?.height),
      source: text(l.source),
      createdDate: parseShipHeroDate(l.created_date),
      syncedAt,
    };
  });

  return { shipment, labels };
}
