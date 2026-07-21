/**
 * Worker entry point — starts the scheduler and Slack bot.
 *
 * This is the main process for the worker Railway service.
 * Start command: `tsx src/worker/index.ts`
 */

import cron from "node-cron";
import { createSchedulerState, getDueTasks, recordTaskRun } from "./scheduler";
import { dispatchDueTasks, type DispatcherConfig } from "./dispatcher";
import { getPhase1Tasks, getTaskHandlerMap } from "./tasks/registry";
import { createSlackApp } from "./slack/app";
import type { SlackResponse } from "./slack/formatter";

// Real API clients
import { createMetaApiClient } from "@/integrations/meta-api";
import { createShopifyApiClient } from "@/integrations/shopify-api";
import { createDropboxClient } from "@/integrations/dropbox";
import { createAnthropicClient } from "@/integrations/anthropic";
import { createEmbeddingClient } from "@/integrations/openai";
import { createDb } from "@/db/client";

// Sync services
import { syncIncremental } from "@/domain/meta/sync";
import { analyzeAdPerformance } from "@/domain/meta/analyze";
import { syncOrders } from "@/domain/shopify/sync";
import { syncKnowledgeBase } from "@/domain/knowledge/sync";
import { embedChunks } from "@/domain/knowledge/embedding";
import { storeChunks, getExistingHashes } from "@/domain/knowledge/storage";
import { getSubscriptionOrders, getTopProducts, getOrderSummary } from "@/domain/shopify/queries";
import { computeLtvSummary } from "@/domain/shopify/subscription-ltv";
import { ingestDocument } from "@/domain/knowledge/ingestion";
import { retrieveContext } from "@/domain/knowledge/retrieval";
import { getAdsStatus, formatAdsStatus } from "@/domain/meta/status";
import { generateEmailCreative } from "@/domain/email/generate";
import { generateBlogArticle } from "@/domain/blog/generate";

// AI orchestration
import { createOrchestrator } from "@/ai/orchestrator";
import { assembleVoicePrompt } from "@/domain/voice/voice";
import { loadVoiceProfile } from "@/domain/voice/loader";

const SCHEDULER_CRON = "* * * * *";

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

function getEnvOptional(key: string): string | undefined {
  return process.env[key];
}

