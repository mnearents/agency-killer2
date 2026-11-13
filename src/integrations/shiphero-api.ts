/**
 * ShipHero Public API (GraphQL) — the seam. READ-ONLY.
 *
 * The 3PL (Evobox) runs ShipHero; this reads our account's shipments and
 * their labels for per-label postage. The token may be able to write; this
 * module never does. It holds fixed query documents and exposes no generic
 * query method, every document is checked to be a `query` before it is sent,
 * and tests assert both — so no code path can send a mutation.
 *
 * Auth (developer.shiphero.com, Getting Started): a third-party developer
 * user's refresh token is exchanged at /auth/refresh for an access token
 * (valid 28 days), which is reused in memory rather than refreshed per call,
 * and refreshed once on a 401. Tokens never appear in an error or a log.
 *
 * Throttling: a GraphQL error with code 30 means not enough credits; it
 * reports `time_remaining` ("3 seconds"), which is waited out before one
 * retry at a time. HTTP 429 is the separate request-rate limit (7,000
 * requests per five minutes) and is backed off. Every wait is reported
 * through `onThrottle`, never retried silently.
 *
 * No customer field is selected — no address, email or name — though the
 * token can see them.
 */

import type { RawShipment } from "@/domain/economics/shiphero-transform";

export const SHIPHERO_GRAPHQL_URL = "https://public-api.shiphero.com/graphql";
export const SHIPHERO_REFRESH_URL = "https://public-api.shiphero.com/auth/refresh";

/** ShipHero's page size ceiling is 100; one credit per shipment plus one. */
const PAGE_SIZE = 100;
const MAX_THROTTLE_RETRIES = 8;
const RATE_LIMIT_BACKOFF_MS = 30_000;
/** Added to ShipHero's own estimate, which is rounded to whole seconds. */
const CREDIT_WAIT_MARGIN_MS = 500;

const SHIPMENTS_QUERY = `query Shipments($from: ISODateTime, $to: ISODateTime, $after: String) {
  shipments(date_from: $from, date_to: $to) {
    request_id
    complexity
    data(first: ${PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id legacy_id created_date total_packages
        shipped_off_shiphero refunded dropshipment
        order {
          order_number partner_order_id shop_name order_date source
          shipping_lines { title carrier method price }
        }
        shipping_labels {
          id carrier shipping_name shipping_method cost status refunded
          created_date package_number box_name carrier_account_id source
          dimensions { weight height width length }
        }
      } }
    }
  }
}`;

/** Whether billing data is readable yet. One row, one id: the cheapest question. */
const PROBES = {
  bills: `query ProbeBills { bills { request_id data(first: 1) { edges { node { id } } } } }`,
  fulfillment_invoices: `query ProbeInvoices { fulfillment_invoices { request_id data(first: 1) { edges { node { id } } } } }`,
} as const;

export type BillingProbeName = keyof typeof PROBES;

export interface ThrottleEvent {
  kind: "credits" | "http-429";
  waitedMs: number;
  requestId: string | null;
  detail: string;
}

export interface ShipmentsPage {
  requestId: string | null;
  complexity: number | null;
  nodes: RawShipment[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface BillingProbe {
  query: BillingProbeName;
  readable: boolean;
  code: number | null;
  detail: string | null;
  requestId: string | null;
}

export interface ShipHeroClient {
  /** One page of shipments created in the window (both ends inclusive). */
  shipments(window: { from: Date; to: Date }, after: string | null): Promise<ShipmentsPage>;
  probe(query: BillingProbeName): Promise<BillingProbe>;
}

export interface ShipHeroConfig {
  refreshToken: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onThrottle?: (event: ThrottleEvent) => void;
}

export class ShipHeroError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly requestId: string | null,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ShipHeroError";
  }
}

/** "3 seconds" → 3000. Null when it says anything else. */
export function parseTimeRemainingMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*seconds?$/i);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

interface GraphQlError {
  code?: number;
  message?: string;
  time_remaining?: string;
  request_id?: string;
}

