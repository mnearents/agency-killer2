/**
 * Seal Subscriptions Merchant API client — the seam.
 *
 * Auth, retry behaviour and the pagination envelope are ported near-verbatim
 * from the working implementation in the `appstle` repo. That is deliberate:
 * the list-endpoint envelope (`payload.{subscriptions,page,total_pages}`) is
 * NOT in Seal's documentation. It is known only because that code runs against
 * the live API every day. Rewriting it from the docs would be guessing.
 *
 * Money arrives as major-unit strings ("8.0"), the opposite of the Shopify
 * path. Conversion to cents happens in the transform layer, not here — this
 * file returns what Seal sent.
 */

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 2000;
const DEFAULT_BASE_URL = "https://app.sealsubscriptions.com/shopify/merchant/api";

/** Seal caps page size at 50 and offers no way to change it. */
export const SEAL_PAGE_SIZE = 50;

export interface SealBillingAttempt {
  id: number;
  date: string;
  /** "" = scheduled, "completed" = succeeded, "error" = failed. No other value observed. */
  status: string;
  order_id: string;
  error_code: string;
  error_message: string;
  triggered_manually: string;
  customer_authentication_challenge_url: string;
  completed_at: string;
  /** Absent on attempts that have not run yet. */
  attempted_at?: string;
}

export interface SealItem {
  id: number;
  product_id: string;
  variant_id: string;
  title: string;
  variant_sku: string;
  quantity: number;
  price: string;
  /** Empty on ~90% of records — every grandfathered subscription lacks it. */
  selling_plan_id: string;
  selling_plan_name: string;
  is_one_time_item: number;
  requires_shipping: number;
  taxable: number;
}

export interface SealSubscription {
  id: number;
  /** Shopify order ID, OR a synthetic "_manual_xxxxx" for migrated records. */
  order_id: string;
  email: string;
  first_name: string;
  last_name: string;
  /** ACTIVE or CANCELLED. The docs also list PAUSED/EXPIRED; neither occurs. */
  status: string;
  billing_interval: string;
  delivery_interval: string;
  currency: string;
  total_value: number;
  order_placed: string;
  cancelled_on: string;
  paused_on: string;
  cancellation_reason: string;
  cancellation_scheduled_for: string;
  internal_id: number;
  items: SealItem[];
  billing_attempts: SealBillingAttempt[];
}

/** One entry in Seal's audit trail. Newest first, timestamps in shop-local time. */
export interface SealLogEntry {
  content: string;
  created: string;
}

/**
 * The fields that exist ONLY on the single-subscription endpoint.
 *
 * The list endpoint omits all three, so anything here costs one request per
 * subscription. That is why they are fetched together — splitting them would
 * mean crawling 4,390 records once per field.
 */
export interface SealSubscriptionDetail {
  /** Bare numeric Shopify customer ID, or null when there genuinely is none. */
  customerId: string | null;
  /** Seal's audit trail. Empty array is a real answer; null means absent. */
  log: SealLogEntry[] | null;
  tags: string[] | null;
}

export interface SealApiClient {
  /**
   * Every subscription, every status. Seal offers no `since` or `status`
   * filter — unknown query params are silently ignored — so a full crawl is
   * the only option. ~88 pages, ~90 seconds.
   */
  getAllSubscriptions(): Promise<SealSubscription[]>;

  /**
   * Customer ID, audit log and tags for one subscription.
   *
   * One request per subscription, so never called in bulk from the daily sync —
   * only for subscriptions it has not seen before, and by the backfill scripts.
   */
  getSubscriptionDetail(subscriptionId: string): Promise<SealSubscriptionDetail>;
}

