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

export interface ShopifyApiCustomer {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  enrollments: string | null; // JSON string of automatik.enrollments metafield
}

export interface ShopifyApiClient {
  getOrders(params: {
    since?: string;
    limit?: number;
  }): Promise<ShopifyApiOrder[]>;
  getCustomersWithEnrollments(params?: {
    limit?: number;
  }): Promise<ShopifyApiCustomer[]>;
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

const CUSTOMERS_QUERY = `
  query GetCustomers($first: Int!, $after: String) {
    customers(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        email
        firstName
        lastName
        metafield(namespace: "automatik", key: "enrollments") {
          value
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

  /**
   * Shopify GraphQL rate limiting uses "calculated query cost".
   * Each response includes extensions.cost with:
   *   - requestedQueryCost: points this query costs
   *   - actualQueryCost: actual points used
   *   - throttleStatus.currentlyAvailable: points remaining
   *   - throttleStatus.restoreRate: points refilled per second
   *
   * We track available points and sleep when running low.
   */
  let availablePoints = 100; // Conservative starting assumption

  async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    // If we're running low on points, wait for them to refill
    if (availablePoints < 20) {
      const waitMs = Math.ceil((20 - availablePoints) / 50 * 1000); // ~50 points/sec restore
      console.log(`[shopify] Rate limit: ${availablePoints} points left, waiting ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      // Handle 429 throttle responses
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
        console.log(`[shopify] Throttled (429), retrying in ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return graphql<T>(query, variables); // Retry once
      }
      const error = await response.text();
      throw new Error(`Shopify API error (${response.status}): ${error}`);
    }

    const json = await response.json();

    // Check for throttle errors in the GraphQL response
    if (json.errors) {
      const throttleError = json.errors.find(
        (e: { extensions?: { code?: string } }) => e.extensions?.code === "THROTTLED"
      );
      if (throttleError) {
        console.log("[shopify] Throttled (GraphQL), waiting 2s...");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return graphql<T>(query, variables); // Retry once
      }
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
    }

    // Update available points from response
    if (json.extensions?.cost?.throttleStatus) {
      availablePoints = json.extensions.cost.throttleStatus.currentlyAvailable;
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

    async getCustomersWithEnrollments(params) {
      const limit = params?.limit ?? 25;
      const allCustomers: ShopifyApiCustomer[] = [];
      let after: string | null = null;

      interface CustomersResponse {
        customers: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: Array<{
            id: string;
            email: string | null;
            firstName: string | null;
            lastName: string | null;
            metafield: { value: string } | null;
          }>;
        };
      }

      do {
        // graphql() handles rate limiting internally
        const data: CustomersResponse = await graphql<CustomersResponse>(
          CUSTOMERS_QUERY,
          { first: limit, after }
        );

        for (const node of data.customers.nodes) {
          if (node.metafield?.value) {
            allCustomers.push({
              id: node.id,
              email: node.email,
              firstName: node.firstName,
              lastName: node.lastName,
              enrollments: node.metafield.value,
            });
          }
        }

        after = data.customers.pageInfo.hasNextPage
          ? data.customers.pageInfo.endCursor
          : null;
      } while (after);

      return allCustomers;
    },
  };
}
