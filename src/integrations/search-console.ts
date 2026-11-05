/**
 * Google Search Console client — the seam.
 *
 * Search Console is the only source that answers "did anyone arrive". Every
 * other feed answers what happened after they did, which is why a 62%
 * year-over-year traffic collapse was invisible to this system until a human
 * exported a CSV by hand.
 *
 * ## Two properties of this API that shape everything here
 *
 * **An access failure does not look like a failure.** A service account with a
 * valid key and no grant on the property returns `200 {}` from `/sites` — not
 * 403. Verified: that is exactly what happened before the grant was added. A
 * sync built without care would run daily, log "0 rows", exit 0, and look
 * healthy forever, which is the failure mode this issue exists to fix. So
 * `assertAccess` treats an empty or non-matching site list as an error.
 *
 * **The data lags two to three days.** On 2026-09-15 the latest available date
 * was 2026-09-13. "Nothing for yesterday" is normal and must never be read as
 * a broken sync.
 *
 * ## Auth
 *
 * Service account JWT, signed locally and exchanged for an access token. No
 * googleapis dependency: the flow is one signed assertion and one POST, and a
 * client library would be more surface than the thing it wraps.
 */

import { createServiceAccountTokenSource, parseServiceAccount } from "./google-auth";

const TOKEN_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API_BASE = "https://searchconsole.googleapis.com/webmasters/v3";

/** The API caps a single response at 25,000 rows and pages by `startRow`. */
export const GSC_MAX_ROWS = 25_000;

/** Tokens last an hour; refreshed a minute early rather than on expiry. */

export type GscDimension = "date" | "query" | "page" | "device" | "country" | "searchAppearance";

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQuery {
  startDate: string;
  endDate: string;
  dimensions: GscDimension[];
  rowLimit?: number;
}

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface SearchConsoleClient {
  listSites(): Promise<GscSite[]>;
  /** Throws unless the configured property is actually readable. */
  assertAccess(): Promise<GscSite>;
  query(q: GscQuery): Promise<GscRow[]>;
}

export interface SearchConsoleConfig {
  /** The service account JSON, verbatim, as stored in the environment. */
  credentialsJson: string;
  /** `sc-domain:radandhappy.com` for a Domain property. */
  siteUrl: string;
  fetchFn?: typeof fetch;
  /** Injected so tests exercise JWT assembly without a real RSA key. */
  signFn?: (unsigned: string, privateKey: string) => string;
  now?: () => number;
}

export function createSearchConsoleClient(config: SearchConsoleConfig): SearchConsoleClient {
  const key = parseServiceAccount(config.credentialsJson);
  const doFetch = config.fetchFn ?? fetch;
  const accessToken = createServiceAccountTokenSource({
    credentialsJson: config.credentialsJson,
    scope: TOKEN_SCOPE,
    label: "Search Console",
    fetchFn: config.fetchFn,
    signFn: config.signFn,
    now: config.now,
  });

  async function api(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await doFetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(
        `Search Console ${init.method ?? "GET"} ${path} failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`
      );
    }
    return body;
  }

  return {
    async listSites() {
      const body = (await api("/sites")) as { siteEntry?: GscSite[] };
      return body.siteEntry ?? [];
    },

    /**
     * The guard against the 200-with-nothing case.
     *
     * An ungranted service account is authenticated and useless, and the API
     * reports that state as an empty object. Reading it as "no data" is how a
     * sync establishes nothing and says so in the language of success.
     */
    async assertAccess() {
      const sites = await this.listSites();

      if (sites.length === 0) {
        throw new Error(
          `The Search Console credential authenticates but has access to no properties. ` +
            `Add ${key.client_email} as a user on the property in Search Console ` +
            `(Settings → Users and permissions). The API reports this state as an empty ` +
            `200, not an error, so it is caught here rather than read as "no traffic".`
        );
      }

      const match = sites.find((s) => s.siteUrl === config.siteUrl);
      if (!match) {
        throw new Error(
          `GSC_SITE_URL is "${config.siteUrl}" but the credential can only read: ` +
            `${sites.map((s) => s.siteUrl).join(", ")}. A Domain property is addressed as ` +
            `"sc-domain:example.com" and a URL-prefix property as "https://example.com/"; ` +
            `the wrong one returns no rows rather than an error.`
        );
      }

      return match;
    },

    async query(q) {
      const rows: GscRow[] = [];
      const pageSize = q.rowLimit ?? GSC_MAX_ROWS;

      // Paging matters on the query dimension: a busy day exceeds one page,
      // and stopping early would simply report a smaller number with nothing
      // to say it was truncated.
      for (let startRow = 0; ; startRow += pageSize) {
        const body = (await api(
          `/sites/${encodeURIComponent(config.siteUrl)}/searchAnalytics/query`,
          {
            method: "POST",
            body: JSON.stringify({
              startDate: q.startDate,
              endDate: q.endDate,
              dimensions: q.dimensions,
              rowLimit: pageSize,
              startRow,
            }),
          }
        )) as { rows?: GscRow[] };

        const page = body.rows ?? [];
        rows.push(...page);
        if (page.length < pageSize) return rows;
      }
    },
  };
}