export interface SealConfig {
  apiToken: string;
  baseUrl?: string;
  /** Injectable so tests never sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createSealApiClient(config: SealConfig): SealApiClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const sleep = config.sleep ?? defaultSleep;

  const headers = (): Record<string, string> => ({
    "X-Seal-Token": config.apiToken,
    "Content-Type": "application/json",
  });

  async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, { method: "GET", headers: headers() });

        // Seal's documented limit is 10 concurrent requests, and it answers
        // with 503 rather than 429. Retrying both costs nothing.
        if (response.status === 429 || response.status === 503) {
          await sleep(INITIAL_RETRY_DELAY_MS * attempt);
          continue;
        }

        // Seal sometimes returns HTML error pages under heavy load.
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("json") && attempt < retries) {
          await sleep(INITIAL_RETRY_DELAY_MS * attempt);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < retries) {
          await sleep(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
        }
      }
    }

    throw lastError ?? new Error("Seal request failed after retries");
  }

  async function getPage(page: number): Promise<{
    subscriptions: SealSubscription[];
    totalPages: number;
  }> {
    // No active-only: cancelled records carry cancelled_on plus intact
    // items[] and billing_attempts[], which is what makes cohort retention
    // computable at all.
    const url =
      `${baseUrl}/subscriptions` +
      `?with-items=true&with-billing-attempts=true&page=${page}`;

    const response = await fetchWithRetry(url);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Seal API ${response.status} ${response.statusText} on page ${page}: ${body.slice(0, 200)}`
      );
    }

    const data = (await response.json()) as {
      success?: boolean;
      payload?: { subscriptions?: SealSubscription[]; total_pages?: number };
    };

    // A malformed envelope must not read as "zero subscriptions" — that would
    // wipe the snapshot table with a clean-looking empty sync.
    if (!data?.payload || !Array.isArray(data.payload.subscriptions)) {
      throw new Error(`Seal API returned an unrecognised envelope on page ${page}`);
    }

    return {
      subscriptions: data.payload.subscriptions,
      totalPages: Number(data.payload.total_pages ?? 1),
    };
  }

  return {
    async getSubscriptionDetail(subscriptionId: string): Promise<SealSubscriptionDetail> {
      const url = `${baseUrl}/subscription?id=${encodeURIComponent(subscriptionId)}`;
      const response = await fetchWithRetry(url);

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Seal API ${response.status} ${response.statusText} on subscription ${subscriptionId}: ${body.slice(0, 200)}`
        );
      }

      const data = (await response.json()) as {
        payload?: { customer_id?: string | number; log?: unknown; tags?: unknown };
      };

      // A missing payload is a broken call; a payload with no customer_id is a
      // real answer. Collapsing the two would silently record "no customer"
      // for every subscription on the day the envelope changes. Seal answers
      // an unauthorised request with `payload: []`, which is an object to
      // typeof, so the array check is load-bearing.
      if (!data?.payload || typeof data.payload !== "object" || Array.isArray(data.payload)) {
        throw new Error(
          `Seal API returned an unrecognised envelope for subscription ${subscriptionId}`
        );
      }

      const raw = data.payload.customer_id;
      const customerId = raw === undefined || raw === null || raw === "" ? null : String(raw);

      // An empty array is a real answer — a subscription nobody has edited.
      // A non-array means the field was absent or reshaped, which is unknown,
      // not empty; recording it as [] would read as "never touched" and hide
      // every tier change on that record.
      const log = Array.isArray(data.payload.log)
        ? (data.payload.log as unknown[])
            .filter(
              (e): e is SealLogEntry =>
                typeof e === "object" &&
                e !== null &&
                typeof (e as SealLogEntry).content === "string" &&
                typeof (e as SealLogEntry).created === "string"
            )
            .map((e) => ({ content: e.content, created: e.created }))
        : null;

      const tags = Array.isArray(data.payload.tags)
        ? (data.payload.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : null;

      return { customerId, log, tags };
    },

    async getAllSubscriptions(): Promise<SealSubscription[]> {
      const all: SealSubscription[] = [];
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages) {
        const result = await getPage(page);
        totalPages = result.totalPages;
        all.push(...result.subscriptions);
        page++;
      }

      return all;
    },
  };
}
