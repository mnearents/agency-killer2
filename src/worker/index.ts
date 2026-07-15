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

// Scheduler tick: every minute, check for due tasks
const SCHEDULER_CRON = "* * * * *";

function createHandlerFns(): Record<string, () => Promise<void>> {
  // TODO: wire up real handler functions as they're implemented
  const handlers: Record<string, () => Promise<void>> = {};
  const handlerMap = getTaskHandlerMap();

  for (const [taskId, handlerName] of Object.entries(handlerMap)) {
    handlers[handlerName] = async () => {
      console.log(`[handler] Running ${handlerName} for task ${taskId}`);
    };
  }

  return handlers;
}

function createSlackHandlers(): Record<string, (args: string) => Promise<SlackResponse>> {
  // TODO: wire up real Slack command handlers as they're implemented
  return {
    "meta:analysis": async () => ({
      text: "Ads analysis is not yet wired up to real data. Coming soon!",
      isError: false,
    }),
    "meta:status": async () => ({
      text: "Ads status is not yet wired up. Coming soon!",
      isError: false,
    }),
    "meta:overview": async () => ({
      text: "Ads overview coming soon!",
      isError: false,
    }),
    "email:design": async (args) => ({
      text: `Email design for "${args}" is not yet wired up. Coming soon!`,
      isError: false,
    }),
    "email:overview": async () => ({
      text: "Email overview coming soon!",
      isError: false,
    }),
    "blog:create": async (args) => ({
      text: `Blog creation for "${args}" is not yet wired up. Coming soon!`,
      isError: false,
    }),
    "blog:list": async () => ({
      text: "Blog list coming soon!",
      isError: false,
    }),
    "blog:overview": async () => ({
      text: "Blog overview coming soon!",
      isError: false,
    }),
    "social:analyze": async () => ({
      text: "Social analytics coming soon!",
      isError: false,
    }),
    "inventory:check": async () => ({
      text: "Inventory check coming soon!",
      isError: false,
    }),
  };
}

async function main() {
  console.log("[worker] Starting agency-killer2 worker...");

  // Initialize scheduler with Phase 1 tasks
  const tasks = getPhase1Tasks();
  let state = createSchedulerState(tasks);
  console.log(`[worker] Registered ${tasks.length} tasks:`);
  for (const task of tasks) {
    console.log(`  - ${task.name} (${task.id}) [${task.enabled ? "enabled" : "disabled"}]`);
  }

  // Build dispatcher config
  const config: DispatcherConfig = {
    handlerMap: getTaskHandlerMap(),
    handlerFns: createHandlerFns(),
  };

  // Start scheduler tick
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

  // Start Slack bot
  const slackApp = createSlackApp({
    runOrchestrator: async (request) => {
      // TODO: wire up real orchestrator with Anthropic client
      return {
        ok: true as const,
        text: `I heard you! You said: "${request.prompt}". Real AI responses coming soon.`,
        inputTokens: 0,
        outputTokens: 0,
      };
    },
    handlers: createSlackHandlers(),
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
