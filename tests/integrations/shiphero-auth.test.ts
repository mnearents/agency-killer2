import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHIPHERO_SCOPES,
  SHIPHERO_CLIENT_ID,
  SHIPHERO_TOKEN_URL,
  SHIPHERO_REVOKE_URL,
  createPkce,
  authorizeUrl,
  exchangeCode,
  refreshTokens,
  revokeToken,
  checkGrantedScopes,
  completeSignIn,
} from "@/integrations/shiphero-auth";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("scopes requested", () => {
  // Read-only, and no personal data: view:pii and every change: scope stay out.
  it("is exactly the read scopes the sync needs, plus sign-in and refresh", () => {
    expect(SHIPHERO_SCOPES).toEqual(["openid", "profile", "offline_access", "view:orders", "view:shipments", "view:billing"]);
    expect((SHIPHERO_SCOPES as readonly string[]).some((s) => s === "view:pii" || s.startsWith("change:"))).toBe(false);
  });
});

describe("createPkce", () => {
  it("makes an S256 challenge of a long random verifier", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(b64url(createHash("sha256").update(verifier).digest()));
    expect(createPkce().verifier).not.toBe(verifier);
  });
});

describe("authorizeUrl", () => {
  it("asks ShipHero's login for a code with PKCE, the audience, the localhost callback and the scopes", () => {
    const url = new URL(authorizeUrl({ challenge: "CH", state: "ST" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://login.shiphero.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: SHIPHERO_CLIENT_ID,
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      audience: "shiphero-public-api",
      scope: "openid profile offline_access view:orders view:shipments view:billing",
      code_challenge: "CH",
      code_challenge_method: "S256",
      state: "ST",
    });
  });
});

describe("token endpoint", () => {
  it("exchanges the code with the verifier and no client secret, as a form", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ access_token: "A", refresh_token: "R", scope: "openid", expires_in: 2419200, token_type: "Bearer" }));
    const r = await exchangeCode({ code: "C", verifier: "V", fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(SHIPHERO_TOKEN_URL);
    expect(init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      grant_type: "authorization_code", client_id: SHIPHERO_CLIENT_ID, code: "C", redirect_uri: "http://localhost:3000/callback", code_verifier: "V",
    });
    expect(r).toEqual({ accessToken: "A", refreshToken: "R", scope: "openid", expiresInSeconds: 2419200 });
  });

  it("refreshes with the refresh token and returns a new one when ShipHero sends one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ access_token: "A2", refresh_token: "R2", expires_in: 100 }));
    const r = await refreshTokens({ refreshToken: "R", fetchImpl });
    expect(Object.fromEntries(new URLSearchParams(fetchImpl.mock.calls[0][1].body))).toEqual({ grant_type: "refresh_token", client_id: SHIPHERO_CLIENT_ID, refresh_token: "R" });
    expect(r).toEqual({ accessToken: "A2", refreshToken: "R2", scope: null, expiresInSeconds: 100 });
  });

  it("keeps no refresh token when ShipHero sends none", async () => {
    const r = await refreshTokens({ refreshToken: "R", fetchImpl: vi.fn().mockResolvedValue(json({ access_token: "A2", expires_in: 100 })) });
    expect(r.refreshToken).toBeNull();
  });

  it("never puts a token in an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: "invalid_grant", error_description: "bad token SECRET-R" }, 403));
    const err = await refreshTokens({ refreshToken: "SECRET-R", fetchImpl }).catch((e) => e);
    expect(err.message).toMatch(/403/);
    expect(err.message).not.toMatch(/SECRET-R/);
  });

  it("revokes a token at the revocation endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await revokeToken({ token: "R", fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(SHIPHERO_REVOKE_URL);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ client_id: SHIPHERO_CLIENT_ID, token: "R" });
  });
});

