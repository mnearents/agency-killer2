/**
 * The RAD portal's email-metrics API (the rad-portal repo, at RAD_PORTAL_URL).
 * It stores monthly Attentive journey figures for the portal's Analytics page:
 * POST validates every row and stores all or none, replacing a month + journey
 * it already holds; GET reads them back. Both take METRICS_INGEST_TOKEN as a
 * bearer token. The portal's checks are the authority; nothing here softens
 * or re-implements them.
 *
 * The token lives in this client's closure and travels only in the
 * Authorization header. It is scrubbed from every result, so neither a tool's
 * output nor a log line built from one can carry it.
 */

export const EMAIL_METRICS_PATH = "/api/metrics/email";
const DEFAULT_TIMEOUT_MS = 20_000;

export const EMAIL_JOURNEYS = ["failed_payment", "pages_dropped", "rad_welcome", "yearly_upcoming_renewal"] as const;

/** A row as posted: the portal's ingest field names. */
export interface EmailMetricRow {
  /** YYYY-MM */
  month: string;
  journey: (typeof EMAIL_JOURNEYS)[number];
  delivered: number;
  opened: number;
  clicked: number;
  /** Dollars, two places. */
  attributed_revenue: number;
}

/** A row as the portal stores and returns it. */
export interface StoredEmailMetricRow {
  month: string;
  journey: string;
  delivered: number;
  opened: number;
  clicked: number;
  attributedRevenue: number;
  /** ISO time the row was last written. */
  updatedAt: string;
}

export type PortalFailure =
  /** 400: the portal refused a row or a month; `message` names it. */
  | { ok: false; kind: "rejected"; message: string }
  /** 401: the token is wrong. 503: the portal has none set. */
  | { ok: false; kind: "token"; status: number }
  /** No answer: the request failed or timed out. */
  | { ok: false; kind: "network"; message: string }
  /** Any other answer, 500 included. */
  | { ok: false; kind: "unexpected"; status: number; message: string };

export type PortalPostResult = { ok: true; stored: number } | PortalFailure;
export type PortalGetResult = { ok: true; rows: StoredEmailMetricRow[] } | PortalFailure;

export interface PortalMetricsClient {
  /** One attempt, never retried: a retry of a write is the caller's decision. */
  postEmailMetrics(rows: EmailMetricRow[]): Promise<PortalPostResult>;
  /** Every stored month when `months` is omitted. */
  getEmailMetrics(months?: string[]): Promise<PortalGetResult>;
}

export interface PortalMetricsConfig {
  /** RAD_PORTAL_URL, e.g. https://notify.radandhappy.com */
  baseUrl: string;
  /** METRICS_INGEST_TOKEN */
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createPortalMetricsClient(config: PortalMetricsConfig): PortalMetricsClient {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}${EMAIL_METRICS_PATH}`;
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Removing the token applies to everything; shortening, to error text only.
  // Shortening a body before parsing it cut every reply over 500 characters.
  const scrub = (text: string) => (config.token ? text.split(config.token).join("[token]") : text);
  const short = (text: string) => scrub(text).slice(0, 500);

  /** The answer's body when it is a 200 object; otherwise the failure, scrubbed. */
  async function call(url: string, init: RequestInit): Promise<{ ok: true; body: Record<string, unknown> } | PortalFailure> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return {
        ok: false,
        kind: "network",
        message: timedOut ? `the portal did not answer; timed out after ${timeoutMs / 1000}s` : short(err instanceof Error ? err.message : String(err)),
      };
    }

    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON; the status decides below.
    }
    const message = short(
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : text,
    );

    if (res.status === 401 || res.status === 503) return { ok: false, kind: "token", status: res.status };
    if (res.status === 400) return { ok: false, kind: "rejected", message };
    if (res.status === 200 && body && typeof body === "object" && !Array.isArray(body)) {
      return { ok: true, body: JSON.parse(scrub(JSON.stringify(body))) as Record<string, unknown> };
    }
    return { ok: false, kind: "unexpected", status: res.status, message: message || "(empty reply)" };
  }

  return {
    async postEmailMetrics(rows) {
      const r = await call(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }) });
      if (!r.ok) return r;
      if (typeof r.body.stored !== "number") return { ok: false, kind: "unexpected", status: 200, message: `the portal's reply has no "stored" count: ${short(JSON.stringify(r.body))}` };
      return { ok: true, stored: r.body.stored };
    },
    async getEmailMetrics(months) {
      const url = months === undefined ? endpoint : `${endpoint}?months=${encodeURIComponent(months.join(","))}`;
      const r = await call(url, { method: "GET" });
      if (!r.ok) return r;
      if (!Array.isArray(r.body.rows)) return { ok: false, kind: "unexpected", status: 200, message: "the portal's reply has no rows" };
      return { ok: true, rows: r.body.rows as StoredEmailMetricRow[] };
    },
  };
}
