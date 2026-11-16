/**
 * MCP server entry point — stdio transport for Claude Desktop.
 *
 * Runs locally on Matt's machine and talks to the production database over the
 * same connection string the worker uses. Deliberately not an HTTP service:
 * there is no internet-facing endpoint to authenticate, and nothing here can be
 * reached by anything other than a process started by Claude Desktop itself.
 *
 * stdout belongs to the JSON-RPC protocol. Anything logged must go to stderr or
 * it corrupts the stream.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDb } from "@/db/client";
import { createAnalyticsDb } from "./analytics-db";
import { createMcpServer } from "./server";
import { createAttentiveWriteClient } from "@/integrations/attentive-write";
import { createPortalMetricsClient } from "@/integrations/portal-metrics";
import { createDropboxClient } from "@/integrations/dropbox";
import { createEmbeddingClient } from "@/integrations/openai";
import { checkEnv, formatEnvCheck } from "@/config/env-manifest";

async function main() {
  // The whole manifest, not just the failures (#35). A silent pass is
  // indistinguishable from a check that never ran, and stderr is the only
  // channel available here — stdout carries JSON-RPC.
  for (const line of formatEnvCheck(checkEnv("mcp", process.env))) {
    console.error(line);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[mcp] DATABASE_URL not set");
    process.exit(1);
  }

  // A second, deliberately weaker connection for the `query` tool. Missing is
  // a supported state: the rest of the server still works and that one tool
  // reports itself unavailable. What must never happen is DATABASE_URL being
  // used in its place — that would hand arbitrary SQL the owner's privileges.
  const analyticsUrl = process.env.ANALYTICS_DATABASE_URL;
  if (!analyticsUrl) {
    console.error("[mcp] ANALYTICS_DATABASE_URL not set — the query tool will be unavailable");
  }

  // The segment push tools. Absent is a supported state and they say so
  // rather than no-opping — but note where this key deliberately is NOT: the
  // worker process that runs every cron does not hold it, and `src/worker/`
  // imports nothing from `src/mcp/`. That is how "no cron may push a segment,
  // ever" is guaranteed by construction rather than by a test asserting a
  // negative about the scheduler.
  const attentiveKey = process.env.ATTENTIVE_API_KEY;
  if (!attentiveKey) {
    console.error("[mcp] ATTENTIVE_API_KEY not set — the segment push tools will be unavailable");
  }

  // Knowledge-base search. Absent is supported: kb_search falls back to a
  // literal text match and labels itself `text` rather than presenting a worse
  // search under the same name as the good one.
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error("[mcp] OPENAI_API_KEY not set — kb_search will fall back to literal text matching");
  }

  // The RAD portal's email metrics. Absent, both tools say it is not
  // configured; the token itself is held by the client and never logged.
  const portalUrl = process.env.RAD_PORTAL_URL;
  const metricsToken = process.env.METRICS_INGEST_TOKEN;
  if (!portalUrl || !metricsToken) {
    console.error("[mcp] RAD_PORTAL_URL or METRICS_INGEST_TOKEN not set — the email metrics tools will be unavailable");
  }

  // Dropbox, read-only, for photo_view to show one photo at full size.
  // Without it contact sheets still work, from stored thumbnails.
  const dropboxKey = process.env.DROPBOX_APP_KEY;
  const dropboxSecret = process.env.DROPBOX_APP_SECRET;
  const dropboxRefresh = process.env.DROPBOX_REFRESH_TOKEN;
  const dropbox = dropboxKey && dropboxSecret && dropboxRefresh ? createDropboxClient(dropboxKey, dropboxSecret, dropboxRefresh) : undefined;
  if (!dropbox) console.error("[mcp] Dropbox credentials not set — photo_view will show contact sheets only");

  const server = createMcpServer({
    db: createDb(databaseUrl),
    now: () => new Date(),
    analytics: analyticsUrl ? createAnalyticsDb(analyticsUrl) : undefined,
    attentive: attentiveKey ? createAttentiveWriteClient({ apiKey: attentiveKey }) : undefined,
    embeddings: openaiKey ? createEmbeddingClient(openaiKey) : undefined,
    portalMetrics: portalUrl && metricsToken ? createPortalMetricsClient({ baseUrl: portalUrl, token: metricsToken }) : undefined,
    photoFiles: dropbox,
  });

  await server.connect(new StdioServerTransport());
  console.error("[mcp] rad-and-happy server ready on stdio");
}

main().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});
