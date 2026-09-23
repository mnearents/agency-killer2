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
  /** Discount allocated to this line, not the order. Order-level discounts are
   *  apportioned across lines by Shopify, so summing this over an order's lines
   *  reconciles to the order's total discount. */
  totalDiscountSet: { shopMoney: { amount: string } };
  /** Separates physical goods from digital printables at the line, which
   *  product_type does not reliably do — the same product type covers both. */
  requiresShipping: boolean;
  vendor: string | null;
  product: { id: string; productType: string } | null;
  variant: { id: string; sku: string | null; title: string | null } | null;
}

export interface ShopifyApiCustomer {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  enrollments: string | null; // JSON string of automatik.enrollments metafield
}

/** The full customer record, for everyone — not just enrollment holders. */
export interface ShopifyApiCustomerProfile {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  createdAt: string;
  /** Shopify returns this as a string. */
  numberOfOrders: string;
  amountSpent: { amount: string } | null;
  tags: string[];
  /** Null when Shopify reports no consent record at all — not the same as declining. */
  emailMarketingConsent: { marketingState: string } | null;
  /** City/province/country only. Street address is deliberately never requested. */
  defaultAddress: {
    city: string | null;
    province: string | null;
    country: string | null;
  } | null;
}

export interface ShopifyApiVariant {
  id: string;
  title: string;
  sku: string | null;
  inventoryQuantity: number | null;
  price: string;
  /**
   * null when Shopify returns no inventory item — treat as untracked.
   * `id` identifies the stock pool: two variants sharing one sell the same
   * physical units, which is the condition #9 exists to detect.
   */
  inventoryItem: {
    id: string;
    tracked: boolean;
    /**
     * Shopify's "Cost per item" as a decimal string, or null when none is
     * recorded. Landed product cost — invoice, freight, duty — which is the
     * input every cost-of-delivery figure rests on (#34).
     *
     * `null` and `"0.0"` are deliberately different. Digital products, gift
     * cards and subscriptions legitimately cost nothing; a planner with
     * nothing entered is a gap. Collapsing them would make every margin
     * quietly optimistic with nothing to notice.
     */
    unitCost: string | null;
  } | null;
  product: {
    id: string;
    title: string;
    status: string; // ACTIVE, DRAFT, ARCHIVED
    productType: string | null;
  } | null;
}

/**
 * Product-level copy and SEO. Separate from ShopifyApiVariant because that is
 * variant-grained and has nowhere to put a description.
 */
export interface ShopifyApiProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  descriptionHtml: string | null;
  /** The storefront meta title and description. Null when never set. */
  seoTitle: string | null;
  seoDescription: string | null;
  /** Keyed `namespace.key`. Only the identifiers asked for appear. */
  metafields: Record<string, string>;
  updatedAt: string;
}

