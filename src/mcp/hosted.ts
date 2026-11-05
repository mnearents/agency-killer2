/**
 * The hosted MCP server's HTTP surface — Streamable HTTP for claude.ai
 * connectors, behind WorkOS AuthKit login.
 *
 * Written over web-standard Request and Response so it can be tested without
 * a socket; `serve.ts` adapts it to Node's HTTP server.
 *
 * Every request to /mcp is authenticated before anything else happens, and a
 * new stateless server answers it: there are no sessions to hijack or leak
 * between users, and nothing held between requests but the database pool.
 *
 * Write tools are served only when `allowWrites` is set (MCP_WRITE_TOOLS=on).
 * Locally they were protected partly by nothing being able to reach them;
 * here that is gone, so serving them is a decision recorded in the
 * environment, and the default is read-only.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./server";
import type { McpToolContext } from "./tools";
import {
  protectedResourceMetadata,
  wwwAuthenticate,
  type AuthOutcome,
  type HostedAuthConfig,
} from "./hosted-auth";

export interface HostedDeps {
  auth: HostedAuthConfig;
  verify: (authorization: string | null) => Promise<AuthOutcome>;
  ctx: McpToolContext;
  /** Serve the write tools too. Off means read-only tools only. */
  allowWrites: boolean;
  /** AuthKit's own authorization server metadata, for clients that ask us for it. */
  fetchAuthServerMetadata: () => Promise<unknown>;
  log: (line: string) => void;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function createHostedHandler(deps: HostedDeps): (req: Request) => Promise<Response> {
  const { auth, verify, ctx, log } = deps;
  const mcpPath = new URL(auth.resource).pathname;

  return async (req) => {
    const { pathname } = new URL(req.url);

    if (pathname === "/health") return new Response("ok");

    if (pathname === "/.well-known/oauth-protected-resource" || pathname === `/.well-known/oauth-protected-resource${mcpPath}`) {
      return json(protectedResourceMetadata(auth));
    }

    if (pathname === "/.well-known/oauth-authorization-server") {
      try {
        return json(await deps.fetchAuthServerMetadata());
      } catch (err) {
        log(`[mcp-hosted] could not fetch AuthKit metadata: ${err instanceof Error ? err.message : String(err)}`);
        return json({ error: "auth server metadata unavailable" }, 502);
      }
    }

    if (pathname !== mcpPath) return json({ error: "not found" }, 404);

    const outcome = await verify(req.headers.get("authorization"));
    if (!outcome.ok) {
      log(`[mcp-hosted] refused ${req.method} ${pathname} ${outcome.status}: ${outcome.reason}`);
      const error = outcome.status === 403 ? "insufficient_scope" : "invalid_token";
      return json(
        { error, error_description: outcome.status === 403 ? "This account is not allowed to use this server." : "Sign in required." },
        outcome.status,
        { "www-authenticate": wwwAuthenticate(auth, error) },
      );
    }

    // Parsed here so the log can say who called what — the audit trail a
    // server on the internet should have. The transport takes it as is.
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
      }
      for (const message of Array.isArray(body) ? body : [body]) {
        const m = message as { method?: string; params?: { name?: string } };
        if (m?.method) log(`[mcp-hosted] ${outcome.userId} ${m.method}${m.method === "tools/call" && m.params?.name ? ` ${m.params.name}` : ""}`);
      }
    }

    const actor = auth.userNames.get(outcome.userId) ?? outcome.userId;
    const server = createMcpServer({ ...ctx, actor }, { readOnly: !deps.allowWrites });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req, {
        parsedBody: body,
        authInfo: { token: "", clientId: outcome.userId, scopes: [], extra: { userId: outcome.userId } },
      });
    } finally {
      await server.close();
    }
  };
}
