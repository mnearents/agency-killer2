/**
 * Historical backfill for Meta insights.
 *
 * The daily sync only ever looks back 7 days (`syncIncremental`), and it first
 * shipped months after this account stopped spending — so it could never have
 * captured the Nov 2024 – Mar 2026 history. This module exists to pull that
 * history once.
 *
 * Three constraints shape the design:
 *
 * 1. The app is on Meta's `development_access` tier ("heavily rate limited").
 *    Work is chunked by month and backed off exponentially on throttle.
 * 2. A throttle mid-run must not lose completed work, so every chunk writes a
 *    `sync_runs` row and a restart skips months already recorded as done.
 * 3. Zero rows is an answer, not an absence. Each chunk records an explicit
 *    outcome so "no spend that month" never again looks like "sync is broken".
 */

import type { MetaApiClient } from "@/integrations/meta-api";
import type { Db } from "@/db/client";
import { and, eq, inArray } from "drizzle-orm";
import { metaInsights, syncRuns } from "@/db/schema";
import { transformInsight } from "./sync-transform";
import { classifyOutcome, type SyncOutcome } from "./outcomes";

export const BACKFILL_TASK = "backfill:meta";

/** The attribution window every backfilled row is recorded under. */
export const ATTRIBUTION_WINDOW = "7d_click";

export interface MonthChunk {
  start: string;
  end: string;
}

/**
 * Split an inclusive date range into calendar-month chunks.
 *
 * Month boundaries (rather than fixed 30-day windows) keep chunks aligned with
 * the `sync_runs` records used for resumption, so a restart can match completed
 * work by `windowStart` alone.
 */
export function monthChunks(startDate: string, endDate: string): MonthChunk[] {
  const chunks: MonthChunk[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();

  while (true) {
    const monthStart = new Date(Date.UTC(year, month, 1));
    // Day 0 of the next month is the last day of this one — handles 28/29/30/31.
    const monthEnd = new Date(Date.UTC(year, month + 1, 0));

    const chunkStart = monthStart < start ? start : monthStart;
    const chunkEnd = monthEnd > end ? end : monthEnd;
    if (chunkStart > end) break;

    chunks.push({ start: isoDate(chunkStart), end: isoDate(chunkEnd) });

    if (monthEnd >= end) break;
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }

  return chunks;
}

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export interface BackfillDeps {
  client: MetaApiClient;
  db: Db;
  accountId: string;
  startDate: string;
  endDate: string;
  /** Injected for determinism in tests. */
  now?: () => Date;
  /** Injected so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseDelayMs?: number;
}

export interface BackfillResult {
  chunksCompleted: number;
  chunksSkipped: number;
  rowsWritten: number;
  /** True when the run aborted rather than attempting every remaining month. */
  stoppedEarly: boolean;
  outcome: SyncOutcome;
  attributionWindow: string;
  chunks: Array<{ start: string; end: string; outcome: SyncOutcome; rows: number }>;
}

/**
 * Which months are already done, by `windowStart`.
 *
 * Only `ok` and `no-data` count as done. A `rate-limited` or `api-error` chunk is
 * deliberately retried on the next run — treating a failed chunk as complete is
 * how a backfill silently ends up with holes in it.
 */
async function completedWindowStarts(db: Db): Promise<Set<number>> {
  const rows = await db
    .select({ windowStart: syncRuns.windowStart })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.task, BACKFILL_TASK),
        inArray(syncRuns.outcome, ["ok", "no-data"])
      )
    );
  return new Set(
    rows
      .map((r: { windowStart: Date | null }) => r.windowStart?.getTime())
      .filter((t): t is number => t !== undefined)
  );
}

export async function backfillInsights(deps: BackfillDeps): Promise<BackfillResult> {
  const {
    client,
    db,
    accountId,
    startDate,
    endDate,
    now = () => new Date(),
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    maxRetries = 5,
    baseDelayMs = 1000,
  } = deps;

  const chunks = monthChunks(startDate, endDate);
  const alreadyDone = await completedWindowStarts(db);

  const result: BackfillResult = {
    chunksCompleted: 0,
    chunksSkipped: 0,
    rowsWritten: 0,
    stoppedEarly: false,
    outcome: "ok",
    attributionWindow: ATTRIBUTION_WINDOW,
    chunks: [],
  };

  for (const chunk of chunks) {
    const windowStart = new Date(`${chunk.start}T00:00:00Z`);
    const windowEnd = new Date(`${chunk.end}T00:00:00Z`);

    // Resume: a month recorded as ok/no-data on an earlier run is not refetched.
    // Matched on the chunk's own start date — the same value written to
    // `windowStart` below — so a clamped first chunk still resolves.
    if (alreadyDone.has(windowStart.getTime())) {
      result.chunksSkipped += 1;
      continue;
    }

    const startedAt = now();
    let attempt = 0;
    let lastError: unknown;
    let rowsWritten = 0;
    let succeeded = false;

    while (attempt <= maxRetries) {
      try {
        const raw = await client.getInsights(accountId, chunk.start, chunk.end);
        const syncedAt = now();
        for (const item of raw) {
          const row = transformInsight(item, syncedAt, ATTRIBUTION_WINDOW);
          await db
            .insert(metaInsights)
            .values(row)
            .onConflictDoUpdate({
              target: [
                metaInsights.adId,
                metaInsights.date,
                metaInsights.publisherPlatform,
                metaInsights.platformPosition,
              ],
              set: {
                impressions: row.impressions,
                clicks: row.clicks,
                spendCents: row.spendCents,
                reach: row.reach,
                frequency: row.frequency,
                cpp: row.cpp,
                cpm: row.cpm,
                cpc: row.cpc,
                ctr: row.ctr,
                purchases: row.purchases,
                purchaseValueCents: row.purchaseValueCents,
                addToCart: row.addToCart,
                initiateCheckout: row.initiateCheckout,
                attributionWindow: row.attributionWindow,
                rawJson: row.rawJson,
                syncedAt,
                updatedAt: syncedAt,
              },
            });
          rowsWritten += 1;
        }
        lastError = undefined;
        succeeded = true;
        break;
      } catch (err) {
        lastError = err;
        const classified = classifyOutcome({ configured: true, rowsWritten, error: err });

        // Only throttles are worth retrying. A dead token or a malformed request
        // will fail identically forever; retrying just burns the rate budget.
        if (classified.outcome !== "rate-limited" || attempt === maxRetries) break;

        await sleep(baseDelayMs * 2 ** attempt);
        attempt += 1;
      }
    }

    const classified = classifyOutcome({
      configured: true,
      rowsWritten,
      error: succeeded ? undefined : lastError,
    });

    await db.insert(syncRuns).values({
      task: BACKFILL_TASK,
      outcome: classified.outcome,
      windowStart,
      windowEnd,
      rowsWritten,
      errorMessage: classified.errorMessage,
      errorCode: classified.errorCode,
      startedAt,
      finishedAt: now(),
    });

    result.chunks.push({
      start: chunk.start,
      end: chunk.end,
      outcome: classified.outcome,
      rows: rowsWritten,
    });
    result.rowsWritten += rowsWritten;

    if (classified.outcome === "ok" || classified.outcome === "no-data") {
      result.chunksCompleted += 1;
      continue;
    }

    // A failure that will repeat for every remaining month — stop and surface it
    // rather than writing a wall of identical failure rows.
    result.stoppedEarly = true;
    result.outcome = classified.outcome;
    return result;
  }

  return result;
}
