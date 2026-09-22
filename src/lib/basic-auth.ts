/**
 * HTTP Basic auth for the cost-entry form (#34).
 *
 * The dashboard is otherwise read-only. This is the one surface that writes,
 * which is why it is the one surface with a credential.
 *
 * **It fails closed on absent configuration.** A missing password denies every
 * request rather than allowing them: an auth check that switches itself off
 * when misconfigured is worse than none, because the deployment still looks
 * protected. On Railway an unset variable is the normal way a deploy goes
 * wrong, so this is the likely failure, not an exotic one.
 *
 * Comparison is timing-safe. The window is small over the public internet, but
 * a non-constant-time compare here would be a deliberate choice to be weaker
 * for no gain.
 */

import { timingSafeEqual } from "node:crypto";

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing_header" | "malformed" | "bad_credentials" };

export interface BasicAuthConfig {
  user: string | undefined;
  password: string | undefined;
}

/** Constant-time string comparison that does not leak length through timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself be a timing
  // signal. Comparing fixed-size digests of equal length avoids that; here the
  // simpler route is to pad both to the same length and AND in the length check.
  const length = Math.max(ab.length, bb.length);
  const pa = Buffer.alloc(length);
  const pb = Buffer.alloc(length);
  ab.copy(pa);
  bb.copy(pb);
  return timingSafeEqual(pa, pb) && ab.length === bb.length;
}

/**
 * Checks an Authorization header against configured credentials.
 *
 * Returns a reason rather than a bare boolean so the route can log why a
 * request was refused without logging the credential, and so "nobody
 * configured this" is distinguishable from "someone guessed wrong" — they need
 * opposite responses from whoever is on call.
 */
export function checkBasicAuth(header: string | null, config: BasicAuthConfig): AuthResult {
  if (!config.user || !config.password) return { ok: false, reason: "not_configured" };
  if (!header) return { ok: false, reason: "missing_header" };

  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return { ok: false, reason: "malformed" };

  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) return { ok: false, reason: "malformed" };

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  // Both compared always, so a wrong username and a wrong password take the
  // same time and neither can be enumerated separately.
  const userOk = safeEqual(user, config.user);
  const passwordOk = safeEqual(password, config.password);
  return userOk && passwordOk ? { ok: true } : { ok: false, reason: "bad_credentials" };
}

/** The header that makes a browser prompt. */
export const CHALLENGE_HEADER = {
  "WWW-Authenticate": 'Basic realm="Rad and Happy costs", charset="UTF-8"',
} as const;