describe("checkGrantedScopes", () => {
  const all = "openid profile offline_access view:orders view:shipments view:billing";

  it("accepts exactly what was asked for", () => {
    expect(checkGrantedScopes(all)).toEqual({ ok: true, granted: all.split(" ") });
  });

  it("stops on anything extra, naming it", () => {
    expect(checkGrantedScopes(`${all} view:pii`)).toMatchObject({ ok: false, extra: ["view:pii"], reason: expect.stringMatching(/view:pii/) });
    expect(checkGrantedScopes(`${all} change:orders`)).toMatchObject({ ok: false, extra: ["change:orders"] });
  });

  // Matt's user lacks "Billing: Read", so this is the expected first outcome.
  it("stops when view:billing was not granted", () => {
    expect(checkGrantedScopes("openid profile offline_access view:orders view:shipments")).toMatchObject({ ok: false, missing: ["view:billing"], reason: expect.stringMatching(/view:billing/) });
  });

  it("stops when the shipments or orders scope is missing", () => {
    expect(checkGrantedScopes("openid profile offline_access view:orders view:billing")).toMatchObject({ ok: false, missing: ["view:shipments"] });
  });

  it("stops when ShipHero did not say what it granted", () => {
    expect(checkGrantedScopes(null)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not say/) });
  });
});

describe("never the username/password endpoint", () => {
  // Its tokens are not restricted by scopes.
  it("nothing in src calls /auth/token or /auth/refresh", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync("grep -rlE 'public-api\\.shiphero\\.com/auth' src scripts || true", { encoding: "utf-8" }).trim();
    expect(hits).toBe("");
    expect(readFileSync(join(process.cwd(), "src/integrations/shiphero-auth.ts"), "utf-8")).not.toMatch(/client_secret\s*[:=]/);
  });
});

describe("completeSignIn", () => {
  const ALL = "openid profile offline_access view:orders view:shipments view:billing";
  const reply = (scope: string, refresh = "R") => new Response(JSON.stringify({ access_token: "A", refresh_token: refresh, scope, expires_in: 2419200 }), { status: 200 });

  it("refuses a callback whose state is not the one sent, before any exchange", async () => {
    const fetchImpl = vi.fn();
    const r = await completeSignIn({ params: new URLSearchParams({ code: "C", state: "other" }), expectedState: "ST", verifier: "V", fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/state/) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes on ShipHero's own refusal", async () => {
    const r = await completeSignIn({ params: new URLSearchParams({ error: "access_denied", error_description: "User cancelled", state: "ST" }), expectedState: "ST", verifier: "V", fetchImpl: vi.fn() });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/access_denied.*User cancelled/) });
  });

  it("returns the tokens when the scopes are exactly what was asked", async () => {
    const r = await completeSignIn({ params: new URLSearchParams({ code: "C", state: "ST" }), expectedState: "ST", verifier: "V", fetchImpl: vi.fn().mockResolvedValue(reply(ALL)) });
    expect(r).toMatchObject({ ok: true, tokens: { accessToken: "A", refreshToken: "R", scope: ALL }, granted: ALL.split(" ") });
  });

  // Stop and tell Matt; keep nothing, and revoke what ShipHero issued.
  it("revokes and keeps nothing when view:billing was not granted", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply("openid profile offline_access view:orders view:shipments")).mockResolvedValueOnce(new Response("", { status: 200 }));
    const r = await completeSignIn({ params: new URLSearchParams({ code: "C", state: "ST" }), expectedState: "ST", verifier: "V", fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/view:billing/), revoked: true });
    expect(r).not.toHaveProperty("tokens");
    expect(fetchImpl.mock.calls[1][0]).toBe(SHIPHERO_REVOKE_URL);
  });

  it("revokes and keeps nothing when ShipHero granted more than was asked", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(`${ALL} view:pii`)).mockResolvedValueOnce(new Response("", { status: 200 }));
    const r = await completeSignIn({ params: new URLSearchParams({ code: "C", state: "ST" }), expectedState: "ST", verifier: "V", fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/view:pii/), revoked: true });
  });

  it("refuses a token with no refresh token, since it could not be kept alive", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "A", scope: ALL, expires_in: 2419200 }), { status: 200 })).mockResolvedValueOnce(new Response("", { status: 200 }));
    const r = await completeSignIn({ params: new URLSearchParams({ code: "C", state: "ST" }), expectedState: "ST", verifier: "V", fetchImpl });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/refresh token/) });
  });
});
