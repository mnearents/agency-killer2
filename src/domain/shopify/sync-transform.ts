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
  ShopifyApiVisit,
} from "@/integrations/shopify-api";
import type {
  NewShopifyOrder,
  NewShopifyLineItem,
} from "@/db/schema";
import { isSubscriptionOrder } from "@/domain/shopify/subscription-tags";

function dollarsToCents(value: string | undefined | null): number {
  if (!value) return 0;
  return Math.round(parseFloat(value) * 100);
}

/**
 * Same conversion, but a missing value stays null instead of collapsing to 0.
 *
 * Used for the line-level discount, where 0 and "we never fetched it" are
 * different facts: rows synced before the field was requested would otherwise
 * claim every historical line was sold at full price, and net revenue computed
 * over them would silently equal gross.
 */
function dollarsToCentsOrNull(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  return Math.round(parseFloat(value) * 100);
}

const STORE_HOSTS = new Set(["radandhappy.com", "www.radandhappy.com"]);

/** "/blogs/news/x" for a page on the store; "shop.app/checkout/..." for one elsewhere. Query strings dropped. */
export function landingPathOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return STORE_HOSTS.has(u.hostname) ? path : `${u.hostname}${path === "/" ? "" : path}`;
  } catch {
    return null;
  }
}

function journeyOf(raw: ShopifyApiOrder) {
  const j = raw.customerJourneySummary ?? null;
  const first: ShopifyApiVisit | null = j?.firstVisit ?? null;
  const utm = first?.utmParameters ?? null;
  return {
    referringSite: first?.referrerUrl || null,
    utmSource: utm?.source ?? null,
    utmMedium: utm?.medium ?? null,
    utmCampaign: utm?.campaign ?? null,
    utmContent: utm?.content ?? null,
    utmTerm: utm?.term ?? null,
    landingPage: first?.landingPage ?? null,
    landingPath: landingPathOf(first?.landingPage),
    journeySource: first?.source ?? null,
    journeySourceType: first?.sourceType ?? null,
    lastLandingPath: landingPathOf(j?.lastVisit?.landingPage),
    journeyReady: j?.ready ? 1 : 0,
  };
}

export function transformOrder(
  raw: ShopifyApiOrder,
  syncedAt: Date
): NewShopifyOrder {
  // A subscription order by its contents as well as its tags: renewals billed
  // by the app before the Seal migration carry no tag, but they carry the plan.
  const hasPlan = (raw.lineItems?.nodes ?? []).some((li) => li.product?.productType === "Subscription");
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
    ...journeyOf(raw),
    isRecurring: isSubscriptionOrder(raw.tags) || hasPlan ? 1 : 0,
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
    variantTitle: raw.variant?.title ?? null,
    vendor: raw.vendor ?? null,
    quantity: raw.quantity,
    priceCents: dollarsToCents(raw.originalUnitPriceSet.shopMoney.amount),
    totalDiscountCents: dollarsToCentsOrNull(
      raw.totalDiscountSet?.shopMoney?.amount
    ),
    requiresShipping:
      raw.requiresShipping === undefined || raw.requiresShipping === null
        ? null
        : raw.requiresShipping
          ? 1
          : 0,
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
