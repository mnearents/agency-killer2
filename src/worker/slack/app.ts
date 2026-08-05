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
  /** Handlers that receive file content (e.g., CSV imports) */
  fileHandlers?: Record<string, (fileContent: string, args: string) => Promise<SlackResponse>>;
  getKbContext?: (query: string) => Promise<string>;
  /** Pull live metrics from DB based on question topic */
  getLiveContext?: (question: string) => Promise<string>;
}

/** Acknowledgment messages for slow commands so the user knows we heard them. */
const ACK_MESSAGES: Record<string, string> = {
  "notes:add": "Saving notes...",
  "sync:meta": "Syncing Meta ads data...",
  "sync:shopify": "Syncing Shopify orders...",
  "sync:knowledge-base": "Syncing knowledge base from Dropbox...",
  "sync:all": "Syncing all data sources...",
  "meta:analysis": "Analyzing ad performance...",
  "email:design": "Generating email creative...",
  "blog:create": "Generating blog article...",
  "social:analyze": "Analyzing social performance...",
  "sync:social": "Syncing Instagram data...",
  "report:weekly": "Generating weekly report...",
  "social:backfill": "Backfilling Instagram insights (this may take a few minutes)...",
  "sync:attentive": "Syncing Attentive email/SMS data (logging in and exporting reports)...",
  "import:attentive": "Importing Attentive data...",
};

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

  // Listen for all messages in channels the bot is in + DMs.
  // Using app.event('message') instead of app.message() for reliable
  // channel message delivery in socket mode.
  app.event("message", async ({ event, say, client }) => {
    const message = event as unknown as Record<string, unknown>;

    // Only handle user messages with text (skip bot messages, edits, etc.)
    if (!message.text || typeof message.text !== "string") return;
    if (message.bot_id) return; // ignore our own messages
    // Allow file_share (file uploads with text), skip other subtypes (edits, joins, etc.)
    if (message.subtype && message.subtype !== "file_share") return;

    const rawText = message.text as string;
    const text = rawText
      // Strip bot mention if present (e.g., "<@U12345> !ads report" → "!ads report")
      .replace(/<@[A-Z0-9]+>\s*/g, "")
      .trim();

    if (!text) return;

    // Respond to: ! commands, DMs, or messages that @mentioned the bot
    const isDm = message.channel_type === "im";
    const isCommand = text.startsWith("!");
    const wasMentioned = /<@[A-Z0-9]+>/.test(rawText);
    if (!isDm && !isCommand && !wasMentioned) return;

    const files = Array.isArray(message.files) ? message.files as Array<Record<string, unknown>> : [];
    console.log(`[slack] Received: "${text.slice(0, 80)}" (${isDm ? "DM" : "channel"}, files: ${files.length})`);

    const parsed = parseMessage(text);

    let response: SlackResponse;

    try {
      if (parsed.type === "natural") {
        // Acknowledge natural language — AI takes a moment
        await say("Thinking...");

        // Pull live metrics from DB based on what the question is about
        let liveContext = "";
        if (deps.getLiveContext) {
          liveContext = await deps.getLiveContext(parsed.text);
        }

        // Retrieve relevant KB context for the query
        let kbContext = "";
        if (deps.getKbContext) {
          kbContext = await deps.getKbContext(parsed.text);
        }

        const contextParts = [parsed.text];
        if (liveContext) contextParts.push(liveContext);
        if (kbContext) contextParts.push(kbContext);
        const prompt = contextParts.join("\n\n");

        const result = await deps.runOrchestrator({
          prompt,
          system: `You are the marketing strategist for Rad & Happy, a stationery and lifestyle e-commerce brand. You have access to live data from the store's ad platform, Shopify, Instagram, and email/SMS system.

When the user asks a question:
- If live data is provided, USE IT — cite specific numbers. These are real, current metrics.
- Be friendly and specific. Tara (CEO/creative director) is non-technical — no jargon.
- Be actionable — don't just report numbers, tell them what the numbers mean and what to do.
- If you don't have the data to answer, say so honestly rather than guessing.
- Keep answers concise — 2-3 paragraphs max unless they ask for detail.`,
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
              "• `!shopify` — Order summary (last 30 days)",
              "• `!shopify ltv` — Subscription LTV analysis",
              "• `!notes <text>` — Save notes to the knowledge base",
              "• `!sync meta [days]` — Pull Meta ads data (default 7 days)",
              "• `!sync shopify [days]` — Pull Shopify orders (default 30 days)",
              "• `!sync all` — Sync everything",
              "• `!social analyze` — AI-generated content strategy insights",
              "• `!social` — Quick organic social stats",
              "• `!report weekly` — Monday morning cross-channel briefing",
              "• `!sync social` — Pull Instagram posts and insights",
              "• `!sync attentive` — Auto-sync Attentive email/SMS data",
              "• `!import attentive` — Import Attentive CSV (attach file)",
              "• `!inventory check` — Stock level alerts",
              "• `!help` — Show this message",
              "",
              "Or just ask me anything in plain English!",
            ].join("\n"),
            isError: false,
          };
        } else {
          // Send acknowledgment for slow commands
          const ack = ACK_MESSAGES[route.handler];
          if (ack) {
            await say(ack);
          }

          // Check if this is a file-based handler (e.g., CSV import)
          const fileHandler = deps.fileHandlers?.[route.handler];
          if (fileHandler && files.length > 0) {
            const file = files[0] as { id?: string; url_private_download?: string; name?: string };
            if (file.id) {
              await say("Downloading and importing file...");
              try {
                // Use Slack's files.info to get a fresh download URL,
                // then download with the bot token
                const fileInfo = await client.files.info({ file: file.id });
                const downloadUrl = fileInfo.file?.url_private_download;
                if (!downloadUrl) throw new Error("No download URL available for this file");

                const fileResp = await fetch(downloadUrl, {
                  headers: { Authorization: `Bearer ${botToken}` },
                });
                if (!fileResp.ok) {
                  throw new Error(`File download failed (${fileResp.status})`);
                }
                const fileContent = await fileResp.text();
                response = await fileHandler(fileContent, parsed.args);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                response = { text: `Failed to download file: ${msg}`, isError: true };
              }
            } else {
              response = { text: "Could not access the uploaded file. Try re-uploading.", isError: true };
            }
          } else if (fileHandler) {
            response = {
              text: "This command requires a file attachment. Upload a CSV file with the command.",
              isError: true,
            };
          } else {
            // Dispatch to the registered handler
            const handler = deps.handlers[route.handler];
            if (handler) {
              // For notes, the "action" is part of the content — reconstruct full text
              const handlerArgs = route.handler === "notes:add" && parsed.action
                ? `${parsed.action} ${parsed.args}`.trim()
                : parsed.args;
              response = await handler(handlerArgs);
            } else {
              response = {
                text: `The command was recognized but the handler "${route.handler}" isn't wired up yet.`,
                isError: true,
              };
            }
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[slack] Handler error:", errorMsg);
      response = {
        text: `Something went wrong: ${errorMsg.slice(0, 200)}`,
        isError: true,
      };
    }

    await say(response.text);
  });

  return app;
}
