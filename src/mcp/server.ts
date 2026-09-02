/**
 * MCP server construction — transport-agnostic.
 *
 * The entry point (index.ts) only picks a transport and connects. Everything
 * that can be wrong lives here so it can be tested without a socket.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { READ_TOOLS, dispatchTool, toJsonSchema, type McpToolContext } from "./tools";

// A type alias rather than an interface: the SDK's result union is indexed by
// an implicit signature that interfaces do not satisfy.
export type ToolCallResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Run a tool and shape the result for MCP.
 *
 * Errors are RETURNED, not thrown: a throw would tear down the stdio transport
 * and end the session, and a caller that cannot see the error cannot correct
 * itself. An error result carries the message and nothing else — never a
 * partial payload that could be mistaken for a complete answer.
 */
export async function runToolCall(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown> | undefined
): Promise<ToolCallResult> {
  try {
    const result = await dispatchTool(ctx, name, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Tool "${name}" failed: ${message}` }],
      isError: true,
    };
  }
}

export function createMcpServer(ctx: McpToolContext): Server {
  const server = new Server(
    { name: "rad-and-happy", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: READ_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toJsonSchema(tool.schema),
      annotations: { readOnlyHint: tool.readOnly },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    runToolCall(ctx, request.params.name, request.params.arguments)
  );

  return server;
}
