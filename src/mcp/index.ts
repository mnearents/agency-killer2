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
import { createMcpServer } from "./server";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[mcp] DATABASE_URL not set");
    process.exit(1);
  }

  const server = createMcpServer({
    db: createDb(databaseUrl),
    now: () => new Date(),
  });

  await server.connect(new StdioServerTransport());
  console.error("[mcp] rad-and-happy server ready on stdio");
}

main().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});
