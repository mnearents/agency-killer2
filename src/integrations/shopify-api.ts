/**
 * Shopify Admin API client (GraphQL) — the seam.
 * Tests mock this interface; production uses the real Shopify SDK.
 *
 * Shopify returns money as decimal strings (e.g. "29.99") in the
 * store's currency. We convert to cents in the sync transform layer.
 */

export interface ShopifyApiOrder {
  id: string;
  name: string; // Order number like "#1001"
  createdAt: string; // ISO 8601
  currencyCode: string;
  totalPriceSet: { shopMoney: { amount: string } };
  subtotalPriceSet: { shopMoney: { amount: string } };
  totalTaxSet: { shopMoney: { amount: string } };
  totalDiscountsSet: { shopMoney: { amount: string } };
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  customer: { id: string } | null;
  tags: string[];
  discountCodes: string[];
  sourceIdentifier: string | null;
  referringSite: string | null;
  landingSite: string | null;
  lineItems: { nodes: ShopifyApiLineItem[] };
}

export interface ShopifyApiLineItem {
  id: string;
  title: string;
  quantity: number;
  originalUnitPriceSet: { shopMoney: { amount: string } };
  product: { id: string; productType: string } | null;
  variant: { id: string; sku: string | null } | null;
}

export interface ShopifyApiClient {
  getOrders(params: {
    since?: string;
    limit?: number;
  }): Promise<ShopifyApiOrder[]>;
}

export function createShopifyApiClient(
  _storeDomain: string,
  _accessToken: string
): ShopifyApiClient {
  throw new Error(
    "Real Shopify API client not yet implemented — use createMockShopifyApiClient in tests"
  );
}
