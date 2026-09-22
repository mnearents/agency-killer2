/**
 * Declared product lines for unit economics (#34).
 *
 * Cost of delivery is a **ratio over a population** — total cost divided by
 * total revenue — so a line-level average is exactly what target CPA needs and
 * per-order figures add nothing to it. What matters is that the population is
 * the one being advertised.
 *
 * That is why lines are declared rather than inferred from `product_type`.
 * `2026 Wall Calendar` is typed blank on 217 line items and `Stationery` on 7,
 * so a COD computed on `product_type = 'Planners'` would exclude the single
 * worst-shipping product and come out flattering — precise, and wrong in the
 * direction that costs money (#43).
 *
 * Rules are ordered and the first match wins, so a specific line sits above a
 * broader one. Nothing falls through to a default: an unmatched product is
 * returned as unassigned and reported.
 */

import DECLARATION from "./business-lines.json";
import type { BusinessLine } from "./queries";

export interface LineRule {
  id: string;
  label: string;
  /** The coarse line this rolls up to, so the two classifications cannot drift. */
  parent: BusinessLine;
  /** Whether ads run against it. Planners and the subscription; nothing else. */
  advertised: boolean;
  /**
   * An add-on sold alongside a real product rather than a line of its own.
   * Return protection appears on thousands of orders; counting it would make
   * most baskets look like they span lines, which would misread an add-on as
   * genuine basket mixing.
   */
  addon?: boolean;
  why?: string;
  match: {
    productType?: string[];
    titleContains?: string[];
    /** Terminal rule: any remaining product with a stock count. */
    catchAllPhysical?: boolean;
    /** Terminal rule: any remaining product without one. */
    catchAllDigital?: boolean;
  };
}

export const LINES: LineRule[] = DECLARATION.lines as LineRule[];

export function lineById(id: string): LineRule | undefined {
  return LINES.find((l) => l.id === id);
}

export const ADVERTISED_LINES = LINES.filter((l) => l.advertised).map((l) => l.id);

export interface ProductFacts {
  title: string | null;
  /**
   * The type on the ORDER — a snapshot copied onto the line item when it was
   * bought. It does not change when the product is retyped in admin, so it is
   * blank on 2,135 historical line items whose product has been typed all
   * along. Never read on its own.
   */
  productType: string | null;
  /**
   * The type on the PRODUCT as it stands now, from `shopify_inventory`.
   * Authoritative: 1,902 of those 2,135 blank line items have one. This is
   * what #43 actually was — not 30 untyped products, but the classifier
   * reading the snapshot instead of the product.
   */
  liveProductType?: string | null;
  /** Whether the variant has a stock count. Only a physical thing has one. */
  tracked: boolean;
}

/**
 * The type to classify on: the live product first, the order snapshot only as
 * a fallback for a line item whose product no longer exists.
 */
export function effectiveProductType(facts: ProductFacts): string {
  const live = (facts.liveProductType ?? "").trim();
  if (live !== "") return live;
  return (facts.productType ?? "").trim();
}

export interface ProductMatch {
  rule: LineRule;
  /**
   * Whether a named rule claimed this product or a terminal catch-all did.
   *
   * The catch-alls are needed — everything has to land somewhere — but a
   * fallback that reports identically to a real match is undetectable. A
   * mis-typed wall calendar reaching `catchAllDigital` would be counted as a
   * printable with no shipping cost, and the line would simply look healthy.
   */
  matchedBy: "rule" | "fallback";
}

/**
 * Which line one product belongs to, or null when nothing claims it.
 */
export function classifyProduct(facts: ProductFacts): LineRule | null {
  return matchProduct(facts)?.rule ?? null;
}

export function matchProduct(facts: ProductFacts): ProductMatch | null {
  const title = (facts.title ?? "").toLowerCase();
  const productType = effectiveProductType(facts);

  for (const rule of LINES) {
    if (rule.match.titleContains?.some((needle) => title.includes(needle.toLowerCase()))) {
      return { rule, matchedBy: "rule" };
    }
    if (rule.match.productType?.includes(productType)) return { rule, matchedBy: "rule" };
    if (rule.match.catchAllPhysical && facts.tracked) return { rule, matchedBy: "fallback" };
  }
  return null;
}

export interface OrderLineAssignment {
  /** The line carrying the most revenue in this order. */
  lineId: string | null;
  /** True when the order spans more than one line. */
  mixed: boolean;
  /** Revenue per line within the order, in cents. */
  revenueByLine: Record<string, number>;
  /** Cents of revenue no rule claimed. */
  unassignedCents: number;
  /** Cents that landed on a terminal catch-all rather than a named rule. */
  fallbackCents: number;
}

/**
 * Assigns a whole order to one line.
 *
 * Shipping is billed per parcel, not per item, so splitting an order's cost
 * across lines would be an allocation dressed as a measurement. Instead the
 * order goes to whichever line carries most of its revenue, and both cost and
 * revenue land together — the numerator and denominator stay drawn from the
 * same set of orders, which is what makes the ratio mean anything.
 *
 * `mixed` is returned so the share of baskets spanning lines is visible. If it
 * is large, the line figures are mushier than they look and nothing else in
 * the output would say so.
 */
export function assignOrderToLine(
  items: { facts: ProductFacts; revenueCents: number }[],
): OrderLineAssignment {
  const revenueByLine: Record<string, number> = {};
  let unassignedCents = 0;
  let fallbackCents = 0;

  for (const item of items) {
    const match = matchProduct(item.facts);
    if (match === null) {
      unassignedCents += item.revenueCents;
      continue;
    }
    if (match.matchedBy === "fallback") fallbackCents += item.revenueCents;
    revenueByLine[match.rule.id] = (revenueByLine[match.rule.id] ?? 0) + item.revenueCents;
  }

  const entries = Object.entries(revenueByLine);
  const productEntries = entries.filter(([id]) => !lineById(id)?.addon);
  if (entries.length === 0) {
    return { lineId: null, mixed: false, revenueByLine, unassignedCents, fallbackCents };
  }

  // Ties break by declaration order, so the same basket always lands in the
  // same line rather than depending on map iteration.
  const ranked = (productEntries.length > 0 ? productEntries : entries).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return LINES.findIndex((l) => l.id === a[0]) - LINES.findIndex((l) => l.id === b[0]);
  });

  return {
    lineId: ranked[0][0],
    mixed: productEntries.length > 1,
    revenueByLine,
    unassignedCents,
    fallbackCents,
  };
}
