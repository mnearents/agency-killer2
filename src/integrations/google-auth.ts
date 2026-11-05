/**
 * Google service account sign-in: one signed JWT exchanged for an access
 * token, cached until a minute before it expires. No googleapis dependency —
 * the flow is one signed assertion and one POST.
 *
 * Shared by Search Console and Drive, which use the same service account
 * (GOOGLE_SERVICE_ACCOUNT_JSON) with different scopes.
 */

import { createSign } from "node:crypto";

export interface ServiceAccountAuthConfig {
  /** The service account JSON, verbatim, as stored in the environment. */
  credentialsJson: string;
  scope: string;
  /** Names the API in errors, e.g. "Search Console". */
  label: string;
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

const TOKEN_SKEW_SECONDS = 60;

function base64url(value: string | object): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function parseServiceAccount(json: string): ServiceAccountKey {
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

/** Returns a function that yields a valid access token, refreshing as needed. */
export function createServiceAccountTokenSource(config: ServiceAccountAuthConfig): () => Promise<string> {
  const key = parseServiceAccount(config.credentialsJson);
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

  return async function accessToken(): Promise<string> {
    const nowSeconds = Math.floor(now() / 1000);
    if (cachedToken && cachedToken.expiresAt - TOKEN_SKEW_SECONDS > nowSeconds) {
      return cachedToken.value;
    }

    const unsigned =
      `${base64url({ alg: "RS256", typ: "JWT" })}.` +
      base64url({
        iss: key.client_email,
        scope: config.scope,
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
        `${config.label} token exchange failed: ${res.status} ${body.error ?? JSON.stringify(body).slice(0, 200)}`
      );
    }

    cachedToken = { value: body.access_token, expiresAt: nowSeconds + (body.expires_in ?? 3600) };
    return cachedToken.value;
  };
}
