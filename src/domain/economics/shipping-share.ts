/**
 * Orders whose label cost is more than a share of what they brought in — pure.
 *
 * Net revenue is the order total less tax: merchandise after discounts plus
 * any shipping collected, the definition the unit economics use. An order
 * whose postage is unknown cannot be judged and is counted as such, never
 * passed as fine.
 *
 * An order that brought in nothing — a replacement, an exchange, a payment
 * taken off Shopify — is over every share by definition, so it is kept out
 * of the list and totalled in `unpaid`: what shipping cost on orders that
 * earned nothing, apart from the question of what pricing loses.
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

export interface CodeTotal {
  code: string;
  orders: number;
  labelCostCents: number;
  netRevenueCents: number;
}

export interface ShareResult {
  judged: number;
  unjudged: number;
  /** Paying orders over the share, worst first. */
  orders: Array<ShareOrder & { labelShare: number }>;
  byDiscountCode: CodeTotal[];
  /** Judged orders with no net revenue, never in `orders`. */
  unpaid: { orders: number; labelCostCents: number; byDiscountCode: CodeTotal[] };
}

function byCode(orders: ShareOrder[]): CodeTotal[] {
  const codes = new Map<string, CodeTotal>();
  for (const o of orders) {
    for (const code of o.discountCodes.length > 0 ? o.discountCodes : ["(no code)"]) {
      const c = codes.get(code) ?? { code, orders: 0, labelCostCents: 0, netRevenueCents: 0 };
      c.orders++;
      c.labelCostCents += o.labelCostCents!;
      c.netRevenueCents += o.netRevenueCents;
      codes.set(code, c);
    }
  }
  return [...codes.values()].sort((a, b) => b.orders - a.orders || b.labelCostCents - a.labelCostCents || a.code.localeCompare(b.code));
}

export function ordersOverShippingShare(orders: ShareOrder[], share: number): ShareResult {
  const judged = orders.filter((o) => o.labelCostCents !== null);
  const unpaid = judged.filter((o) => o.netRevenueCents <= 0);
  const over = judged
    .filter((o) => o.netRevenueCents > 0)
    .map((o) => ({ ...o, labelShare: Math.round((o.labelCostCents! / o.netRevenueCents) * 10_000) / 10_000 }))
    .filter((o) => o.labelShare > share)
    .sort((a, b) => b.labelShare - a.labelShare);

  return {
    judged: judged.length,
    unjudged: orders.length - judged.length,
    orders: over,
    byDiscountCode: byCode(over),
    unpaid: { orders: unpaid.length, labelCostCents: unpaid.reduce((n, o) => n + o.labelCostCents!, 0), byDiscountCode: byCode(unpaid) },
  };
}
