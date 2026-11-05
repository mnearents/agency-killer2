import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import {
  createTokenVerifier,
  parseHostedAuthConfig,
  protectedResourceMetadata,
  wwwAuthenticate,
  type HostedAuthConfig,
} from "@/mcp/hosted-auth";

const NOW = new Date("2026-11-05T18:00:00Z");
const ISSUER = "https://rad-and-happy.authkit.app";

const config: HostedAuthConfig = {
  authServer: ISSUER,
  publicUrl: "https://mcp.radandhappy.example",
  resource: "https://mcp.radandhappy.example/mcp",
  allowedUsers: new Set(["user_matt"]),
};

let keys: JWTVerifyGetKey;
let sign: (claims: Record<string, unknown>, opts?: { iss?: string; exp?: Date; key?: "other" }) => Promise<string>;

beforeAll(async () => {
  const real = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(real.publicKey)), kid: "k1", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? ISSUER)
      .setIssuedAt(Math.floor(NOW.getTime() / 1000) - 60)
      .setExpirationTime(opts.exp ?? new Date(NOW.getTime() + 3600_000))
      .sign(opts.key === "other" ? other.privateKey : real.privateKey);
});

const verifier = () => createTokenVerifier(config, keys, () => NOW);

describe("createTokenVerifier", () => {
  it("admits an allowed user holding a token the auth server signed", async () => {
    const token = await sign({ sub: "user_matt" });
    expect(await verifier()(`Bearer ${token}`)).toEqual({ ok: true, userId: "user_matt" });
  });

  // Each refusal below is the whole security of a server on the internet.
  it("refuses a request with no token", async () => {
    expect(await verifier()(null)).toMatchObject({ ok: false, status: 401, reason: "no bearer token" });
  });

  it("refuses a header that is not a bearer token", async () => {
    expect(await verifier()("Basic bWF0dDpwdw==")).toMatchObject({ ok: false, status: 401, reason: "no bearer token" });
  });

  it("refuses a token signed by any other key", async () => {
    const token = await sign({ sub: "user_matt" }, { key: "other" });
    expect(await verifier()(`Bearer ${token}`)).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses an expired token", async () => {
    const token = await sign({ sub: "user_matt" }, { exp: new Date(NOW.getTime() - 1000) });
    expect(await verifier()(`Bearer ${token}`)).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/exp/) });
  });

  // Names the issuer it saw, so a misconfigured domain is diagnosable from
  // the log rather than by trial.
  it("refuses a token from another issuer and names it", async () => {
    const token = await sign({ sub: "user_matt" }, { iss: "https://someone-else.authkit.app" });
    expect(await verifier()(`Bearer ${token}`)).toMatchObject({
      ok: false, status: 401, reason: expect.stringContaining("someone-else.authkit.app"),
    });
  });

  it("refuses garbage", async () => {
    expect(await verifier()("Bearer not.a.jwt")).toMatchObject({ ok: false, status: 401 });
  });

  // A genuine login by someone not on the list is a different answer from a
  // bad token: re-authenticating will not help, so it is 403, and the user ID
  // is named so adding them is one copy and paste.
  it("refuses a real user who is not on the allow list, naming them", async () => {
    const token = await sign({ sub: "user_stranger" });
    expect(await verifier()(`Bearer ${token}`)).toEqual({
      ok: false, status: 403, reason: "user_stranger is not in MCP_ALLOWED_USERS",
    });
  });

  it("refuses everyone when the allow list is empty", async () => {
    const token = await sign({ sub: "user_matt" });
    const v = createTokenVerifier({ ...config, allowedUsers: new Set() }, keys, () => NOW);
    expect(await v(`Bearer ${token}`)).toMatchObject({ ok: false, status: 403 });
  });

  it("checks the audience when one is configured", async () => {
    const v = createTokenVerifier({ ...config, audience: config.resource }, keys, () => NOW);
    expect(await v(`Bearer ${await sign({ sub: "user_matt", aud: "client_other" })}`)).toMatchObject({ ok: false, status: 401 });
    expect(await v(`Bearer ${await sign({ sub: "user_matt", aud: config.resource })}`)).toMatchObject({ ok: true });
  });

  it("refuses a token with no subject", async () => {
    expect(await verifier()(`Bearer ${await sign({})}`)).toMatchObject({ ok: false, status: 401 });
  });
});

describe("parseHostedAuthConfig", () => {
  const env = {
    MCP_AUTHKIT_DOMAIN: "https://rad-and-happy.authkit.app/",
    MCP_PUBLIC_URL: "https://mcp.radandhappy.example/",
    MCP_ALLOWED_USERS: " user_matt, user_tara ,",
  };

  it("reads the domain, the public URL and the allow list", () => {
    expect(parseHostedAuthConfig(env)).toEqual({
      ok: true,
      config: {
        authServer: "https://rad-and-happy.authkit.app",
        publicUrl: "https://mcp.radandhappy.example",
        resource: "https://mcp.radandhappy.example/mcp",
        allowedUsers: new Set(["user_matt", "user_tara"]),
        audience: undefined,
      },
    });
  });

  it("accepts a bare domain for AuthKit", () => {
    const r = parseHostedAuthConfig({ ...env, MCP_AUTHKIT_DOMAIN: "rad-and-happy.authkit.app" });
    expect(r.ok && r.config.authServer).toBe("https://rad-and-happy.authkit.app");
  });

  // Without either there is no way to authenticate anyone. Starting anyway
  // would serve an endpoint that refuses everything and looks merely broken.
  it("names what is missing rather than starting without login", () => {
    expect(parseHostedAuthConfig({})).toEqual({ ok: false, missing: ["MCP_AUTHKIT_DOMAIN", "MCP_PUBLIC_URL"] });
  });

  // An empty list is a supported first-run state: the first sign-in is
  // refused and logged with the user ID to add.
  it("starts with an empty allow list", () => {
    const r = parseHostedAuthConfig({ ...env, MCP_ALLOWED_USERS: undefined });
    expect(r.ok && r.config.allowedUsers.size).toBe(0);
  });

  it("refuses a public URL that is not https", () => {
    expect(parseHostedAuthConfig({ ...env, MCP_PUBLIC_URL: "http://mcp.example" })).toEqual({
      ok: false, missing: ["MCP_PUBLIC_URL (must be https)"],
    });
  });
});

describe("discovery", () => {
  it("points clients at the auth server for this resource", () => {
    expect(protectedResourceMetadata(config)).toEqual({
      resource: "https://mcp.radandhappy.example/mcp",
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      resource_name: "Rad & Happy",
    });
  });

  it("tells a refused client where the metadata is", () => {
    expect(wwwAuthenticate(config, "invalid_token")).toBe(
      'Bearer error="invalid_token", resource_metadata="https://mcp.radandhappy.example/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
