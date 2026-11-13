/**
 * Orders whose label cost is more than a share of what they brought in — pure.
 *
 * Net revenue is the order total less tax: merchandise after discounts plus
 * any shipping collected, the definition the unit economics use. An order
 * whose postage is unknown cannot be judged and is counted as such, never
 * passed as fine.
 */

export interface ShareOrder {
  orderNumber: string | null;
  orderedAt: string;
  netRevenueCents: number;
  shippingChargedCents: number | null;
  labelCostCents: number | null;
  labelSource: "invoice" | "shiphero" | null;
  discountCodes: string[];
}

export interface ShareResult {
  judged: number;
  unjudged: number;
  orders: Array<ShareOrder & { labelShare: number | null }>;
  byDiscountCode: Array<{ code: string; orders: number; labelCostCents: number; netRevenueCents: number }>;
}

export function ordersOverShippingShare(orders: ShareOrder[], share: number): ShareResult {
  const judged = orders.filter((o) => o.labelCostCents !== null);
  const over = judged
    .map((o) => ({ ...o, labelShare: o.netRevenueCents > 0 ? Math.round((o.labelCostCents! / o.netRevenueCents) * 10_000) / 10_000 : null }))
    .filter((o) => o.labelShare === null || o.labelShare > share)
    .sort((a, b) => (b.labelShare ?? Infinity) - (a.labelShare ?? Infinity));

  const codes = new Map<string, { code: string; orders: number; labelCostCents: number; netRevenueCents: number }>();
  for (const o of over) {
    for (const code of o.discountCodes.length > 0 ? o.discountCodes : ["(no code)"]) {
      const c = codes.get(code) ?? { code, orders: 0, labelCostCents: 0, netRevenueCents: 0 };
      c.orders++;
      c.labelCostCents += o.labelCostCents!;
      c.netRevenueCents += o.netRevenueCents;
      codes.set(code, c);
    }
  }

  return {
    judged: judged.length,
    unjudged: orders.length - judged.length,
    orders: over,
    byDiscountCode: [...codes.values()].sort((a, b) => b.orders - a.orders || b.labelCostCents - a.labelCostCents || a.code.localeCompare(b.code)),
  };
}
