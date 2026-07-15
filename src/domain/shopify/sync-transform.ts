/**
 * Shopify sync transforms — maps raw GraphQL responses into schema-valid DB rows.
 *
 * IMPORTANT money rules:
 * - Shopify returns money as decimal strings (e.g. "29.99") in store currency.
 * - We convert to cents: round(parseFloat(value) * 100).
 *
 * IMPORTANT subscription detection:
 * - Subscriptions are identified by the "recurring-order" tag.
 * - isRecurring is stored as 0/1 integer.
 */

import type {
  ShopifyApiOrder,
  ShopifyApiLineItem,
} from "@/integrations/shopify-api";
import type {
  NewShopifyOrder,
  NewShopifyLineItem,
} from "@/db/schema";
import { isSubscriptionOrder } from "@/domain/shopify/subscription-ltv";

function dollarsToCents(value: string | undefined | null): number {
  if (!value) return 0;
  return Math.round(parseFloat(value) * 100);
}

export function transformOrder(
  raw: ShopifyApiOrder,
  syncedAt: Date
): NewShopifyOrder {
  return {
    id: raw.id,
    orderNumber: raw.name,
    currency: raw.currencyCode,
    totalPriceCents: dollarsToCents(raw.totalPriceSet.shopMoney.amount),
    subtotalPriceCents: dollarsToCents(raw.subtotalPriceSet.shopMoney.amount),
    totalTaxCents: dollarsToCents(raw.totalTaxSet.shopMoney.amount),
    totalDiscountsCents: dollarsToCents(raw.totalDiscountsSet.shopMoney.amount),
    financialStatus: raw.displayFinancialStatus ?? null,
    fulfillmentStatus: raw.displayFulfillmentStatus ?? null,
    customerId: raw.customer?.id ?? null,
    sourceName: raw.sourceIdentifier ?? null,
    referringSite: raw.referringSite ?? null,
    isRecurring: isSubscriptionOrder(raw.tags) ? 1 : 0,
    tags: raw.tags,
    discountCodes: raw.discountCodes,
    orderCreatedAt: new Date(raw.createdAt),
    rawJson: raw,
    syncedAt,
  };
}

export function transformLineItem(
  raw: ShopifyApiLineItem,
  orderId: string
): NewShopifyLineItem {
  return {
    id: raw.id,
    orderId,
    productId: raw.product?.id ?? null,
    variantId: raw.variant?.id ?? null,
    productType: raw.product?.productType ?? null,
    sku: raw.variant?.sku ?? null,
    title: raw.title,
    quantity: raw.quantity,
    priceCents: dollarsToCents(raw.originalUnitPriceSet.shopMoney.amount),
    rawJson: raw,
  };
}

export function transformOrderWithLineItems(
  raw: ShopifyApiOrder,
  syncedAt: Date
): { order: NewShopifyOrder; lineItems: NewShopifyLineItem[] } {
  const order = transformOrder(raw, syncedAt);
  const lineItems = raw.lineItems.nodes.map((item) =>
    transformLineItem(item, raw.id)
  );
  return { order, lineItems };
}
