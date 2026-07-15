/**
 * Task dispatcher — the bridge between the scheduler and the handlers.
 *
 * Takes a task ID, looks up its handler in the registry, and calls the
 * appropriate function. Reports success/failure per task. A handler
 * error does NOT crash the dispatcher — it logs the failure and
 * continues to the next task.
 *
 * This is the last piece of wiring: scheduler decides WHEN, registry
 * decides WHAT, dispatcher executes HOW.
 */

export type HandlerFn = () => Promise<void>;

export interface DispatchResult {
  taskId: string;
  handler: string;
  status: "success" | "failed" | "no-handler";
  error?: string;
  durationMs: number;
}

export interface DispatcherConfig {
  handlerMap: Record<string, string>;
  handlerFns: Record<string, HandlerFn>;
}

export async function dispatchTask(
  taskId: string,
  config: DispatcherConfig,
  now: () => number
): Promise<DispatchResult> {
  const handlerName = config.handlerMap[taskId];
  if (!handlerName) {
    return { taskId, handler: "", status: "no-handler", durationMs: 0 };
  }

  const handlerFn = config.handlerFns[handlerName];
  if (!handlerFn) {
    return { taskId, handler: handlerName, status: "no-handler", durationMs: 0 };
  }

  const start = now();

  try {
    await handlerFn();
    const durationMs = now() - start;
    return { taskId, handler: handlerName, status: "success", durationMs };
  } catch (err) {
    const durationMs = now() - start;
    const error = err instanceof Error ? err.message : String(err);
    return { taskId, handler: handlerName, status: "failed", error, durationMs };
  }
}

export async function dispatchDueTasks(
  taskIds: string[],
  config: DispatcherConfig,
  now: () => number
): Promise<DispatchResult[]> {
  const results: DispatchResult[] = [];

  for (const taskId of taskIds) {
    const result = await dispatchTask(taskId, config, now);
    results.push(result);
  }

  return results;
}
