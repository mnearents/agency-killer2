/**
 * Who may use the hosted MCP server.
 *
 * Local, the server needed no authentication because nothing but Claude
 * Desktop on this machine could reach it. Hosted, it is on the internet in
 * front of the production database, and this module is the whole of what
 * stands between the two.
 *
 * The server does not run a login of its own. WorkOS AuthKit is the
 * authorization server: Claude registers itself there, the person signs in
 * there, and what arrives here is a token AuthKit signed. This module checks
 * the signature against AuthKit's published keys, the issuer, the expiry and,
 * when configured, the audience — and then that the person is on our own list.
 * A login AuthKit accepts is not by itself permission to read the business.
 */

import { jwtVerify, errors, type JWTVerifyGetKey } from "jose";

export interface HostedAuthConfig {
  /** AuthKit's origin, which is also the issuer of its tokens. */
  authServer: string;
  /** This server's public origin. */
  publicUrl: string;
  /** The MCP endpoint, as clients name it when asking for a token. */
  resource: string;
  /** WorkOS user IDs (`sub`) allowed in. Empty admits no one. */
  allowedUsers: Set<string>;
  /** When set, a token must name it in `aud`. */
  audience?: string;
}

export type AuthOutcome =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; reason: string };

export function parseHostedAuthConfig(
  env: Record<string, string | undefined>,
): { ok: true; config: HostedAuthConfig } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const domain = env.MCP_AUTHKIT_DOMAIN?.trim();
  const publicUrl = env.MCP_PUBLIC_URL?.trim();
  if (!domain) missing.push("MCP_AUTHKIT_DOMAIN");
  if (!publicUrl) missing.push("MCP_PUBLIC_URL");
  else if (!publicUrl.startsWith("https://")) missing.push("MCP_PUBLIC_URL (must be https)");
  if (missing.length > 0) return { ok: false, missing };

  const origin = (url: string) => url.replace(/\/+$/, "");
  const base = origin(publicUrl!);
  return {
    ok: true,
    config: {
      authServer: origin(domain!.startsWith("https://") ? domain! : `https://${domain}`),
      publicUrl: base,
      resource: `${base}/mcp`,
      allowedUsers: new Set((env.MCP_ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
      audience: env.MCP_TOKEN_AUDIENCE?.trim() || undefined,
    },
  };
}

export function createTokenVerifier(
  config: HostedAuthConfig,
  keys: JWTVerifyGetKey,
  now: () => Date,
): (authorization: string | null) => Promise<AuthOutcome> {
  return async (authorization) => {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    if (!match) return { ok: false, status: 401, reason: "no bearer token" };

    let sub: unknown;
    try {
      const { payload } = await jwtVerify(match[1], keys, {
        issuer: config.authServer,
        audience: config.audience,
        algorithms: ["RS256", "ES256"],
        currentDate: now(),
      });
      sub = payload.sub;
    } catch (err) {
      return { ok: false, status: 401, reason: describeRejection(err) };
    }

    if (typeof sub !== "string" || sub === "") return { ok: false, status: 401, reason: "token names no user" };
    if (!config.allowedUsers.has(sub)) return { ok: false, status: 403, reason: `${sub} is not in MCP_ALLOWED_USERS` };
    return { ok: true, userId: sub };
  };
}

/**
 * Why a token was refused, naming the claim's actual value where that is what
 * differs — an issuer typo is otherwise a refusal loop with no explanation.
 * Claims are not secrets; the token itself is never included.
 */
function describeRejection(err: unknown): string {
  if (err instanceof errors.JWTClaimValidationFailed) {
    const actual = err.payload[err.claim];
    return `token ${err.claim} check failed (${err.reason}): got ${JSON.stringify(actual)}`;
  }
  if (err instanceof errors.JWTExpired) return "token exp has passed";
  if (err instanceof errors.JWSSignatureVerificationFailed || err instanceof errors.JWKSNoMatchingKey) {
    return "token not signed by the auth server's keys";
  }
  return `token unreadable: ${err instanceof Error ? err.message : String(err)}`;
}

export function protectedResourceMetadata(config: HostedAuthConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.authServer],
    bearer_methods_supported: ["header"],
    resource_name: "Rad & Happy",
  };
}

/** RFC 9728: the metadata for `<origin>/mcp` lives at this path-suffixed URL. */
export function protectedResourceMetadataUrl(config: HostedAuthConfig): string {
  return `${config.publicUrl}/.well-known/oauth-protected-resource${new URL(config.resource).pathname}`;
}

export function wwwAuthenticate(config: HostedAuthConfig, error: "invalid_token" | "insufficient_scope"): string {
  return `Bearer error="${error}", resource_metadata="${protectedResourceMetadataUrl(config)}"`;
}
