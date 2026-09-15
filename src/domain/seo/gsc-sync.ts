/**
 * Search Console sync.
 *
 * The reason this is urgent is the only thing that matters about the design:
 * the available window advances one day every day, and a day that rolls off is
 * gone at any price, by anyone, permanently. There is no amount of future
 * effort that recovers one. So the backfill covers everything available on the
 * first run, and the daily sync exists to stop it happening again.
 *
 * Measured on the live property: the window starts 2025-09-14 and holds 365
 * days at ~327 rows/day across all dimensions — about 119,000 rows in total.
 *
 * ## Two absences that must never look alike
 *
 * A day with no traffic is a real answer. A sync that read nothing is a
 * failure. This feed exists to notice an absence, so a sync that cannot tell
 * those apart is worse than not having it — and the API makes the confusion
 * easy, because an ungranted credential returns `200 {}` rather than a 403.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { gscDaily } from "@/db/schema";
import type { GscDimension, GscRow, SearchConsoleClient } from "@/integrations/search-console";

/**
 * Search Console aggregates each dimension separately and so does this. The
 * cross-product of query × page × device × country would explode and answer
 * questions nobody asks.
 */
export const GSC_DIMENSION_SETS: Array<{ name: string; dimensions: GscDimension[] }> = [
  { name: "total", dimensions: ["date"] },
  { name: "query", dimensions: ["date", "query"] },
  { name: "page", dimensions: ["date", "page"] },
  { name: "device", dimensions: ["date", "device"] },
  { name: "country", dimensions: ["date", "country"] },
];

/**
 * Search Console data lags two to three days. On 2026-09-15 the latest
 * available date was 2026-09-13, so a window ending yesterday reliably returns
 * nothing for its last days — and a sync that read that as the answer would
 * write zeroes over days that simply had not landed.
 */
const LAG_DAYS = 3;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export interface GscWindow {
  startDate: string;
  endDate: string;
}

export function gscWindow(now: Date, days: number): GscWindow {
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - LAG_DAYS);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: isoDay(start), endDate: isoDay(end) };
}

export interface GscSyncResult {
  ok: boolean;
  window: GscWindow;
  rows: number;
  byDimension: Record<string, number>;
  /** Rows the API returned that carried no usable date. */
  skipped: number;
  /** Set when the sync could not run. `rows` is then meaningless, not zero. */
  error: string | null;
  /**
   * Set when the sync ran and established less than it appears to have.
   * Distinct from `error`: the read worked, the result is suspicious.
   */
  problem: string | null;
}

export interface GscSyncInput {
  client: SearchConsoleClient;
  db: Db;
  now: Date;
  /** 365 for the backfill; a small number for the daily top-up. */
  days: number;
}

/** A window this long returning nothing is not a quiet site. */
const SUSPICIOUSLY_LONG_EMPTY_WINDOW = 30;

export async function syncSearchConsole(input: GscSyncInput): Promise<GscSyncResult> {
  const window = gscWindow(input.now, input.days);
  const byDimension: Record<string, number> = {};
  let rows = 0;
  let skipped = 0;

  const failed = (error: string): GscSyncResult => ({
    ok: false,
    window,
    rows: 0,
    byDimension,
    skipped,
    error,
    problem: null,
  });

  // Before anything is read. An ungranted credential authenticates fine and
  // returns an empty 200, so "no data" and "no access" are the same shape
  // unless something refuses to proceed — see search-console.ts.
  try {
    await input.client.assertAccess();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }

  for (const set of GSC_DIMENSION_SETS) {
    let apiRows: GscRow[];
    try {
      apiRows = await input.client.query({ ...window, dimensions: set.dimensions });
    } catch (err) {
      // Partial data written by earlier dimensions stays — it is real — but
      // the sync reports failure rather than a count that looks complete.
      return failed(
        `${set.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const values = apiRows
      .map((r) => {
        const date = r.keys[0];
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          skipped++;
          return null;
        }
        return {
          date,
          dimension: set.name,
          // The `total` set has one key, the date itself, so there is no value.
          value: set.dimensions.length > 1 ? (r.keys[1] ?? "") : "",
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
          syncedAt: input.now,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    byDimension[set.name] = values.length;
    rows += values.length;

    // Upsert rather than insert: Search Console revises recent days, so a
    // re-sync of an overlapping window has to correct rather than collide.
    for (let i = 0; i < values.length; i += 2_000) {
      await input.db
        .insert(gscDaily)
        .values(values.slice(i, i + 2_000))
        .onConflictDoUpdate({
          target: [gscDaily.date, gscDaily.dimension, gscDaily.value],
          set: {
            clicks: sql`excluded.clicks`,
            impressions: sql`excluded.impressions`,
            ctr: sql`excluded.ctr`,
            position: sql`excluded.position`,
            syncedAt: sql`excluded.synced_at`,
          },
        });
    }
  }

  // Zero is UNKNOWN until something proves it means zero. Access was confirmed
  // and a year of history returned nothing — that is a sync that read nothing,
  // not a site nobody visits.
  const problem =
    rows === 0 && input.days >= SUSPICIOUSLY_LONG_EMPTY_WINDOW
      ? `Access was confirmed but no rows came back for ${window.startDate}..${window.endDate}. ` +
        `A window this long returning nothing is a failed read, not a quiet site.`
      : null;

  return { ok: true, window, rows, byDimension, skipped, error: null, problem };
}

/** The whole window Search Console retains for this property. */
export const GSC_BACKFILL_DAYS = 365;

/**
 * Days re-read on every run. Search Console revises recent days for a while
 * after first publishing them, so the last fortnight is refetched and upserted
 * rather than trusted as final.
 */
export const GSC_OVERLAP_DAYS = 14;

/**
 * How many days this run should ask for, given what is already stored.
 *
 * Derived rather than fixed, because both mistakes are silent: too small and a
 * gap is never filled while every run reports success; too large and the full
 * backfill re-runs daily. A worker that was down for a month self-heals.
 */
export function plannedGscDays(latestStoredDate: string | null, now: Date): number {
  if (!latestStoredDate) return GSC_BACKFILL_DAYS;

  const { endDate } = gscWindow(now, 1);
  const missingDays = Math.round(
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${latestStoredDate}T00:00:00Z`)) / 86_400_000
  );

  if (missingDays <= 0) return GSC_OVERLAP_DAYS;
  return Math.min(missingDays + GSC_OVERLAP_DAYS, GSC_BACKFILL_DAYS);
}

/** The most recent day we hold, or null when the table is empty. */
export async function getLatestGscDate(db: Db): Promise<string | null> {
  const [row] = (await db
    .select({ latest: sql<string | null>`MAX(${gscDaily.date})` })
    .from(gscDaily)) as Array<{ latest: string | null }>;
  return row?.latest ?? null;
}
