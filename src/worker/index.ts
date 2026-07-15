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

// Scheduler tick: every minute, check for due tasks
const SCHEDULER_CRON = "* * * * *";

function createHandlerFns(): Record<string, () => Promise<void>> {
  // TODO: wire up real handler functions as they're implemented
  // For now, each handler logs what would run
  const handlers: Record<string, () => Promise<void>> = {};
  const handlerMap = getTaskHandlerMap();

  for (const [taskId, handlerName] of Object.entries(handlerMap)) {
    handlers[handlerName] = async () => {
      console.log(`[handler] Running ${handlerName} for task ${taskId}`);
    };
  }

  return handlers;
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

    // Record completed runs
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

  // TODO: Start Slack bot here
  // const app = new App({ token: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, socketMode: true });
  // await app.start();

  console.log("[worker] Ready.");
}

main().catch((err) => {
  console.error("[worker] Fatal error:", err);
  process.exit(1);
});
