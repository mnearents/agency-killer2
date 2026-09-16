/**
 * ShopifyQL client — the seam for Shopify Analytics.
 *
 * Sessions are the only source in this business with enough history to see the
 * traffic collapse: 37 months, back to September 2023, against GA4's two. The
 * GA4 property was created 2026-08-24 and cannot answer a year-over-year
 * question at all.
 *
 * ## ShopifyQL reports a bad query as a 200
 *
 * This is the property that justifies a client rather than a raw fetch. A
 * syntax error, an unknown column or an unsupported function all come back as
 * HTTP 200 with `tableData: null` and a `parseErrors` array. Code that reads
 * `tableData` and moves on returns an empty result for a query that never ran,
 * and a sync above it records a day with no traffic.
 *
 * Not hypothetical: `sum(sessions)` and `total_sales` both did exactly that
 * while the token was valid and `read_reports` was present. So `parseErrors`
 * throws, and the message carries the failing statement — the error text alone
 * does not say which query produced it.
 *
 * ## Access
 *
 * Needs the `read_reports` scope AND Level 2 protected customer data access.
 * Without them `shopifyqlQuery` returns ACCESS_DENIED at the GraphQL level,
 * which is at least loud; `assertReportsAccess` checks up front so the failure
 * names the missing scope rather than surfacing as a query error.
 */

const API_VERSION = "2025-01";

/**
 * ShopifyQL carries its own cost budget, separate from the Admin API's, and a
 * 37-month backfill exhausts it: the first real run stopped mid-2026-05 after
 * 49,538 rows with "Rate limited. Please retry later."
 *
 * Only a rate limit is retried. Retrying a parse error or an access denial
 * would loop on a query that can never succeed.
 */
const DEFAULT_MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 20_000;

function isRateLimit(message: string): boolean {
  return /rate limit|throttl/i.test(message);
}

export interface ShopifyAnalyticsRow {
  [column: string]: string | number;
}

export interface ShopifyAnalyticsClient {
  /** Runs a ShopifyQL statement. Throws on anything that is not a real result. */
  query(shopifyql: string): Promise<ShopifyAnalyticsRow[]>;
  /** Throws unless the token carries `read_reports`. Returns the full scope list. */
  assertReportsAccess(): Promise<string[]>;
}

export interface ShopifyAnalyticsConfig {
  storeDomain: string;
  accessToken: string;
  fetchFn?: typeof fetch;
  /** Injected so retry tests do not actually wait. */
  sleepFn?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/**
 * ShopifyQL returns every cell as a string. Dimensions stay strings; anything
 * that parses cleanly as a finite number becomes one.
 *
 * Deliberately strict: `Number("")` is 0 and `Number("direct")` is NaN, so an
 * exact round-trip check is what separates "a number written as text" from "a
 * word". A loose parse would turn an empty cell into a measured zero.
 */
function coerce(value: string): string | number {
  if (value.trim() === "") return value;
  const n = Number(value);
  return Number.isFinite(n) && String(n) === String(Number(value)) ? n : value;
}

export function createShopifyAnalyticsClient(
  config: ShopifyAnalyticsConfig
): ShopifyAnalyticsClient {
  const doFetch = config.fetchFn ?? fetch;
  const sleep = config.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const endpoint = `https://${config.storeDomain}/admin/api/${API_VERSION}/graphql.json`;

  async function attempt(query: string): Promise<Record<string, unknown>> {
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": config.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    const body = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message?: string }>;
    };

    if (!res.ok) {
      throw new Error(`Shopify Admin API failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    }
    if (body.errors?.length) {
      throw new Error(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    return body.data ?? {};
  }

  async function graphql(query: string): Promise<Record<string, unknown>> {
    let lastError: unknown;

    for (let tries = 0; tries <= maxRetries; tries++) {
      try {
        return await attempt(query);
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        // Anything else is a query that will never succeed; retrying it would
        // burn the budget and delay the real failure.
        if (!isRateLimit(message) || tries === maxRetries) throw err;
        await sleep(INITIAL_RETRY_DELAY_MS * Math.pow(2, tries));
      }
    }

    throw lastError;
  }

  return {
    async query(shopifyql) {
      const data = await graphql(
        `{ shopifyqlQuery(query: ${JSON.stringify(shopifyql)}) { tableData { columns { name } rows } parseErrors } }`
      );

      const result = data.shopifyqlQuery as {
        tableData?: { columns?: Array<{ name: string }>; rows?: Array<Record<string, string>> } | null;
        parseErrors?: string[] | null;
      } | null;

      // The guard this client exists for. A 200 carrying parseErrors is a
      // query that never ran, and returning [] would record it as no traffic.
      if (result?.parseErrors?.length) {
        throw new Error(
          `ShopifyQL rejected the query: ${result.parseErrors.join("; ")} — statement was: ${shopifyql}`
        );
      }

      if (!result?.tableData) {
        throw new Error(
          `ShopifyQL returned neither table data nor a parse error for: ${shopifyql}. ` +
            `Refusing to read that as an empty result.`
        );
      }

      const columns = (result.tableData.columns ?? []).map((c) => c.name);
      return (result.tableData.rows ?? []).map((row) => {
        const out: ShopifyAnalyticsRow = {};
        for (const col of columns) out[col] = coerce(String(row[col] ?? ""));
        return out;
      });
    },

    async assertReportsAccess() {
      const data = await graphql(`{ currentAppInstallation { accessScopes { handle } } }`);
      const installation = data.currentAppInstallation as
        | { accessScopes?: Array<{ handle: string }> }
        | undefined;
      const scopes = (installation?.accessScopes ?? []).map((s) => s.handle);

      if (!scopes.includes("read_reports")) {
        throw new Error(
          `The Shopify token does not carry "read_reports", so no analytics query can run. ` +
            `It has: ${scopes.join(", ") || "(none)"}. Add the scope in the custom app's ` +
            `Admin API configuration — note it also requires Level 2 protected customer data access.`
        );
      }
      return scopes;
    },
  };
}
