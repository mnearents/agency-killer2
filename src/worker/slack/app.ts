/**
 * Slack app — connects Bolt SDK to our message router and handlers.
 *
 * Uses socket mode (no public webhook URL needed). The app listens
 * for messages mentioning the bot, parses them through the router,
 * and dispatches to the appropriate handler or orchestrator.
 */

import { App } from "@slack/bolt";
import { parseMessage, routeCommand } from "./router";
import { formatOrchestratorResult, formatUnknownCommand, type SlackResponse } from "./formatter";
import type { OrchestratorRequest, OrchestratorResult } from "@/ai/orchestrator";

export interface SlackAppDeps {
  runOrchestrator: (request: OrchestratorRequest) => Promise<OrchestratorResult>;
  handlers: Record<string, (args: string) => Promise<SlackResponse>>;
}

export function createSlackApp(deps: SlackAppDeps) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    console.warn("[slack] SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set — Slack bot disabled");
    return null;
  }

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  // Listen for messages that mention the bot or are DMs
  app.message(async ({ message, say }) => {
    // Only handle messages with text (not file uploads, etc.)
    if (!("text" in message) || !message.text) return;

    const text = message.text
      // Strip bot mention if present (e.g., "<@U12345> !ads report" → "!ads report")
      .replace(/<@[A-Z0-9]+>\s*/g, "")
      .trim();

    if (!text) return;

    const parsed = parseMessage(text);

    let response: SlackResponse;

    if (parsed.type === "natural") {
      // Route natural language to the orchestrator
      const result = await deps.runOrchestrator({
        prompt: parsed.text,
        system: "You are a marketing assistant for Rad & Happy, a stationery brand. Answer the user's question based on available data. Be friendly, specific, and actionable.",
      });
      response = formatOrchestratorResult(result);
    } else {
      // Route structured commands
      const route = routeCommand(parsed);

      if (route.handler === "unknown") {
        response = formatUnknownCommand(parsed.raw);
      } else if (route.handler === "help") {
        response = {
          text: [
            "*Available commands:*",
            "• `!ads report` — AI-generated performance analysis",
            "• `!ads status` — Quick campaign metrics",
            "• `!email design <brief>` — Generate email creative",
            "• `!blog create <topic>` — Generate a blog article",
            "• `!blog list` — List pending blog topics",
            "• `!sync meta` — Pull latest Meta ads data",
            "• `!sync shopify` — Pull latest Shopify orders",
            "• `!sync all` — Sync everything",
            "• `!social analyze` — Organic social performance",
            "• `!inventory check` — Stock level alerts",
            "• `!help` — Show this message",
            "",
            "Or just ask me anything in plain English!",
          ].join("\n"),
          isError: false,
        };
      } else {
        // Dispatch to the registered handler
        const handler = deps.handlers[route.handler];
        if (handler) {
          response = await handler(parsed.args);
        } else {
          response = {
            text: `The command was recognized but the handler "${route.handler}" isn't wired up yet.`,
            isError: true,
          };
        }
      }
    }

    await say(response.text);
  });

  return app;
}
