/**
 * How current the Attentive data is, stated in every Attentive tool's answer.
 *
 * The data is scraped from the Attentive UI by a browser that needs an SMS
 * code to log in, so it stops whenever nobody answers that code — and an
 * empty week then reads as a quiet week. data_freshness knew, but a caller
 * reading email_sms_performance did not have to ask it. Now the answer
 * carries its own coverage.
 */

import { desc, eq, max, and } from "drizzle-orm";
import type { Db } from "@/db/client";
import { syncRuns } from "@/db/schema";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export const ATTENTIVE_SYNC_TASK = "sync:attentive";

/** Reports run a day behind; data through the day before the window ends is current. */
const LAG_DAYS = 1;
const DAY_MS = 86_400_000;

/** Asked for and not obtainable, said in the answer rather than returned empty. */
export const ATTENTIVE_UNAVAILABLE = {
  scheduledSends:
    "Not available. Attentive's API has no campaign endpoint (it answers 404), and the scraped reports cover messages already sent. Scheduled and future sends are only visible in the Attentive UI.",
  subscriberCounts:
    "Not available. Attentive's API cannot read list or segment membership, and no scraped report collects subscriber counts yet, so list growth cannot be measured from here.",
} as const;

export interface AttentiveSyncState {
  /** The latest day any row in the table covers. */
  dataThrough: Date | null;
  lastRun: { outcome: string; finishedAt: Date; errorMessage: string | null } | null;
  lastSuccessAt: Date | null;
}

export interface AttentiveCoverage {
  /** False when the window runs past the data. */
  current: boolean;
  dataThrough: string | null;
  lastSync: { outcome: string; at: string; error: string | null } | null;
  lastSuccessfulSync: string | null;
  warning?: string;
}

export function describeAttentiveCoverage(state: AttentiveSyncState, rangeEnd: Date): AttentiveCoverage {
  const base = {
    dataThrough: state.dataThrough ? state.dataThrough.toISOString().slice(0, 10) : null,
    lastSync: state.lastRun
      ? { outcome: state.lastRun.outcome, at: state.lastRun.finishedAt.toISOString(), error: state.lastRun.errorMessage }
      : null,
    lastSuccessfulSync: state.lastSuccessAt ? state.lastSuccessAt.toISOString() : null,
  };

  if (!state.dataThrough) {
    return {
      current: false,
      ...base,
      warning: "No Attentive data has been collected for this report. Every figure here is absent, not zero.",
    };
  }

  const behindDays = Math.floor((rangeEnd.getTime() - state.dataThrough.getTime()) / DAY_MS);
  if (behindDays <= LAG_DAYS) return { current: true, ...base };

  const why = state.lastRun && state.lastRun.outcome !== "ok"
    ? ` The last sync (${base.lastSync!.at.slice(0, 10)}) ended ${state.lastRun.outcome}${state.lastRun.errorMessage ? `: ${state.lastRun.errorMessage}` : ""}.`
    : "";
  return {
    current: false,
    ...base,
    warning:
      `Attentive data stops at ${base.dataThrough}, ${behindDays} days before this window ends. ` +
      `Everything after that date is missing, and is NOT a quiet period.${why}`,
  };
}

/** The coverage inputs for one Attentive table, keyed by its `date` column. */
export async function getAttentiveSyncState(db: Db, table: PgTable, dateColumn: PgColumn): Promise<AttentiveSyncState> {
  const [[through], [lastRun], [lastOk]] = await Promise.all([
    db.select({ at: max(dateColumn) }).from(table),
    db
      .select({ outcome: syncRuns.outcome, finishedAt: syncRuns.finishedAt, errorMessage: syncRuns.errorMessage })
      .from(syncRuns)
      .where(eq(syncRuns.task, ATTENTIVE_SYNC_TASK))
      .orderBy(desc(syncRuns.finishedAt))
      .limit(1),
    db
      .select({ at: max(syncRuns.finishedAt) })
      .from(syncRuns)
      .where(and(eq(syncRuns.task, ATTENTIVE_SYNC_TASK), eq(syncRuns.outcome, "ok"))),
  ]);
  return {
    dataThrough: (through?.at as Date | null) ?? null,
    lastRun: lastRun ?? null,
    lastSuccessAt: (lastOk?.at as Date | null) ?? null,
  };
}
