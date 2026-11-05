/**
 * Hosted MCP server entry point — Streamable HTTP on Railway, for claude.ai
 * connectors (Desktop, web and phone).
 *
 * It serves people WorkOS AuthKit has signed in and MCP_ALLOWED_USERS names.
 * Read-only tools only, unless MCP_WRITE_TOOLS is exactly `on` — then every
 * tool, including the segment push when ATTENTIVE_API_KEY is also set. The
 * worker still holds no Attentive key and imports nothing from here, so no
 * cron can push a segment whatever this service is configured to do.
 */

import { createServer } from "node:http";
import { createRemoteJWKSet } from "jose";
import { createDb } from "@/db/client";
import { createAnalyticsDb } from "./analytics-db";
import { createEmbeddingClient } from "@/integrations/openai";
import { createAttentiveWriteClient } from "@/integrations/attentive-write";
import { checkEnv, formatEnvCheck } from "@/config/env-manifest";
import { createHostedHandler } from "./hosted";
import { createTokenVerifier, parseHostedAuthConfig } from "./hosted-auth";

/** No MCP request is anywhere near this; anything larger is refused unread. */
const MAX_BODY_BYTES = 1_000_000;

function main() {
  for (const line of formatEnvCheck(checkEnv("mcp-hosted", process.env))) console.log(line);

  const parsed = parseHostedAuthConfig(process.env);
  if (!parsed.ok) {
    // Refusing to start is the fail-closed choice: an endpoint with no way to
    // authenticate anyone must not be up at all.
    console.error(`[mcp-hosted] cannot start without login configured: ${parsed.missing.join(", ")}`);
    process.exit(1);
  }
  const auth = parsed.config;
  if (auth.allowedUsers.size === 0) {
    console.error("[mcp-hosted] MCP_ALLOWED_USERS is empty — every sign-in will be refused, and logged with the user ID to add");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[mcp-hosted] DATABASE_URL not set");
    process.exit(1);
  }
  const analyticsUrl = process.env.ANALYTICS_DATABASE_URL;
  const openaiKey = process.env.OPENAI_API_KEY;
  const attentiveKey = process.env.ATTENTIVE_API_KEY;
  const allowWrites = process.env.MCP_WRITE_TOOLS === "on";

  let metadata: { at: number; body: unknown } | null = null;
  const handler = createHostedHandler({
    auth,
    verify: createTokenVerifier(auth, createRemoteJWKSet(new URL(`${auth.authServer}/oauth2/jwks`)), () => new Date()),
    ctx: {
      db: createDb(databaseUrl),
      now: () => new Date(),
      analytics: analyticsUrl ? createAnalyticsDb(analyticsUrl) : undefined,
      embeddings: openaiKey ? createEmbeddingClient(openaiKey) : undefined,
      attentive: allowWrites && attentiveKey ? createAttentiveWriteClient({ apiKey: attentiveKey }) : undefined,
    },
    allowWrites,
    async fetchAuthServerMetadata() {
      if (metadata && Date.now() - metadata.at < 3_600_000) return metadata.body;
      const res = await fetch(`${auth.authServer}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`AuthKit answered ${res.status}`);
      metadata = { at: Date.now(), body: await res.json() };
      return metadata.body;
    },
    log: (line) => console.log(line),
  });

  const server = createServer(async (nodeReq, nodeRes) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of nodeReq) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) {
          nodeRes.writeHead(413).end();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(nodeReq.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const method = nodeReq.method ?? "GET";
      // The public URL, not the Host header, so a forged Host changes nothing.
      const req = new Request(new URL(nodeReq.url ?? "/", auth.publicUrl), {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
      });

      const res = await handler(req);
      nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
      if (res.body) {
        const reader = res.body.getReader();
        for (let r = await reader.read(); !r.done; r = await reader.read()) nodeRes.write(r.value);
      }
      nodeRes.end();
    } catch (err) {
      console.error("[mcp-hosted] request failed:", err);
      if (!nodeRes.headersSent) nodeRes.writeHead(500);
      nodeRes.end();
    }
  });

  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => {
    console.log(`[mcp-hosted] listening on ${port} — ${auth.resource}, sign-in by ${auth.authServer}, ${auth.allowedUsers.size} allowed user(s), ${allowWrites ? `write tools ON${attentiveKey ? "" : " (segment push unavailable: no ATTENTIVE_API_KEY)"}` : "read-only tools only"}`);
  });
}

main();
