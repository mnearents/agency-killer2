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
import { createInstagramApiClient } from "@/integrations/instagram-api";
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
import { getTopProducts, getOrderSummary } from "@/domain/shopify/queries";
import { computeEnrollmentLtvSummary, type CustomerEnrollmentData } from "@/domain/shopify/enrollment-ltv";
import { ingestDocument } from "@/domain/knowledge/ingestion";
import { retrieveContext } from "@/domain/knowledge/retrieval";
import { getAdsStatus, formatAdsStatus } from "@/domain/meta/status";
import { generateEmailCreative } from "@/domain/email/generate";
import { generateBlogArticle } from "@/domain/blog/generate";
import { syncSocialPosts } from "@/domain/social/sync";
import { analyzeSocialPerformance } from "@/domain/social/analyze";
import { getPostSummary } from "@/domain/social/queries";
import { formatStatusBlock } from "@/domain/social/analysis";
import { generateWeeklyReport } from "@/domain/report/generate";
import { createAssemblyAiClient } from "@/integrations/assemblyai";
import { importAttentiveCsv } from "@/domain/attentive/import";
import { exportAttentiveReports } from "@/integrations/attentive-agent";
import { detectTopics, buildLiveContext } from "@/domain/qa/context";
import { backfillSocialInsights } from "@/domain/social/backfill";
import { runAlertChecks, formatAlerts } from "@/domain/alerts/runner";
import { isDuringWorkHours, prioritizeAlerts } from "@/domain/alerts/schedule";
import { getUpcomingEntries, createEntry } from "@/domain/calendar/queries";

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

  const assemblyAiClient = getEnvOptional("ASSEMBLYAI_API_KEY")
    ? createAssemblyAiClient(getEnv("ASSEMBLYAI_API_KEY"))
    : null;

  const igClient = getEnvOptional("META_ACCESS_TOKEN")
    ? createInstagramApiClient(getEnv("META_ACCESS_TOKEN"))
    : null;

  const metaAccountId = getEnvOptional("META_AD_ACCOUNT_ID");
  const igUserId = getEnvOptional("INSTAGRAM_BUSINESS_ACCOUNT_ID");
  const dropboxKbRoot = getEnvOptional("DROPBOX_KB_ROOT") ?? "/RAD/Agency";
  const slackReportChannel = getEnvOptional("SLACK_REPORT_CHANNEL");

  // Proactive Slack messaging — set after Slack app starts
  let postToSlack: ((channel: string, text: string) => Promise<void>) | null = null;

  // Pending 2FA reply callback — set when agent needs a code
  let pending2faResolve: ((value: string) => void) | null = null;

  /**
   * Create a function that posts a question to Slack and waits for a human reply.
   * Used by the Attentive agent for 2FA codes.
   */
  function createSlackAsker(channel: string) {
    return async (message: string): Promise<string | null> => {
      if (!postToSlack) return null;

      await postToSlack(channel, message);

      // Wait for a reply (up to 5 minutes)
      return new Promise<string | null>((resolve) => {
        pending2faResolve = resolve;
        setTimeout(() => {
          if (pending2faResolve === resolve) {
            pending2faResolve = null;
            resolve(null);
          }
        }, 5 * 60 * 1000);
      });
    };
  }

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

    "sync:social": async () => {
      if (!igClient || !igUserId) {
        console.log("[sync:social] Skipped — META_ACCESS_TOKEN or INSTAGRAM_BUSINESS_ACCOUNT_ID not set");
        return;
      }
      const result = await syncSocialPosts({ client: igClient, db, igUserId, transcriber: assemblyAiClient ?? undefined, embeddingClient: embeddingClient ?? undefined });
      console.log(
        `[sync:social] Done: ${result.posts} posts (${result.insightsFetched} insights fetched, ${result.insightsFailed} failed)`
      );
      if (result.errors.length > 0) {
        console.error("[sync:social] Errors:", result.errors);
      }
    },

    "sync:attentive": async () => {
      const attUser = getEnvOptional("ATTENTIVE_AGENT_USERNAME");
      const attPass = getEnvOptional("ATTENTIVE_AGENT_PASSWORD");
      if (!attUser || !attPass) {
        console.log("[sync:attentive] Skipped — ATTENTIVE_AGENT_USERNAME or ATTENTIVE_AGENT_PASSWORD not set");
        return;
      }
      console.log("[sync:attentive] Starting Attentive export agent...");
      const exportResult = await exportAttentiveReports({
        username: attUser,
        password: attPass,
        db,
        askSlack: slackReportChannel && postToSlack ? createSlackAsker(slackReportChannel) : undefined,
      });
      let imported = 0;
      if (exportResult.campaignCsv) {
        const r = await importAttentiveCsv(db, exportResult.campaignCsv);
        imported += r.imported;
        console.log(`[sync:attentive] Campaign Performance: ${r.imported} rows imported`);
      }
      if (exportResult.revenueCsv) {
        const r = await importAttentiveCsv(db, exportResult.revenueCsv);
        imported += r.imported;
        console.log(`[sync:attentive] Attributed Revenue: ${r.imported} rows imported`);
      }
      console.log(`[sync:attentive] Done: ${imported} total rows imported`);
      if (exportResult.errors.length > 0) {
        console.error("[sync:attentive] Errors:", exportResult.errors);
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

    "alerts:check": async () => {
      if (!isDuringWorkHours(new Date())) {
        console.log("[alerts] Skipped — outside work hours");
        return;
      }
      console.log("[alerts] Running alert checks...");
      const allAlerts = await runAlertChecks(db);
      const alerts = prioritizeAlerts(allAlerts);
      console.log(`[alerts] ${allAlerts.length} alerts detected, ${alerts.length} after prioritization`);

      if (alerts.length > 0 && slackReportChannel && postToSlack) {
        const formatted = formatAlerts(alerts);
        await postToSlack(slackReportChannel, formatted);
        console.log("[alerts] Posted to Slack");
      }
    },

    "report:weekly": async () => {
      if (!orchestrator) {
        console.log("[report:weekly] Skipped — ANTHROPIC_API_KEY not set");
        return;
      }
      console.log("[report:weekly] Generating Monday morning report...");
      const result = await generateWeeklyReport({
        db,
        voice,
        runOrchestrator: (req) => orchestrator.run(req),
        getKbContext: embeddingClient
          ? () => retrieveContext({ db, embeddingClient }, "marketing strategy goals priorities calendar")
          : undefined,
      });
      console.log(`[report:weekly] ${result.ok ? "Done" : "Failed"} (${result.weekRange.label})`);

      // Post to Slack channel proactively
      if (result.ok && slackReportChannel && postToSlack) {
        try {
          await postToSlack(
            slackReportChannel,
            `*Monday Morning Report* (${result.weekRange.label})\n\n${result.text}`
          );
          console.log("[report:weekly] Posted to Slack channel");
        } catch (err) {
          console.error("[report:weekly] Failed to post to Slack:", err);
        }
      } else if (!result.ok) {
        console.error("[report:weekly]", result.text);
      }
    },
  };

  // ─── Start scheduler ────────────────────────────────────────────────
  const tasks = getPhase1Tasks();
  let state = createSchedulerState(tasks, new Date());
  console.log(`[worker] Registered ${tasks.length} tasks:`);
  for (const task of tasks) {
    console.log(`  - ${task.name} (${task.id}) [${task.enabled ? "enabled" : "disabled"}]`);
  }

  const config: DispatcherConfig = {
    handlerMap: getTaskHandlerMap(),
    handlerFns,
  };

  let schedulerRunning = false;

  cron.schedule(SCHEDULER_CRON, async () => {
    if (schedulerRunning) return;

    const now = new Date();
    const dueTasks = getDueTasks(state, now);
    if (dueTasks.length === 0) return;

    schedulerRunning = true;

    // Mark tasks as "running" immediately so the next tick doesn't re-dispatch
    for (const task of dueTasks) {
      state = recordTaskRun(state, task.id, now);
    }

    console.log(`[scheduler] ${dueTasks.length} task(s) due at ${now.toISOString()}`);

    try {
      const results = await dispatchDueTasks(
        dueTasks.map((t) => t.id),
        config,
        () => Date.now()
      );

      for (const result of results) {
        console.log(
          `[scheduler] ${result.taskId}: ${result.status}${result.error ? ` (${result.error})` : ""} [${result.durationMs}ms]`
        );
      }
    } finally {
      schedulerRunning = false;
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
    "social:analyze": async () => {
      if (!orchestrator) {
        return { text: "AI responses unavailable — ANTHROPIC_API_KEY not set.", isError: true };
      }
      const result = await analyzeSocialPerformance(
        {
          db,
          voice,
          runOrchestrator: (req) => orchestrator.run(req),
          igClient: igClient ?? undefined,
          igUserId: igUserId ?? undefined,
          getKbContext: embeddingClient
            ? () => retrieveContext({ db, embeddingClient }, "social media content strategy instagram engagement")
            : undefined,
        },
        30
      );
      return { text: result.text, isError: !result.ok };
    },
    "social:overview": async () => {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
      const summary = await getPostSummary(db, 30);

      let followerCount: number | null = null;
      if (igClient && igUserId) {
        try {
          const account = await igClient.getAccountInfo(igUserId);
          followerCount = account.followers_count;
        } catch {
          // Non-fatal
        }
      }

      const text = formatStatusBlock({
        ...summary,
        dateRange: {
          start: startDate.toISOString().split("T")[0],
          end: endDate.toISOString().split("T")[0],
        },
        followerCount,
      });
      return { text, isError: false };
    },
    "social:backfill": async () => {
      if (!igClient) {
        return { text: "Instagram not configured — META_ACCESS_TOKEN not set.", isError: true };
      }
      const result = await backfillSocialInsights(igClient, db);
      if (result.checked === 0) {
        return { text: "No posts with missing insights found — nothing to backfill.", isError: false };
      }
      const lines = [
        `*Backfill complete!*`,
        `• ${result.checked} posts checked`,
        `• ${result.updated} updated with real insights`,
        `• ${result.failed} couldn't be fetched (expired stories, etc.)`,
      ];
      if (result.errors.length > 0) {
        lines.push(`\nErrors:\n${result.errors.slice(0, 5).map(e => `• ${e}`).join("\n")}`);
      }
      return { text: lines.join("\n"), isError: false };
    },
    "social:reel": async () => ({
      text: "Reel creation coming soon!",
      isError: false,
    }),
    "calendar:view": async () => {
      try {
        const entries = await getUpcomingEntries(db, 7);
        if (entries.length === 0) {
          return { text: "Nothing on the calendar for the next 7 days. Add entries at `/calendar` on the dashboard or use `!calendar add <date> <channel> <title>`.", isError: false };
        }
        const lines = ["*Upcoming (next 7 days):*", ""];
        for (const e of entries) {
          const dateStr = new Date(e.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
          const statusIcon = e.status === "scheduled" ? "READY" : e.status === "idea" ? "IDEA" : e.status;
          lines.push(`• *${dateStr}* — ${e.channel}: ${e.title} [${statusIcon}]${e.notes ? ` — ${e.notes}` : ""}`);
        }
        return { text: lines.join("\n"), isError: false };
      } catch {
        return { text: "Calendar not available yet. Run a deploy to create the table.", isError: true };
      }
    },
    "calendar:add": async (args) => {
      // Format: !calendar add 8/15 Email Summer promo
      if (!args) {
        return {
          text: "Usage: `!calendar add <date> <channel> <title>`\nExample: `!calendar add 8/15 Email Summer planner promo`\nChannels: Email, SMS, Ad, Reel, Post, Story, Blog",
          isError: false,
        };
      }
      const parts = args.split(/\s+/);
      if (parts.length < 3) {
        return { text: "Need at least: date, channel, and title.\nExample: `!calendar add 8/15 Email Summer promo`", isError: true };
      }

      const dateStr = parts[0];
      const channel = parts[1];
      const title = parts.slice(2).join(" ");

      const validChannels = ["Email", "SMS", "Ad", "Reel", "Post", "Story", "Blog"];
      if (!validChannels.includes(channel)) {
        return { text: `"${channel}" isn't a valid channel. Use one of: ${validChannels.join(", ")}`, isError: true };
      }

      // Parse date — accept M/D, MM/DD, YYYY-MM-DD
      let date: Date;
      if (dateStr.includes("/")) {
        const [m, d] = dateStr.split("/").map(Number);
        const year = new Date().getFullYear();
        date = new Date(Date.UTC(year, m - 1, d));
      } else {
        date = new Date(dateStr + "T00:00:00Z");
      }

      if (isNaN(date.getTime())) {
        return { text: `Couldn't parse "${dateStr}" as a date. Use M/D (e.g., 8/15) or YYYY-MM-DD.`, isError: true };
      }

      try {
        await createEntry(db, { date, channel, title, status: "planned" });
        const formatted = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
        return { text: `*Added to calendar:* ${formatted} — ${channel}: ${title}`, isError: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { text: `Failed to add entry: ${msg}`, isError: true };
      }
    },
    "report:weekly": async () => {
      if (!orchestrator) {
        return { text: "AI responses unavailable — ANTHROPIC_API_KEY not set.", isError: true };
      }
      const result = await generateWeeklyReport({
        db,
        voice,
        runOrchestrator: (req) => orchestrator.run(req),
        getKbContext: embeddingClient
          ? () => retrieveContext({ db, embeddingClient }, "marketing strategy goals priorities calendar")
          : undefined,
      });
      return {
        text: result.ok
          ? `*Monday Morning Report* (${result.weekRange.label})\n\n${result.text}`
          : result.text,
        isError: !result.ok,
      };
    },
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
      if (!shopifyClient) {
        return { text: "Shopify not configured — SHOPIFY_ACCESS_TOKEN not set.", isError: true };
      }
      try {
        // Fetch customer enrollment metafields directly from Shopify
        const customers = await shopifyClient.getCustomersWithEnrollments();
        if (customers.length === 0) {
          return {
            text: "No customers with enrollment data found. Make sure the `automatik.enrollments` metafield exists on your customers.",
            isError: false,
          };
        }

        const enrollmentData: CustomerEnrollmentData[] = customers
          .filter((c) => c.enrollments)
          .map((c) => ({ customerId: c.id, enrollments: c.enrollments! }));

        const summary = computeEnrollmentLtvSummary(enrollmentData);
        const lines = [
          "*Subscription LTV Summary* (from enrollment data)",
          "",
          `*${summary.totalSubscribers}* subscribers (*${summary.activeSubscribers}* active, *${summary.churnedSubscribers}* churned)`,
          `Avg tenure: *${summary.avgTenureMonths.toFixed(1)}* months | Median: *${summary.medianTenureMonths.toFixed(1)}* months`,
          `Avg LTV: *$${(summary.avgLtvCents / 100).toFixed(2)}* | Avg monthly: *$${(summary.avgMonthlyValueCents / 100).toFixed(2)}*/subscriber`,
          "",
          "*By Tier:*",
          `• *Tier 1* — ${summary.t1Summary.subscribers} subscribers (${summary.t1Summary.active} active), avg tenure ${summary.t1Summary.avgTenure.toFixed(1)}mo, avg LTV $${(summary.t1Summary.avgLtv / 100).toFixed(2)}`,
          `• *Tier 2* — ${summary.t2Summary.subscribers} subscribers (${summary.t2Summary.active} active), avg tenure ${summary.t2Summary.avgTenure.toFixed(1)}mo, avg LTV $${(summary.t2Summary.avgLtv / 100).toFixed(2)}`,
        ];

        return { text: lines.join("\n"), isError: false };
      } catch (err) {
        console.error("[shopify:ltv]", err);
        return { text: `Failed to compute LTV: ${err instanceof Error ? err.message : String(err)}`, isError: true };
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
    "sync:social": async () => {
      if (!igClient || !igUserId) {
        return { text: "Social sync unavailable — META_ACCESS_TOKEN or INSTAGRAM_BUSINESS_ACCOUNT_ID not set.", isError: true };
      }
      const result = await syncSocialPosts({ client: igClient, db, igUserId, transcriber: assemblyAiClient ?? undefined, embeddingClient: embeddingClient ?? undefined });
      if (result.errors.length > 0) {
        return {
          text: `Social sync completed with errors:\n${result.errors.map(e => `• ${e}`).join("\n")}\n\nSynced: ${result.posts} posts`,
          isError: true,
        };
      }
      return {
        text: `*Instagram sync complete!*\n• ${result.posts} posts synced\n• ${result.insightsFetched} insights fetched\n• ${result.insightsFailed} insights unavailable${result.transcribed > 0 ? `\n• ${result.transcribed} videos transcribed` : ""}`,
        isError: false,
      };
    },
    "sync:attentive": async () => {
      const attUser = getEnvOptional("ATTENTIVE_AGENT_USERNAME");
      const attPass = getEnvOptional("ATTENTIVE_AGENT_PASSWORD");
      if (!attUser || !attPass) {
        return { text: "Attentive sync unavailable — ATTENTIVE_AGENT_USERNAME or ATTENTIVE_AGENT_PASSWORD not set.", isError: true };
      }
      const exportResult = await exportAttentiveReports({
        username: attUser,
        password: attPass,
        db,
        askSlack: slackReportChannel && postToSlack ? createSlackAsker(slackReportChannel) : undefined,
      });
      let imported = 0;
      const lines: string[] = [];
      if (exportResult.campaignCsv) {
        const r = await importAttentiveCsv(db, exportResult.campaignCsv);
        imported += r.imported;
        lines.push(`• Campaign Performance: ${r.imported} rows`);
      }
      if (exportResult.revenueCsv) {
        const r = await importAttentiveCsv(db, exportResult.revenueCsv);
        imported += r.imported;
        lines.push(`• Attributed Revenue: ${r.imported} rows`);
      }
      if (exportResult.errors.length > 0) {
        return {
          text: `Attentive sync had errors:\n${exportResult.errors.map(e => `• ${e}`).join("\n")}${lines.length > 0 ? `\n\nPartially imported:\n${lines.join("\n")}` : ""}`,
          isError: true,
        };
      }
      return {
        text: `*Attentive sync complete!*\n${lines.join("\n")}\n• ${imported} total rows imported`,
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
      if (igClient && igUserId) {
        const r = await syncSocialPosts({ client: igClient, db, igUserId, transcriber: assemblyAiClient ?? undefined, embeddingClient: embeddingClient ?? undefined });
        results.push(`Instagram: ${r.posts} posts${r.errors.length > 0 ? ` (${r.errors.length} errors)` : ""}`);
      } else {
        results.push("Instagram: skipped (no credentials)");
      }
      const attUser = getEnvOptional("ATTENTIVE_AGENT_USERNAME");
      const attPass = getEnvOptional("ATTENTIVE_AGENT_PASSWORD");
      if (attUser && attPass) {
        try {
          const exp = await exportAttentiveReports({
            username: attUser,
            password: attPass,
            db,
            askSlack: slackReportChannel && postToSlack ? createSlackAsker(slackReportChannel) : undefined,
          });
          let rows = 0;
          if (exp.campaignCsv) rows += (await importAttentiveCsv(db, exp.campaignCsv)).imported;
          if (exp.revenueCsv) rows += (await importAttentiveCsv(db, exp.revenueCsv)).imported;
          results.push(`Attentive: ${rows} rows${exp.errors.length > 0 ? ` (${exp.errors.length} errors)` : ""}`);
        } catch {
          results.push("Attentive: failed");
        }
      } else {
        results.push("Attentive: skipped (no credentials)");
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
    fileHandlers: {
      "import:attentive": async (fileContent) => {
        try {
          const result = await importAttentiveCsv(db, fileContent);
          if (result.errors.length > 0) {
            return {
              text: `Attentive ${result.type} import completed with errors:\n${result.errors.slice(0, 5).map(e => `• ${e}`).join("\n")}\n\nImported: ${result.imported} rows, skipped: ${result.skipped}`,
              isError: true,
            };
          }
          return {
            text: `*Attentive ${result.type} data imported!*\n• ${result.imported} rows imported`,
            isError: false,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `Import failed: ${msg}`, isError: true };
        }
      },
    },
    getKbContext: embeddingClient
      ? async (query) => retrieveContext({ db, embeddingClient }, query)
      : undefined,
    getLiveContext: async (question) => {
      const topics = detectTopics(question);
      return buildLiveContext(db, topics);
    },
    onMessageInterceptor: (text) => {
      // If a 2FA code is pending and someone sends a short numeric message, resolve it
      if (pending2faResolve && /^\d{4,8}$/.test(text.trim())) {
        pending2faResolve(text.trim());
        pending2faResolve = null;
        return true;
      }
      return false;
    },
  });

  if (slackApp) {
    await slackApp.start();
    // Wire proactive messaging now that the app is running
    postToSlack = async (channel: string, text: string) => {
      await slackApp.client.chat.postMessage({ channel, text });
    };
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
