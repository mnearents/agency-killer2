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
import { checkEnv, formatEnvCheck } from "@/lib/env-check";
import { createAnalyticsDb } from "./analytics-db";
import { createMcpServer } from "./server";

async function main() {
  // Every expected variable and whether it arrived, before anything else runs.
  // stderr, not stdout — stdout is the JSON-RPC channel.
  for (const line of formatEnvCheck(checkEnv("mcp", process.env, new Date()))) {
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

  const server = createMcpServer({
    db: createDb(databaseUrl),
    now: () => new Date(),
    analytics: analyticsUrl ? createAnalyticsDb(analyticsUrl) : undefined,
    env: process.env,
  });

  await server.connect(new StdioServerTransport());
  console.error("[mcp] rad-and-happy server ready on stdio");
}

main().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});
