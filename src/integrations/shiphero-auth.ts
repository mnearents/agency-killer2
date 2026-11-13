/**
 * ShipHero sign-in: OAuth 2.0 Authorization Code + PKCE, per
 * developer.shiphero.com/scopes. Never the username/password endpoint
 * (/auth/token), whose tokens are not restricted by scope.
 *
 * The scopes are read-only and exclude personal data: no `view:pii`, no
 * `change:` scope. ShipHero may grant other than what was asked, so the
 * granted `scope` is checked before a token is kept (`checkGrantedScopes`).
 * There is no client secret; the client ID is ShipHero's public one.
 *
 * Tokens travel only in form bodies and the Authorization header, and are
 * scrubbed from every error.
 */

import { createHash, randomBytes } from "node:crypto";

export const SHIPHERO_AUTHORIZE_URL = "https://login.shiphero.com/authorize";
export const SHIPHERO_TOKEN_URL = "https://login.shiphero.com/oauth/token";
export const SHIPHERO_REVOKE_URL = "https://login.shiphero.com/oauth/revoke";
export const SHIPHERO_CLIENT_ID = "GcdtO6dRNDOWmmoqa5vtGHlSTjeG3I0Z";
export const SHIPHERO_AUDIENCE = "shiphero-public-api";
export const SHIPHERO_REDIRECT_URI = "http://localhost:3000/callback";

export const SHIPHERO_SCOPES = ["openid", "profile", "offline_access", "view:orders", "view:shipments", "view:billing"] as const;
/** Without these the sync cannot do its job, so a token lacking one is not kept. */
const REQUIRED_SCOPES = ["view:orders", "view:shipments", "view:billing"] as const;

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export const randomState = () => b64url(randomBytes(24));

export function authorizeUrl(p: { challenge: string; state: string }): string {
  const url = new URL(SHIPHERO_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: SHIPHERO_CLIENT_ID,
    redirect_uri: SHIPHERO_REDIRECT_URI,
    response_type: "code",
    audience: SHIPHERO_AUDIENCE,
    scope: SHIPHERO_SCOPES.join(" "),
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
  }).toString();
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  /** Null when ShipHero sent none — on a refresh, keep the one held. */
  refreshToken: string | null;
  /** The scopes ShipHero says it granted; null when it did not say. */
  scope: string | null;
  expiresInSeconds: number;
}

async function tokenRequest(form: Record<string, string>, secrets: string[], fetchImpl: typeof fetch): Promise<TokenSet> {
  const scrub = (text: string) => secrets.reduce((t, s) => (s ? t.split(s).join("[token]") : t), text).slice(0, 300);
  const res = await fetchImpl(SHIPHERO_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(scrub(`ShipHero's token endpoint answered ${res.status}: ${text}`));
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`ShipHero's token endpoint sent an unreadable reply (${res.status})`);
  }
  if (typeof body.access_token !== "string" || body.access_token === "") throw new Error("ShipHero's token endpoint returned no access_token");
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : null,
    scope: typeof body.scope === "string" ? body.scope : null,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 0,
  };
}

export function exchangeCode(p: { code: string; verifier: string; fetchImpl?: typeof fetch }): Promise<TokenSet> {
  return tokenRequest(
    { grant_type: "authorization_code", client_id: SHIPHERO_CLIENT_ID, code: p.code, redirect_uri: SHIPHERO_REDIRECT_URI, code_verifier: p.verifier },
    [p.code, p.verifier],
    p.fetchImpl ?? fetch,
  );
}

export function refreshTokens(p: { refreshToken: string; fetchImpl?: typeof fetch }): Promise<TokenSet> {
  return tokenRequest({ grant_type: "refresh_token", client_id: SHIPHERO_CLIENT_ID, refresh_token: p.refreshToken }, [p.refreshToken], p.fetchImpl ?? fetch);
}

export async function revokeToken(p: { token: string; fetchImpl?: typeof fetch }): Promise<boolean> {
  const res = await (p.fetchImpl ?? fetch)(SHIPHERO_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: SHIPHERO_CLIENT_ID, token: p.token }),
  });
  return res.ok;
}

export type ScopeCheck =
  | { ok: true; granted: string[] }
  | { ok: false; reason: string; granted: string[]; extra: string[]; missing: string[] };

/** Exactly what was asked for or less, and never without the scopes the sync needs. */
export function checkGrantedScopes(scope: string | null | undefined): ScopeCheck {
  if (typeof scope !== "string" || scope.trim() === "") {
    return { ok: false, reason: "ShipHero did not say which scopes it granted, so the token is not trusted.", granted: [], extra: [], missing: [] };
  }
  const granted = scope.trim().split(/\s+/);
  const extra = granted.filter((s) => !(SHIPHERO_SCOPES as readonly string[]).includes(s));
  const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
  if (extra.length === 0 && missing.length === 0) return { ok: true, granted };
  const parts = [
    extra.length > 0 && `ShipHero granted scope(s) that were not requested: ${extra.join(", ")}.`,
    missing.length > 0 && `ShipHero did not grant ${missing.join(", ")}${missing.includes("view:billing") ? " (the signed-in user needs the \"Billing: Read\" permission)" : ""}.`,
  ].filter(Boolean);
  return { ok: false, reason: parts.join(" "), granted, extra, missing: [...missing] };
}

export type SignInResult =
  | { ok: true; tokens: TokenSet & { refreshToken: string; scope: string }; granted: string[] }
  | { ok: false; reason: string; revoked?: boolean; granted?: string[] };

/**
 * The callback, handled: the state must be the one sent; the code is
 * exchanged; the granted scopes must be exactly those asked for, with
 * view:billing among them, and a refresh token must come back. Anything else
 * is refused, and a token ShipHero did issue is revoked rather than left live.
 */
export async function completeSignIn(p: { params: URLSearchParams; expectedState: string; verifier: string; fetchImpl?: typeof fetch }): Promise<SignInResult> {
  if (p.params.get("state") !== p.expectedState) return { ok: false, reason: "The callback's state does not match the one sent, so it was ignored." };
  const error = p.params.get("error");
  if (error) return { ok: false, reason: `ShipHero refused the sign-in: ${error}${p.params.get("error_description") ? ` — ${p.params.get("error_description")}` : ""}` };
  const code = p.params.get("code");
  if (!code) return { ok: false, reason: "The callback carried no authorization code." };

  const tokens = await exchangeCode({ code, verifier: p.verifier, fetchImpl: p.fetchImpl });
  const check = checkGrantedScopes(tokens.scope);
  const refusal = !check.ok ? check.reason : tokens.refreshToken === null ? "ShipHero returned no refresh token (offline_access), so the token could not be kept alive." : null;
  if (refusal) {
    const revoked = await revokeToken({ token: tokens.refreshToken ?? tokens.accessToken, fetchImpl: p.fetchImpl }).catch(() => false);
    return { ok: false, reason: refusal, revoked, granted: check.granted };
  }
  return { ok: true, tokens: { ...tokens, refreshToken: tokens.refreshToken!, scope: tokens.scope! }, granted: check.granted };
}