async function main() {
  console.log("[worker] Starting agency-killer2 worker...");

  // ─── Initialize clients ─────────────────────────────────────────────
  const db = createDb(getEnv("DATABASE_URL"));

  const metaClient = getEnvOptional("META_ACCESS_TOKEN")
    ? createMetaApiClient(getEnv("META_ACCESS_TOKEN"))
    : null;

  const shopifyClient =
    getEnvOptional("SHOPIFY_ACCESS_TOKEN") && getEnvOptional("SHOPIFY_STORE_DOMAIN")
      ? createShopifyApiClient(
          getEnv("SHOPIFY_STORE_DOMAIN"),
          getEnv("SHOPIFY_ACCESS_TOKEN")
        )
      : null;

  const dropboxClient =
    getEnvOptional("DROPBOX_APP_KEY") &&
    getEnvOptional("DROPBOX_APP_SECRET") &&
    getEnvOptional("DROPBOX_REFRESH_TOKEN")
      ? createDropboxClient(
          getEnv("DROPBOX_APP_KEY"),
          getEnv("DROPBOX_APP_SECRET"),
          getEnv("DROPBOX_REFRESH_TOKEN")
        )
      : null;

  const anthropicClient = getEnvOptional("ANTHROPIC_API_KEY")
    ? createAnthropicClient(getEnv("ANTHROPIC_API_KEY"))
    : null;

  const embeddingClient = getEnvOptional("OPENAI_API_KEY")
    ? createEmbeddingClient(getEnv("OPENAI_API_KEY"))
    : null;

  const metaAccountId = getEnvOptional("META_AD_ACCOUNT_ID");
  const dropboxKbRoot = getEnvOptional("DROPBOX_KB_ROOT") ?? "/RAD/Agency";

  // ─── Build orchestrator ─────────────────────────────────────────────
  const voiceProfile = loadVoiceProfile();
  console.log(`[worker] Loaded voice profile: ${voiceProfile.samples.length} samples, ${voiceProfile.rules.length} rules, ${voiceProfile.bannedWords.length} banned words`);
  const voice = assembleVoicePrompt(voiceProfile);

  const orchestrator = anthropicClient
    ? createOrchestrator({ client: anthropicClient, defaultGuardrails: voice.guardrailOptions })
    : null;

  // ─── Register task handlers ─────────────────────────────────────────
  const handlerFns: Record<string, () => Promise<void>> = {
    "sync:meta": async () => {
      if (!metaClient || !metaAccountId) {
        console.log("[sync:meta] Skipped — META_ACCESS_TOKEN or META_AD_ACCOUNT_ID not set");
        return;
      }
      const result = await syncIncremental({ client: metaClient, db, accountId: metaAccountId });
      console.log(
        `[sync:meta] Done: ${result.campaigns} campaigns, ${result.adSets} adsets, ${result.ads} ads, ${result.insights} insights`
      );
      if (result.errors.length > 0) {
        console.error("[sync:meta] Errors:", result.errors);
      }
    },

    "sync:shopify": async () => {
      if (!shopifyClient) {
        console.log("[sync:shopify] Skipped — SHOPIFY_ACCESS_TOKEN not set");
        return;
      }
      const result = await syncOrders({ client: shopifyClient, db });
      console.log(`[sync:shopify] Done: ${result.orders} orders, ${result.lineItems} line items`);
      if (result.errors.length > 0) {
        console.error("[sync:shopify] Errors:", result.errors);
      }
    },

    "sync:knowledge-base": async () => {
      if (!dropboxClient) {
        console.log("[sync:kb] Skipped — DROPBOX credentials not set");
        return;
      }
      const existingHashes = await getExistingHashes(db);
      const result = await syncKnowledgeBase(
        dropboxClient,
        dropboxKbRoot,
        new Map(), // TODO: track Dropbox revisions in DB
        existingHashes
      );
      console.log(
        `[sync:kb] Done: ${result.totalFiles} files (${result.newFiles} new, ${result.changedFiles} changed, ${result.unchangedFiles} unchanged)`
      );

      // Embed new chunks
      const allChunks = result.ingestionResults.flatMap((r) => r.rows);
      if (embeddingClient && allChunks.some((c) => c.needsEmbedding)) {
        const embeddingResult = await embedChunks(allChunks, embeddingClient);
        console.log(
          `[sync:kb] Embedding: ${embeddingResult.embedded} embedded, ${embeddingResult.skipped} skipped, ${embeddingResult.failed} failed`
        );

        // Store to DB
        const storageResult = await storeChunks(db, embeddingResult.chunks);
        console.log(
          `[sync:kb] Storage: ${storageResult.stored} stored, ${storageResult.skipped} skipped, ${storageResult.failed} failed`
        );
      }
    },

    "blog:create": async () => {
      if (!orchestrator) {
        console.log("[blog:create] Skipped — ANTHROPIC_API_KEY not set");
        return;
      }
      const result = await generateBlogArticle({
        db,
        runOrchestrator: (req) => orchestrator.run(req),
        getBrandContext: embeddingClient
          ? () => retrieveContext({ db, embeddingClient }, "brand philosophy goals strategy")
          : async () => "",
        voiceBannedWords: voiceProfile.bannedWords,
      });
      console.log(
        `[blog:create] ${result.ok ? "Done" : "Failed"}: ${result.topicTitle ?? "no topic"}`
      );
      if (!result.ok) {
        console.error("[blog:create]", result.text);
      }
    },

    "meta:analysis": async () => {
      if (!orchestrator) {
        console.log("[meta:analysis] Skipped — ANTHROPIC_API_KEY not set");
        return;
      }
      const result = await analyzeAdPerformance(
        {
          db,
          voice,
          runOrchestrator: (req) => orchestrator.run(req),
          getKbContext: embeddingClient
            ? () => retrieveContext({ db, embeddingClient }, "ad performance strategy creative recommendations")
            : undefined,
        },
        7
      );
      console.log(
        `[meta:analysis] ${result.ok ? "Done" : "Failed"}: ${result.campaignCount} campaigns (${result.dateRange.start} to ${result.dateRange.end})`
      );
      if (!result.ok) {
        console.error("[meta:analysis]", result.text);
      }
    },
  };

  // ─── Start scheduler ────────────────────────────────────────────────
  const tasks = getPhase1Tasks();
  let state = createSchedulerState(tasks);
  console.log(`[worker] Registered ${tasks.length} tasks:`);
  for (const task of tasks) {
    console.log(`  - ${task.name} (${task.id}) [${task.enabled ? "enabled" : "disabled"}]`);
  }

  const config: DispatcherConfig = {
    handlerMap: getTaskHandlerMap(),
    handlerFns,
  };

  cron.schedule(SCHEDULER_CRON, async () => {
    const now = new Date();
    const dueTasks = getDueTasks(state, now);
    if (dueTasks.length === 0) return;

    console.log(`[scheduler] ${dueTasks.length} task(s) due at ${now.toISOString()}`);

    const results = await dispatchDueTasks(
      dueTasks.map((t) => t.id),
      config,
      () => Date.now()
    );

    for (const result of results) {
      if (result.status === "success" || result.status === "failed") {
        state = recordTaskRun(state, result.taskId, now);
      }
      console.log(
        `[scheduler] ${result.taskId}: ${result.status}${result.error ? ` (${result.error})` : ""} [${result.durationMs}ms]`
      );
    }
  });

  console.log("[worker] Scheduler started (checking every minute)");

  // ─── Start Slack bot ────────────────────────────────────────────────
  const slackHandlers: Record<string, (args: string) => Promise<SlackResponse>> = {
    "meta:analysis": async () => {
      if (!orchestrator) {
        return { text: "AI responses unavailable — ANTHROPIC_API_KEY not set.", isError: true };
      }
      const result = await analyzeAdPerformance(
        {
          db,
          voice,
          runOrchestrator: (req) => orchestrator.run(req),
          getKbContext: embeddingClient
            ? () => retrieveContext({ db, embeddingClient }, "ad performance strategy creative recommendations")
            : undefined,
        },
        7
      );
      return { text: result.text, isError: !result.ok };
    },
    "meta:status": async () => {
      const result = await getAdsStatus(db, 7);
      return { text: formatAdsStatus(result), isError: false };
    },
    "meta:overview": async () => {
      const result = await getAdsStatus(db, 30);
      return { text: formatAdsStatus(result), isError: false };
    },
    "email:design": async (args) => {
      if (!orchestrator) {
        return { text: "AI responses unavailable — ANTHROPIC_API_KEY not set.", isError: true };
      }
      if (!args) {
        return { text: "Please provide a brief: `!email design <brief>`\nExample: `!email design summer sale promo`", isError: true };
      }
      const result = await generateEmailCreative(
        { db, voice, runOrchestrator: (req) => orchestrator.run(req) },
        args
      );
      return { text: result.text, isError: !result.ok };
    },
    "email:overview": async () => ({
      text: "Email overview coming soon!",
      isError: false,
    }),
    "email:calendar": async () => ({
      text: "Email calendar coming soon!",
      isError: false,
    }),
    "blog:create": async (args) => {
      if (!orchestrator) {
        return { text: "AI responses unavailable — ANTHROPIC_API_KEY not set.", isError: true };
      }
      const result = await generateBlogArticle(
        {
          db,
          runOrchestrator: (req) => orchestrator.run(req),
          getBrandContext: embeddingClient
          ? () => retrieveContext({ db, embeddingClient }, "brand philosophy goals strategy")
          : async () => "",
          voiceBannedWords: voiceProfile.bannedWords,
        },
        args || undefined
      );
      return { text: result.text, isError: !result.ok };
    },
    "blog:list": async () => {
      try {
        const { blogTopics: bt } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");
        const pending = await db
          .select({ title: bt.title, priority: bt.priority, targetDate: bt.targetDate })
          .from(bt)
          .where(eq(bt.status, "pending"));
        if (pending.length === 0) {
          return { text: "No pending blog topics.", isError: false };
        }
        const lines = pending.map((t) =>
          `• ${t.title} (priority: ${t.priority}${t.targetDate ? `, target: ${t.targetDate.toISOString().split("T")[0]}` : ""})`
        );
        return { text: `*Pending Blog Topics:*\n${lines.join("\n")}`, isError: false };
      } catch {
        return { text: "Failed to fetch blog topics.", isError: true };
      }
    },
    "blog:overview": async () => ({
      text: "Blog overview coming soon!",
      isError: false,
    }),
    "social:analyze": async () => ({
      text: "Social analytics coming soon!",
      isError: false,
    }),
    "social:overview": async () => ({
      text: "Social overview coming soon!",
      isError: false,
    }),
    "social:reel": async () => ({
      text: "Reel creation coming soon!",
      isError: false,
    }),
    "inventory:check": async () => ({
      text: "Inventory check coming soon!",
      isError: false,
    }),
    "inventory:alerts": async () => ({
      text: "Inventory alerts coming soon!",
      isError: false,
    }),
    "shopify:status": async () => {
      try {
        const summary = await getOrderSummary(db, 30);
        if (summary.totalOrders === 0) {
          return {
            text: "No Shopify orders in the last 30 days. Run `!sync shopify` to pull order data.",
            isError: false,
          };
        }
        const lines = [
          "*Shopify Status* (last 30 days)",
          "",
          `• *${summary.totalOrders}* orders`,
          `• *$${(summary.totalRevenueCents / 100).toFixed(2)}* total revenue`,
          `• *${summary.subscriptionOrders}* subscription orders ($${(summary.subscriptionRevenueCents / 100).toFixed(2)})`,
        ];
        return { text: lines.join("\n"), isError: false };
      } catch {
        return { text: "Failed to fetch Shopify data. Make sure sync has run.", isError: true };
      }
    },
    "shopify:ltv": async () => {
      try {
        const orders = await getSubscriptionOrders(db);
        if (orders.length === 0) {
          return {
            text: "No subscription orders found. Make sure Shopify sync has run and your subscriptions use the `recurring-order` tag.",
            isError: false,
          };
        }
        const summary = computeLtvSummary(orders, new Date());
        const lines = [
          "*Subscription LTV Summary*",
          "",
          `• *${summary.totalSubscribers}* total subscribers`,
          `• *${summary.activeSubscribers}* active / *${summary.churnedSubscribers}* churned`,
          `• Avg tenure: *${summary.avgTenureMonths.toFixed(1)}* months`,
          `• Avg LTV: *$${(summary.avgLtvCents / 100).toFixed(2)}*`,
          `• Avg monthly revenue: *$${(summary.avgMonthlyRevenueCents / 100).toFixed(2)}*/subscriber`,
          `• Median tenure: *${summary.medianTenureMonths.toFixed(1)}* months`,
        ];
        return { text: lines.join("\n"), isError: false };
      } catch {
        return { text: "Failed to compute LTV. Make sure Shopify sync has run.", isError: true };
      }
    },
    "inventory:overview": async () => ({
      text: "Inventory overview coming soon!",
      isError: false,
    }),
    "sync:meta": async (args) => {
      if (!metaClient || !metaAccountId) {
        return { text: "Meta sync unavailable — META_ACCESS_TOKEN or META_AD_ACCOUNT_ID not set.", isError: true };
      }
      // Parse optional day count: "!sync meta 90" pulls 90 days of insights
      const days = args ? parseInt(args, 10) : 7;
      const lookbackDays = isNaN(days) ? 7 : days;

      const result = await syncIncremental({ client: metaClient, db, accountId: metaAccountId }, lookbackDays);
      if (result.errors.length > 0) {
        return {
          text: `Meta sync completed with errors:\n${result.errors.map(e => `• ${e}`).join("\n")}\n\nSynced: ${result.campaigns} campaigns, ${result.adSets} adsets, ${result.ads} ads, ${result.insights} insights`,
          isError: true,
        };
      }
      return {
        text: `*Meta sync complete!* (last ${lookbackDays} days)\n• ${result.campaigns} campaigns\n• ${result.adSets} ad sets\n• ${result.ads} ads\n• ${result.creatives} creatives\n• ${result.insights} insights`,
        isError: false,
      };
    },
    "sync:shopify": async (args) => {
      if (!shopifyClient) {
        return { text: "Shopify sync unavailable — SHOPIFY_ACCESS_TOKEN not set.", isError: true };
      }
      // Parse optional day count: "!sync shopify 90" pulls 90 days
      const days = args ? parseInt(args, 10) : 30;
      const lookbackDays = isNaN(days) ? 30 : days;
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const result = await syncOrders({ client: shopifyClient, db }, since);
      if (result.errors.length > 0) {
        return {
          text: `Shopify sync completed with errors:\n${result.errors.map(e => `• ${e}`).join("\n")}`,
          isError: true,
        };
      }
      return {
        text: `*Shopify sync complete!* (last ${lookbackDays} days)\n• ${result.orders} orders\n• ${result.lineItems} line items`,
        isError: false,
      };
    },
    "sync:knowledge-base": async () => {
      if (!dropboxClient) {
        return { text: "KB sync unavailable — Dropbox credentials not set.", isError: true };
      }
      const result = await syncKnowledgeBase(dropboxClient, dropboxKbRoot, new Map(), new Set());
      return {
        text: `*KB sync complete!*\n• ${result.totalFiles} files found\n• ${result.newFiles} new, ${result.changedFiles} changed, ${result.unchangedFiles} unchanged`,
        isError: false,
      };
    },
    "sync:all": async () => {
      const results: string[] = [];
      if (metaClient && metaAccountId) {
        const r = await syncIncremental({ client: metaClient, db, accountId: metaAccountId });
        results.push(`Meta: ${r.campaigns} campaigns, ${r.insights} insights${r.errors.length > 0 ? ` (${r.errors.length} errors)` : ""}`);
      } else {
        results.push("Meta: skipped (no credentials)");
      }
      if (shopifyClient) {
        const r = await syncOrders({ client: shopifyClient, db });
        results.push(`Shopify: ${r.orders} orders${r.errors.length > 0 ? ` (${r.errors.length} errors)` : ""}`);
      } else {
        results.push("Shopify: skipped (no credentials)");
      }
      if (dropboxClient) {
        const r = await syncKnowledgeBase(dropboxClient, dropboxKbRoot, new Map(), new Set());
        results.push(`KB: ${r.totalFiles} files (${r.newFiles} new)`);
      } else {
        results.push("KB: skipped (no credentials)");
      }
      return {
        text: `*Sync complete!*\n${results.map(r => `• ${r}`).join("\n")}`,
        isError: false,
      };
    },
    "notes:add": async (args) => {
      if (!args) {
        return {
          text: "Paste your notes after the command:\n`!notes CTC meeting 7/15 — discussed subscription ROAS...`\n\nEverything after `!notes` will be saved to the knowledge base.",
          isError: false,
        };
      }

      // Ingest the note as a KB document
      const { chunkDocument } = await import("@/domain/knowledge/chunking");
      const { contentHash } = await import("@/domain/knowledge/ingestion");

      const chunks = chunkDocument({
        title: `Note: ${args.slice(0, 50)}${args.length > 50 ? "..." : ""}`,
        content: args,
        category: "meeting-notes",
        documentDate: new Date(),
      });

      if (chunks.length === 0) {
        return { text: "Note was empty — nothing saved.", isError: true };
      }

      let stored = 0;
      for (const chunk of chunks) {
        const hash = contentHash(chunk.content);
        const row = {
          title: chunk.metadata.documentTitle,
          content: chunk.content,
          category: chunk.metadata.category,
          contentHash: hash,
          chunkIndex: chunk.metadata.chunkIndex,
          totalChunks: chunk.metadata.totalChunks,
          contextPrefix: chunk.metadata.contextPrefix,
          documentDate: chunk.metadata.documentDate ?? null,
          embedding: null as number[] | null,
          sourceFile: null,
        };

        // Embed if possible
        if (embeddingClient) {
          try {
            const result = await embeddingClient.embed(chunk.content);
            row.embedding = result.embedding;
          } catch (err) {
            console.error("[notes] Embedding failed:", err);
          }
        }

        try {
          const { kbDocuments: kbTable } = await import("@/db/schema");
          await db.insert(kbTable).values(row);
          stored++;
        } catch (err) {
          console.error("[notes] Storage failed:", err);
        }
      }

      return {
        text: `*Note saved!* ${stored} chunk${stored !== 1 ? "s" : ""} stored in the knowledge base.${!embeddingClient ? "\n(No OpenAI key — saved without embedding, won't appear in RAG searches)" : ""}`,
        isError: false,
      };
    },
  };

  const slackApp = createSlackApp({
    runOrchestrator: async (request) => {
      if (!orchestrator) {
        return {
          ok: true as const,
          text: "AI responses are not available — ANTHROPIC_API_KEY not set.",
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      return orchestrator.run(request);
    },
    handlers: slackHandlers,
    getKbContext: embeddingClient
      ? async (query) => retrieveContext({ db, embeddingClient }, query)
      : undefined,
  });

  if (slackApp) {
    await slackApp.start();
    console.log("[worker] Slack bot started (socket mode)");
  } else {
    console.log("[worker] Slack bot skipped (no tokens configured)");
  }

  console.log("[worker] Ready.");
}

main().catch((err) => {
  console.error("[worker] Fatal error:", err);
  process.exit(1);
});
