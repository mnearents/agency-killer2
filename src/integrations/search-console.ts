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

import { createSign } from "node:crypto";

const TOKEN_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API_BASE = "https://searchconsole.googleapis.com/webmasters/v3";

/** The API caps a single response at 25,000 rows and pages by `startRow`. */
export const GSC_MAX_ROWS = 25_000;

/** Tokens last an hour; refreshed a minute early rather than on expiry. */
const TOKEN_SKEW_SECONDS = 60;

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

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

function base64url(value: string | object): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function parseCredentials(json: string): ServiceAccountKey {
  let parsed: Partial<ServiceAccountKey>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. It should be the downloaded service " +
        "account key file verbatim."
    );
  }
  for (const field of ["client_email", "private_key"] as const) {
    if (!parsed[field]) {
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is missing "${field}".`);
    }
  }
  return {
    client_email: parsed.client_email!,
    private_key: parsed.private_key!,
    token_uri: parsed.token_uri ?? "https://oauth2.googleapis.com/token",
  };
}

export function createSearchConsoleClient(config: SearchConsoleConfig): SearchConsoleClient {
  const key = parseCredentials(config.credentialsJson);
  const doFetch = config.fetchFn ?? fetch;
  const now = config.now ?? (() => Date.now());
  const sign =
    config.signFn ??
    ((unsigned: string, privateKey: string) =>
      createSign("RSA-SHA256")
        .update(unsigned)
        .sign(privateKey, "base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_"));

  let cachedToken: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    const nowSeconds = Math.floor(now() / 1000);
    if (cachedToken && cachedToken.expiresAt - TOKEN_SKEW_SECONDS > nowSeconds) {
      return cachedToken.value;
    }

    const unsigned =
      `${base64url({ alg: "RS256", typ: "JWT" })}.` +
      base64url({
        iss: key.client_email,
        scope: TOKEN_SCOPE,
        aud: key.token_uri,
        exp: nowSeconds + 3600,
        iat: nowSeconds,
      });

    const res = await doFetch(key.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${sign(unsigned, key.private_key)}`,
      }).toString(),
    });

    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(
        `Search Console token exchange failed: ${res.status} ${body.error ?? JSON.stringify(body).slice(0, 200)}`
      );
    }

    cachedToken = { value: body.access_token, expiresAt: nowSeconds + (body.expires_in ?? 3600) };
    return cachedToken.value;
  }

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
