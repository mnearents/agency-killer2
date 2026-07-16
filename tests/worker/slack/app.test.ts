import { describe, it, expect, vi } from "vitest";
import { parseMessage, routeCommand, type ParsedCommand } from "@/worker/slack/router";
import { formatUnknownCommand } from "@/worker/slack/formatter";
import type { SlackResponse } from "@/worker/slack/formatter";

/**
 * We can't easily test the Bolt App (it needs real Slack tokens).
 * Instead, we test that the routing + handler dispatch logic —
 * which the app.ts module uses — works correctly for all commands.
 *
 * This is a higher-level integration test of the command surface:
 * given a user message, what handler runs?
 */

const ALL_COMMANDS = [
  { input: "!ads report", handler: "meta:analysis" },
  { input: "!ads status", handler: "meta:status" },
  { input: "!ads", handler: "meta:overview" },
  { input: "!email design summer sale", handler: "email:design" },
  { input: "!email", handler: "email:overview" },
  { input: "!blog create planner tips", handler: "blog:create" },
  { input: "!blog list", handler: "blog:list" },
  { input: "!blog", handler: "blog:overview" },
  { input: "!sync meta", handler: "sync:meta" },
  { input: "!sync shopify", handler: "sync:shopify" },
  { input: "!sync all", handler: "sync:all" },
  { input: "!sync", handler: "sync:all" },
  { input: "!social analyze", handler: "social:analyze" },
  { input: "!social", handler: "social:overview" },
  { input: "!inventory check", handler: "inventory:check" },
  { input: "!inventory", handler: "inventory:overview" },
  { input: "!help", handler: "help" },
];

describe("Slack command surface: all registered commands route correctly", () => {
  for (const { input, handler } of ALL_COMMANDS) {
    it(`"${input}" → ${handler}`, () => {
      const parsed = parseMessage(input);
      expect(parsed.type).toBe("command");
      const route = routeCommand(parsed as ParsedCommand);
      expect(route.handler).toBe(handler);
    });
  }
});

describe("Slack command surface: natural language fallback", () => {
  const naturalMessages = [
    "How are my ads doing?",
    "What should I shoot next?",
    "How close are we to revenue goals?",
    "What's the plan for this month?",
  ];

  for (const msg of naturalMessages) {
    it(`"${msg}" → natural language`, () => {
      const parsed = parseMessage(msg);
      expect(parsed.type).toBe("natural");
    });
  }
});

describe("Slack command surface: bot mention stripping", () => {
  it("strips <@U12345> prefix before parsing", () => {
    // The Slack app strips this before passing to parseMessage
    const stripped = "<@U12345> !ads report"
      .replace(/<@[A-Z0-9]+>\s*/g, "")
      .trim();
    const parsed = parseMessage(stripped);
    expect(parsed.type).toBe("command");
    if (parsed.type === "command") {
      expect(parsed.category).toBe("ads");
      expect(parsed.action).toBe("report");
    }
  });
});

describe("Slack command surface: unknown command messaging", () => {
  it("formats unknown command with helpful error", () => {
    const response = formatUnknownCommand("!foobar something");
    expect(response.isError).toBe(true);
    expect(response.text).toContain("foobar");
    expect(response.text).toContain("!help");
  });
});
