/**
 * The RAD portal's email-metrics endpoint (notify.radandhappy.com, the
 * rad-portal repo). It stores monthly Attentive journey figures for the
 * portal's Analytics page, replacing a month + journey it already holds, and
 * validates every row itself: a bad row refuses the whole payload, by name.
 *
 * It has no read that takes this token — the portal shows the figures behind
 * its own dashboard login — so this client only posts.
 *
 * The token lives in this client's closure and travels only in the
 * Authorization header. It is scrubbed from every result, so neither a tool's
 * output nor a log line built from one can carry it.
 */

export const PORTAL_EMAIL_METRICS_URL = "https://notify.radandhappy.com/api/metrics/email";
const DEFAULT_TIMEOUT_MS = 20_000;

export const EMAIL_JOURNEYS = ["failed_payment", "pages_dropped", "rad_welcome", "yearly_upcoming_renewal"] as const;

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

export type PortalPostResult =
  | { ok: true; body: Record<string, unknown> }
  /** 400: the portal refused a row; `message` names it. */
  | { ok: false; kind: "rejected"; message: string }
  /** 401: the token is wrong. 503: the portal has none set. */
  | { ok: false; kind: "token"; status: number }
  /** No answer: the request failed or timed out. */
  | { ok: false; kind: "network"; message: string }
  | { ok: false; kind: "unexpected"; status: number; message: string };

export interface PortalMetricsClient {
  /** One attempt, never retried: a retry of a write is the caller's decision. */
  postEmailMetrics(rows: EmailMetricRow[]): Promise<PortalPostResult>;
}

export function createPortalMetricsClient(config: { token: string; url?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): PortalMetricsClient {
  const url = config.url ?? PORTAL_EMAIL_METRICS_URL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scrub = (text: string) => (config.token ? text.split(config.token).join("[token]") : text).slice(0, 500);

  return {
    async postEmailMetrics(rows) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({ rows }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        return {
          ok: false,
          kind: "network",
          message: timedOut ? `the portal did not answer; timed out after ${timeoutMs / 1000}s` : scrub(err instanceof Error ? err.message : String(err)),
        };
      }

      const text = await res.text().catch(() => "");
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON; handled by status below.
      }
      const message = scrub(
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : text,
      );

      if (res.status === 401 || res.status === 503) return { ok: false, kind: "token", status: res.status };
      if (res.status === 400) return { ok: false, kind: "rejected", message };
      if (res.status === 200 && body && typeof body === "object" && !Array.isArray(body)) {
        return { ok: true, body: JSON.parse(scrub(JSON.stringify(body))) as Record<string, unknown> };
      }
      return { ok: false, kind: "unexpected", status: res.status, message: message || "(empty reply)" };
    },
  };
}
