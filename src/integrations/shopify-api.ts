/**
 * Shopify Admin API client (GraphQL) — the seam.
 * Tests mock this interface; production uses the real Shopify GraphQL API.
 *
 * Shopify returns money as decimal strings (e.g. "29.99") in the
 * store's currency. We convert to cents in the sync transform layer.
 */

const SHOPIFY_API_VERSION = "2025-04";

export interface ShopifyApiOrder {
  id: string;
  name: string;
  createdAt: string;
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

const ORDERS_QUERY = `
  query GetOrders($first: Int!, $query: String, $after: String) {
    orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt currencyCode
        totalPriceSet { shopMoney { amount } }
        subtotalPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        displayFinancialStatus displayFulfillmentStatus
        customer { id }
        tags
        discountCodes
        sourceIdentifier
        lineItems(first: 50) {
          nodes {
            id title quantity
            originalUnitPriceSet { shopMoney { amount } }
            product { id productType }
            variant { id sku }
          }
        }
      }
    }
  }
`;

export function createShopifyApiClient(
  storeDomain: string,
  accessToken: string
): ShopifyApiClient {
  const endpoint = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Shopify API error (${response.status}): ${error}`);
    }

    const json = await response.json();
    if (json.errors) {
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
    }

    return json.data;
  }

  return {
    async getOrders(params) {
      const limit = params.limit ?? 50;
      const query = params.since ? `created_at:>='${params.since}'` : undefined;
      const allOrders: ShopifyApiOrder[] = [];
      let after: string | null = null;

      interface OrdersResponse {
        orders: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: ShopifyApiOrder[];
        };
      }

      do {
        const data: OrdersResponse = await graphql<OrdersResponse>(
          ORDERS_QUERY,
          { first: limit, query, after }
        );

        allOrders.push(...data.orders.nodes);
        after = data.orders.pageInfo.hasNextPage
          ? data.orders.pageInfo.endCursor
          : null;
      } while (after);

      return allOrders;
    },
  };
}
