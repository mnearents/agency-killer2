/**
 * Recording that a sync ran (#54, and the seven tasks that never did).
 *
 * `sync_runs` is what `data_freshness` reads to say WHY a table looks the way
 * it does. Only `sync:meta` and `sync:attentive` were writing to it, so for
 * every other sync a run that stopped happening was indistinguishable from a
 * quiet week — the table just stayed where it was and nothing said whether
 * anything had tried.
 *
 * The wrapper exists rather than seven copies of the insert because the copies
 * would share a flaw: a task that returns early on missing configuration
 * writes no record at all, which is the `Skipped — X not set` line logged
 * calmly for months that this codebase keeps finding. Here a skip is an
 * OUTCOME — `not-configured` — not an absence.
 *
 * The recorder is injected so the sequencing is testable without a database:
 * what matters is that every path records exactly once, including the throw.
 */

import { classifyOutcome } from "@/domain/meta/outcomes";
import type { NewSyncRun } from "@/db/schema";

export interface TaskOutcome {
  /** False when the task could not run for want of credentials or config. */
  configured: boolean;
  /** Rows written. Zero with `configured` true is `no-data` — a real answer. */
  rowsWritten: number;
  /** A message to store alongside a successful run, e.g. partial failures. */
  errorMessage?: string | null;
}

export type SyncRecorder = (row: NewSyncRun) => Promise<void>;

/**
 * Runs a task and records the attempt, whatever happens.
 *
 * Rethrows after recording: the scheduler still needs to see a failure, and
 * swallowing it here would trade one silent failure for another.
 */
export async function runWithSyncRecord(
  task: string,
  now: () => Date,
  record: SyncRecorder,
  run: () => Promise<TaskOutcome>,
): Promise<TaskOutcome> {
  const startedAt = now();

  let result: TaskOutcome | undefined;
  let thrown: unknown;
  try {
    result = await run();
  } catch (err) {
    thrown = err;
  }

  const classified =
    thrown !== undefined
      ? classifyOutcome({ configured: true, rowsWritten: 0, error: thrown })
      : classifyOutcome({
          configured: result!.configured,
          rowsWritten: result!.rowsWritten,
        });

  await record({
    task,
    outcome: classified.outcome,
    rowsWritten: classified.rowsWritten,
    // A partial failure on an otherwise successful run would otherwise vanish.
    errorMessage: classified.errorMessage ?? result?.errorMessage ?? null,
    errorCode: classified.errorCode,
    startedAt,
    finishedAt: now(),
  });

  if (thrown !== undefined) throw thrown;
  return result!;
}
