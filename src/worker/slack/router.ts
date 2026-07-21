/**
 * Slack message router — parses incoming messages and routes to handlers.
 *
 * Two routing modes:
 * 1. Structured commands: "!ads report", "!email design", "!blog create"
 * 2. Natural language: anything else goes to the AI for interpretation
 *
 * Commands are prefixed with "!" to distinguish from natural conversation.
 * Everything without "!" is treated as a natural language query routed
 * to the orchestrator.
 */

export type CommandCategory =
  | "ads"
  | "email"
  | "blog"
  | "social"
  | "inventory"
  | "shopify"
  | "sync"
  | "notes"
  | "help"
  | "unknown";

export interface ParsedCommand {
  type: "command";
  category: CommandCategory;
  action: string;
  args: string;
  raw: string;
}

export interface NaturalLanguageQuery {
  type: "natural";
  text: string;
  raw: string;
}

export type ParsedMessage = ParsedCommand | NaturalLanguageQuery;

export interface RouteResult {
  handler: string;
  params: Record<string, string>;
}

const VALID_CATEGORIES = new Set<CommandCategory>([
  "ads",
  "email",
  "blog",
  "social",
  "inventory",
  "shopify",
  "sync",
  "notes",
  "help",
]);

export function parseMessage(text: string): ParsedMessage {
  const raw = text;
  const trimmed = text.trim();

  if (!trimmed.startsWith("!")) {
    return { type: "natural", text: trimmed, raw };
  }

  // Remove "!" and split into parts
  const withoutBang = trimmed.slice(1).trim();
  const parts = withoutBang.split(/\s+/);
  const rawCategory = (parts[0] ?? "").toLowerCase();
  const action = (parts[1] ?? "").toLowerCase();
  const args = parts.slice(2).join(" ");

  const category: CommandCategory = VALID_CATEGORIES.has(
    rawCategory as CommandCategory
  )
    ? (rawCategory as CommandCategory)
    : "unknown";

  return { type: "command", category, action, args, raw };
}

const COMMAND_ROUTES: Record<string, Record<string, string>> = {
  ads: {
    report: "meta:analysis",
    status: "meta:status",
    "": "meta:overview",
  },
  email: {
    design: "email:design",
    calendar: "email:calendar",
    "": "email:overview",
  },
  blog: {
    create: "blog:create",
    list: "blog:list",
    "": "blog:overview",
  },
  social: {
    analyze: "social:analyze",
    reel: "social:reel",
    "": "social:overview",
  },
  inventory: {
    check: "inventory:check",
    alerts: "inventory:alerts",
    "": "inventory:overview",
  },
  shopify: {
    status: "shopify:status",
    ltv: "shopify:ltv",
    "": "shopify:status",
  },
  notes: {
    "": "notes:add",
  },
  sync: {
    meta: "sync:meta",
    shopify: "sync:shopify",
    kb: "sync:knowledge-base",
    all: "sync:all",
    "": "sync:all",
  },
  help: {
    "": "help",
  },
};

export function routeCommand(command: ParsedCommand): RouteResult {
  if (command.category === "unknown") {
    return { handler: "unknown", params: {} };
  }

  const categoryRoutes = COMMAND_ROUTES[command.category];
  const handler =
    categoryRoutes?.[command.action] ??
    categoryRoutes?.[""] ??
    "unknown";

  const params: Record<string, string> = {};

  // Map args to named params based on handler
  if (command.args) {
    if (handler === "email:design") {
      params.brief = command.args;
    } else if (handler === "blog:create") {
      params.topic = command.args;
    } else {
      params.query = command.args;
    }
  }

  return { handler, params };
}
