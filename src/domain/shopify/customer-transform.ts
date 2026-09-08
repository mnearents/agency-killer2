/**
 * Maps a Shopify customer profile into a schema-valid row.
 *
 * Only the fields Shopify itself reports. Everything derived from orders or
 * subscriptions is set by the rollup in `customer-rollup.ts`, so that a sync
 * which fetches customers but never computes the rollup leaves those fields
 * null rather than zero — "not computed" and "no orders" must not look alike.
 */

import type { ShopifyApiCustomerProfile } from "@/integrations/shopify-api";
import type { NewShopifyCustomer } from "@/db/schema";

function dollarsToCentsOrNull(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  return Math.round(parseFloat(value) * 100);
}

export function transformCustomer(
  raw: ShopifyApiCustomerProfile,
  syncedAt: Date
): NewShopifyCustomer {
  return {
    id: raw.id,
    email: raw.email ?? null,
    firstName: raw.firstName ?? null,
    lastName: raw.lastName ?? null,

    ordersCount: raw.numberOfOrders ? parseInt(raw.numberOfOrders, 10) : null,
    totalSpentCents: dollarsToCentsOrNull(raw.amountSpent?.amount),

    tags: raw.tags,
    // Three states, not two. Shopify reporting no consent record is not the
    // same as a customer declining, and collapsing it to 0 would silently
    // shrink every marketable audience by an unknown amount.
    acceptsMarketing:
      raw.emailMarketingConsent === null || raw.emailMarketingConsent === undefined
        ? null
        : raw.emailMarketingConsent.marketingState === "SUBSCRIBED"
          ? 1
          : 0,

    city: raw.defaultAddress?.city ?? null,
    state: raw.defaultAddress?.province ?? null,
    country: raw.defaultAddress?.country ?? null,

    customerCreatedAt: new Date(raw.createdAt),
    rawJson: raw,
    syncedAt,
  };
}