export interface ShopifyApiClient {
  getOrders(params: {
    since?: string;
    /** Exclusive upper bound. Lets a backfill crawl in resumable chunks
     *  instead of one open-ended run that starts over after any throttle. */
    until?: string;
    limit?: number;
  }): Promise<ShopifyApiOrder[]>;
  getCustomersWithEnrollments(params?: {
    limit?: number;
  }): Promise<ShopifyApiCustomer[]>;
  /** Every customer, unfiltered — unlike getCustomersWithEnrollments. */
  getCustomerProfiles(params?: {
    limit?: number;
  }): Promise<ShopifyApiCustomerProfile[]>;
  getInventory(params?: { limit?: number }): Promise<ShopifyApiVariant[]>;
  /**
   * Products with their copy, SEO fields and the named metafields.
   *
   * Metafields are fetched one namespace at a time. Shopify will not return
   * every namespace, so one outside the requested namespace is absent from
   * this system rather than empty in it.
   */
  getProducts(params: {
    /** The one namespace to fetch. Everything in it is returned. */
    metafieldNamespace: string;
    limit?: number;
  }): Promise<ShopifyApiProduct[]>;
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
            totalDiscountSet { shopMoney { amount } }
            requiresShipping
            vendor
            product { id productType }
            variant { id sku title }
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

/**
 * Deliberately does NOT request `addresses` or any street field — only the
 * default address's city/province/country. Geography at that granularity is
 * analytically useful and not identifying; a street address is neither.
 */
const CUSTOMER_PROFILES_QUERY = `
  query GetCustomerProfiles($first: Int!, $after: String) {
    customers(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        email
        firstName
        lastName
        createdAt
        numberOfOrders
        amountSpent { amount }
        tags
        emailMarketingConsent { marketingState }
        defaultAddress { city province country }
      }
    }
  }
`;

const INVENTORY_QUERY = `
  query GetInventory($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        sku
        inventoryQuantity
        price
        inventoryItem { id tracked unitCost { amount } }
        product { id title status productType }
      }
    }
  }
`;

/**
 * Metafields come back as a connection filtered to one namespace.
 *
 * The `metafields(identifiers:)` form does not exist on Product in 2025-04 —
 * it is a Storefront-era shape and the Admin API rejects it outright, which is
 * how this was caught. Asking for a namespace returns everything in it, which
 * is a superset of the five keys that matter and costs nothing extra.
 */
const PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String, $namespace: String!) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        productType
        vendor
        tags
        descriptionHtml
        updatedAt
        seo { title description }
        metafields(first: 30, namespace: $namespace) { nodes { namespace key value } }
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
  let availablePoints = 100;

  async function graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
    retryCount = 0
  ): Promise<T> {
    const MAX_RETRIES = 3;

    // Pre-check: if low on points, wait for restore
    if (availablePoints < 20) {
      const waitMs = Math.max(1000, Math.ceil((20 - availablePoints) / 50 * 1000));
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
      if (response.status === 429 && retryCount < MAX_RETRIES) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 4000;
        console.log(`[shopify] Throttled (429), retry ${retryCount + 1}/${MAX_RETRIES} in ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return graphql<T>(query, variables, retryCount + 1);
      }
      const error = await response.text();
      throw new Error(`Shopify API error (${response.status}): ${error}`);
    }

    const json = await response.json();

    // Update available points from response (do this before error check)
    if (json.extensions?.cost?.throttleStatus) {
      availablePoints = json.extensions.cost.throttleStatus.currentlyAvailable;
    }

    if (json.errors) {
      const isThrottled = json.errors.some(
        (e: { extensions?: { code?: string } }) => e.extensions?.code === "THROTTLED"
      );
      if (isThrottled && retryCount < MAX_RETRIES) {
        // Exponential backoff: 2s, 4s, 8s
        const waitMs = 2000 * Math.pow(2, retryCount);
        console.log(`[shopify] Throttled (GraphQL), retry ${retryCount + 1}/${MAX_RETRIES} in ${waitMs}ms`);
        availablePoints = 0; // Force pre-check wait on next call too
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return graphql<T>(query, variables, retryCount + 1);
      }
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
    }

    return json.data;
  }

  return {
    async getOrders(params) {
      const limit = params.limit ?? 50;
      const clauses: string[] = [];
      if (params.since) clauses.push(`created_at:>='${params.since}'`);
      if (params.until) clauses.push(`created_at:<'${params.until}'`);
      const query = clauses.length ? clauses.join(" AND ") : undefined;
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

    async getCustomerProfiles(params) {
      const limit = params?.limit ?? 100;
      const all: ShopifyApiCustomerProfile[] = [];
      let after: string | null = null;

      interface ProfilesResponse {
        customers: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: ShopifyApiCustomerProfile[];
        };
      }

      do {
        const data: ProfilesResponse = await graphql<ProfilesResponse>(
          CUSTOMER_PROFILES_QUERY,
          { first: limit, after }
        );

        // No filtering. getCustomersWithEnrollments drops customers without the
        // metafield; this one must not, or every segment is computed over a
        // subset nobody realises is a subset.
        all.push(...data.customers.nodes);
        after = data.customers.pageInfo.hasNextPage
          ? data.customers.pageInfo.endCursor
          : null;
      } while (after);

      return all;
    },

    async getProducts(params) {
      const limit = params.limit ?? 100;
      const namespace = params.metafieldNamespace;
      const all: ShopifyApiProduct[] = [];
      let after: string | null = null;

      interface RawProduct {
        id: string;
        title: string;
        handle: string;
        status: string;
        productType: string | null;
        vendor: string | null;
        tags: string[] | null;
        descriptionHtml: string | null;
        updatedAt: string;
        seo: { title: string | null; description: string | null } | null;
        metafields: { nodes: ({ namespace: string; key: string; value: string } | null)[] } | null;
      }

      do {
        const data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawProduct[] } } =
          await graphql(PRODUCTS_QUERY, { first: limit, after, namespace });

        for (const node of data.products.nodes) {
          const metafields: Record<string, string> = {};
          // An empty value is left out rather than stored as "", so "never
          // written" stays distinct from "written blank".
          for (const mf of node.metafields?.nodes ?? []) {
            if (mf && typeof mf.value === "string" && mf.value !== "") {
              metafields[`${mf.namespace}.${mf.key}`] = mf.value;
            }
          }

          all.push({
            id: node.id,
            title: node.title,
            handle: node.handle,
            status: node.status,
            productType: node.productType && node.productType !== "" ? node.productType : null,
            vendor: node.vendor && node.vendor !== "" ? node.vendor : null,
            tags: node.tags ?? [],
            descriptionHtml: node.descriptionHtml && node.descriptionHtml !== "" ? node.descriptionHtml : null,
            seoTitle: node.seo?.title && node.seo.title !== "" ? node.seo.title : null,
            seoDescription: node.seo?.description && node.seo.description !== "" ? node.seo.description : null,
            metafields,
            updatedAt: node.updatedAt,
          });
        }

        after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
      } while (after !== null);

      return all;
    },

    async getInventory(params) {
      const limit = params?.limit ?? 100;
      const allVariants: ShopifyApiVariant[] = [];
      let after: string | null = null;

      /**
       * Shopify nests the cost as `unitCost { amount }`. The variant type
       * flattens it to a string, so the raw shape is declared separately
       * rather than pretending the API returns what we want.
       */
      interface RawVariant extends Omit<ShopifyApiVariant, "inventoryItem"> {
        inventoryItem: {
          id: string;
          tracked: boolean;
          unitCost: { amount: string } | null;
        } | null;
      }

      interface InventoryResponse {
        productVariants: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: RawVariant[];
        };
      }

      do {
        const data: InventoryResponse = await graphql<InventoryResponse>(
          INVENTORY_QUERY,
          { first: limit, after }
        );

        allVariants.push(
          ...data.productVariants.nodes.map((n) => ({
            ...n,
            inventoryItem: n.inventoryItem
              ? {
                  id: n.inventoryItem.id,
                  tracked: n.inventoryItem.tracked,
                  // `?? null`, never `?? "0"`. A variant with no cost recorded
                  // and one that genuinely costs nothing are different facts.
                  unitCost: n.inventoryItem.unitCost?.amount ?? null,
                }
              : null,
          }))
        );
        after = data.productVariants.pageInfo.hasNextPage
          ? data.productVariants.pageInfo.endCursor
          : null;
      } while (after);

      return allVariants;
    },
  };
}