export function createShipHeroClient(config: ShipHeroConfig): ShipHeroClient {
  const doFetch = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let accessToken: string | null = null;

  const scrub = (text: string) => {
    let out = text;
    for (const secret of [config.refreshToken, accessToken]) if (secret) out = out.split(secret).join("[token]");
    return out.slice(0, 500);
  };

  async function refresh(): Promise<string> {
    const res = await doFetch(SHIPHERO_REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: config.refreshToken }),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) throw new ShipHeroError(scrub(`ShipHero refused the token refresh: ${res.status} ${body}`), null, null, res.status);
    let token: unknown;
    try {
      token = (JSON.parse(body) as { access_token?: unknown }).access_token;
    } catch {
      token = undefined;
    }
    if (typeof token !== "string" || token === "") throw new ShipHeroError("ShipHero's token refresh returned no access_token", null, null, res.status);
    accessToken = token;
    return token;
  }

  async function send(document: string, variables: Record<string, unknown>): Promise<{ data: Record<string, unknown> | null; errors: GraphQlError[] }> {
    // The guard every request passes: queries only.
    if (!/^query\b/.test(document.trimStart()) || /\bmutation\b/i.test(document)) {
      throw new ShipHeroError("Refused: only GraphQL queries are sent to ShipHero", null, null, null);
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = accessToken ?? (await refresh());
      const res = await doFetch(SHIPHERO_GRAPHQL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: document, variables }),
      });
      const text = await res.text().catch(() => "");

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        accessToken = null;
        continue;
      }
      if (res.status === 429) {
        if (attempt >= MAX_THROTTLE_RETRIES) throw new ShipHeroError(`ShipHero throttled the request (HTTP 429) ${attempt + 1} times; gave up`, null, null, 429);
        const waitedMs = RATE_LIMIT_BACKOFF_MS * (attempt + 1);
        config.onThrottle?.({ kind: "http-429", waitedMs, requestId: null, detail: "HTTP 429: over 7,000 requests in five minutes" });
        await sleep(waitedMs);
        continue;
      }
      if (!res.ok) throw new ShipHeroError(scrub(`ShipHero answered ${res.status}: ${text}`), null, null, res.status);

      let body: { data?: Record<string, unknown> | null; errors?: GraphQlError[] };
      try {
        body = JSON.parse(text);
      } catch {
        throw new ShipHeroError(scrub(`ShipHero sent an unreadable reply: ${text}`), null, null, res.status);
      }
      const errors = Array.isArray(body.errors) ? body.errors : [];
      const credit = errors.find((e) => e.code === 30);
      if (credit) {
        if (attempt >= MAX_THROTTLE_RETRIES) throw new ShipHeroError(`ShipHero throttled the request (not enough credits) ${attempt + 1} times; gave up`, 30, credit.request_id ?? null, res.status);
        const waitedMs = (parseTimeRemainingMs(credit.time_remaining) ?? 5000) + CREDIT_WAIT_MARGIN_MS;
        config.onThrottle?.({ kind: "credits", waitedMs, requestId: credit.request_id ?? null, detail: scrub(credit.message ?? "not enough credits") });
        await sleep(waitedMs);
        continue;
      }
      return { data: body.data ?? null, errors };
    }
  }

  const failure = (errors: GraphQlError[], root: Record<string, unknown> | null) => {
    const e = errors[0];
    const requestId = e?.request_id ?? (typeof root?.request_id === "string" ? root.request_id : null);
    return new ShipHeroError(scrub(`ShipHero error${e?.code !== undefined ? ` ${e.code}` : ""}: ${e?.message ?? "no data returned"}`), e?.code ?? null, requestId, null);
  };

  return {
    async shipments(window, after) {
      const { data, errors } = await send(SHIPMENTS_QUERY, { from: iso(window.from), to: iso(window.to), after });
      const root = (data?.shipments ?? null) as {
        request_id?: string;
        complexity?: number;
        data?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; edges?: Array<{ node: RawShipment }> };
      } | null;
      if (errors.length > 0 || !root?.data) throw failure(errors, root as Record<string, unknown> | null);
      return {
        requestId: root.request_id ?? null,
        complexity: typeof root.complexity === "number" ? root.complexity : null,
        nodes: (root.data.edges ?? []).map((e) => e.node),
        hasNextPage: root.data.pageInfo?.hasNextPage === true,
        endCursor: root.data.pageInfo?.endCursor ?? null,
      };
    },

    async probe(query) {
      const { data, errors } = await send(PROBES[query], {});
      const root = (data?.[query] ?? null) as { request_id?: string } | null;
      if (errors.length > 0 || !root) {
        const e = errors[0];
        return { query, readable: false, code: e?.code ?? null, detail: scrub(e?.message ?? "no data returned"), requestId: e?.request_id ?? null };
      }
      return { query, readable: true, code: null, detail: null, requestId: root.request_id ?? null };
    },
  };
}
