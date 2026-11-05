import { describe, it, expect, vi } from "vitest";
import { createHostedHandler } from "@/mcp/hosted";
import type { AuthOutcome, HostedAuthConfig } from "@/mcp/hosted-auth";
import { ALL_TOOLS, type McpToolContext } from "@/mcp/tools";

vi.mock("@/db/freshness", () => ({ getDataFreshness: vi.fn().mockResolvedValue([]) }));
vi.mock("@/db/quality", () => ({
  getDataQuality: vi.fn().mockResolvedValue([]),
  anyQualityIssue: vi.fn().mockReturnValue(false),
}));
vi.mock("@/db/env-health", () => ({
  getEnvHealth: vi.fn().mockResolvedValue([]),
  anyEnvProblem: vi.fn().mockReturnValue(false),
}));

const BASE = "https://mcp.radandhappy.example";
const auth: HostedAuthConfig = {
  authServer: "https://rad-and-happy.authkit.app",
  publicUrl: BASE,
  resource: `${BASE}/mcp`,
  allowedUsers: new Set(["user_matt"]),
  userNames: new Map([["user_matt", "Matt"]]),
};
const ctx: McpToolContext = { db: {} as never, now: () => new Date("2026-11-05T18:00:00Z") };

/** Admits "Bearer good", refuses "Bearer stranger" as not allowed, anything else as a bad token. */
const verify = async (header: string | null): Promise<AuthOutcome> =>
  header === "Bearer good" ? { ok: true, userId: "user_matt" }
  : header === "Bearer stranger" ? { ok: false, status: 403, reason: "user_x is not in MCP_ALLOWED_USERS" }
  : { ok: false, status: 401, reason: "no bearer token" };

function setup(opts: { allowWrites?: boolean } = {}) {
  const lines: string[] = [];
  const handler = createHostedHandler({
    auth,
    verify,
    ctx,
    allowWrites: opts.allowWrites ?? false,
    fetchAuthServerMetadata: async () => ({ issuer: auth.authServer, registration_endpoint: `${auth.authServer}/oauth2/register` }),
    log: (l) => lines.push(l),
  });
  return { handler, lines };
}

const rpc = (method: string, params: unknown = {}, token: string | null = "good") =>
  new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

async function result(res: Response) {
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: any }).result;
}

describe("hosted MCP endpoint", () => {
  it("answers a health check without a token or a database", async () => {
    const res = await setup().handler(new Request(`${BASE}/health`));
    expect(res.status).toBe(200);
  });

  it("serves the protected resource metadata at both discovery paths", async () => {
    const { handler } = setup();
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await handler(new Request(`${BASE}${path}`));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [auth.authServer] });
    }
  });

  // Clients on the older (2025-03-26) auth spec look for this on the MCP
  // server's own origin.
  it("forwards the auth server's metadata for older clients", async () => {
    const res = await setup().handler(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    expect(await res.json()).toMatchObject({ registration_endpoint: `${auth.authServer}/oauth2/register` });
  });

  // The whole security of the endpoint.
  it("refuses a request without a valid token before reaching any tool, and says where to log in", async () => {
    const { handler, lines } = setup();
    const res = await handler(rpc("tools/list", {}, null));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect(JSON.stringify(await res.json())).not.toContain("data_freshness");
    expect(lines.at(-1)).toMatch(/refused.*401.*no bearer token/);
  });

  it("refuses a signed-in user who is not allowed with 403 and logs who", async () => {
    const { handler, lines } = setup();
    const res = await handler(rpc("tools/list", {}, "stranger"));
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(lines.at(-1)).toMatch(/user_x is not in MCP_ALLOWED_USERS/);
  });

  // Hosted, the read-only guarantee no longer rests on the server being
  // unreachable, so without MCP_WRITE_TOOLS the write tools are not offered.
  it("lists only the read-only tools unless writes are switched on", async () => {
    const tools = (await result(await setup().handler(rpc("tools/list")))).tools as { name: string }[];
    const names = tools.map((t) => t.name);
    expect(names).toContain("data_freshness");
    expect(names).toContain("footage_transcript");
    for (const writer of ALL_TOOLS.filter((t) => !t.readOnly)) expect(names).not.toContain(writer.name);
    expect(names).toHaveLength(ALL_TOOLS.filter((t) => t.readOnly).length);
  });

  it("refuses to run a write tool even when called by name", async () => {
    const r = await result(await setup().handler(rpc("tools/call", { name: "calendar_add", arguments: { title: "x" } })));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/MCP_WRITE_TOOLS/);
  });

  it("offers every tool, writers included, when writes are switched on", async () => {
    const tools = (await result(await setup({ allowWrites: true }).handler(rpc("tools/list")))).tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
    // What makes Claude ask before running one.
    expect(tools.find((t) => t.name === "calendar_add")!.annotations.readOnlyHint).toBe(false);
  });

  it("logs who called a write tool", async () => {
    const { handler, lines } = setup({ allowWrites: true });
    await handler(rpc("tools/call", { name: "calendar_add", arguments: {} }));
    expect(lines).toContain("[mcp-hosted] user_matt tools/call calendar_add");
  });

  it("runs a read-only tool for an allowed user and logs who called what", async () => {
    const { handler, lines } = setup();
    const r = await result(await handler(rpc("tools/call", { name: "data_freshness", arguments: {} })));
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ sources: [] });
    expect(lines).toContain("[mcp-hosted] user_matt tools/call data_freshness");
  });

  it("returns 404 for anything else", async () => {
    expect((await setup().handler(new Request(`${BASE}/admin`))).status).toBe(404);
  });
});

// A write records who asked for it. Hosted, that is the signed-in person,
// by the name MCP_ALLOWED_USERS gives them.
describe("hosted MCP actor", () => {
  it("hands each request's tools the signed-in person's name", async () => {
    const server = await import("@/mcp/server");
    const spy = vi.spyOn(server, "createMcpServer");
    await setup().handler(rpc("tools/list"));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ actor: "Matt" }), expect.anything());
    spy.mockRestore();
  });
});
