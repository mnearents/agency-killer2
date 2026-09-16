/**
 * Shopify Analytics sessions sync.
 *
 * "Did anyone arrive" — the question no other feed in this system answers, and
 * the reason a 62% year-over-year traffic collapse was invisible until someone
 * exported a CSV by hand.
 *
 * Shopify is the source rather than GA4 because it is the only one with the
 * history: 37 months back to September 2023, where the GA4 property was created
 * 2026-08-24 and cannot express a year-over-year comparison at all. GA4 stays
 * useful for revenue-per-channel and is stored alongside under its own
 * `source`, never blended — the two disagree by a wide margin and the cause is
 * not settled.
 *
 * ## The hazard
 *
 * ShopifyQL reports a rejected query as HTTP 200 with `parseErrors` and no
 * rows. The client throws on that; this sync propagates it as a failed sync.
 * Absorbing it would record a day with no traffic, and a traffic feed that
 * cannot tell "nobody came" from "we did not ask" is worse than not having one.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { webSessions } from "@/db/schema";
import type { ShopifyAnalyticsClient } from "@/integrations/shopify-analytics";

export const WEB_SESSIONS_SOURCE = "shopify";

/**
 * Shopify's own sessions dataset carries no revenue column, so conversion_rate
 * is the strongest outcome signal available here. Revenue per channel comes
 * from GA4 or from joining orders, not from this dataset.
 */
export const WEB_SESSION_DIMENSIONS = [
  { name: "total", shopifyqlGroupBy: "day", column: null },
  { name: "referrer_source", shopifyqlGroupBy: "day, referrer_source", column: "referrer_source" },
  { name: "referrer_name", shopifyqlGroupBy: "day, referrer_name", column: "referrer_name" },
  { name: "landing_page", shopifyqlGroupBy: "day, landing_page_path", column: "landing_page_path" },
] as const;

export interface DateRange {
  startDate: string;
  endDate: string;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Split a range into whole months, oldest first.
 *
 * `GROUP BY day, landing_page_path` over three years is one enormous response,
 * and ShopifyQL has its own query-cost budget. A month at a time keeps each
 * response small and makes a partial failure recoverable rather than losing
 * the whole backfill.
 */
export function monthChunks(startDate: string, endDate: string): DateRange[] {
  if (startDate > endDate) return [];

  const chunks: DateRange[] = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const final = new Date(`${endDate}T00:00:00Z`);

  while (cursor <= final) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const chunkEnd = monthEnd < final ? monthEnd : final;
    chunks.push({ startDate: isoDay(cursor), endDate: isoDay(chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return chunks;
}

export interface WebSessionsSyncResult {
  ok: boolean;
  window: DateRange;
  rows: number;
  byDimension: Record<string, number>;
  skipped: number;
  error: string | null;
  problem: string | null;
}

export interface WebSessionsSyncInput {
  client: ShopifyAnalyticsClient;
  db: Db;
  now: Date;
  /** Inclusive. The backfill passes 2023-09-01; the daily top-up a recent date. */
  startDate: string;
}

/** A window this long returning nothing is a failed read, not a quiet site. */
const SUSPICIOUSLY_LONG_EMPTY_DAYS = 60;

export async function syncWebSessions(
  input: WebSessionsSyncInput
): Promise<WebSessionsSyncResult> {
  const endDate = isoDay(input.now);
  const window = { startDate: input.startDate, endDate };
  const byDimension: Record<string, number> = {};
  let rows = 0;
  let skipped = 0;

  const failed = (error: string): WebSessionsSyncResult => ({
    ok: false, window, rows, byDimension, skipped, error, problem: null,
  });

  // Before anything is read: a missing scope should name itself rather than
  // surfacing later as an opaque query failure.
  try {
    await input.client.assertReportsAccess();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }

  for (const chunk of monthChunks(input.startDate, endDate)) {
    for (const dim of WEB_SESSION_DIMENSIONS) {
      const metrics = dim.name === "total" ? "sessions, conversion_rate" : "sessions";
      const statement =
        `FROM sessions SHOW ${metrics} GROUP BY ${dim.shopifyqlGroupBy} ` +
        `SINCE ${chunk.startDate} UNTIL ${chunk.endDate}`;

      let apiRows;
      try {
        apiRows = await input.client.query(statement);
      } catch (err) {
        // Propagated, never absorbed. See the header.
        return failed(
          `${dim.name} ${chunk.startDate}..${chunk.endDate}: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }

      const values = apiRows
        .map((r) => {
          // ShopifyQL returns the day as a timestamp; the column is a date.
          const day = String(r.day ?? "").slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            skipped++;
            return null;
          }
          const sessions = Number(r.sessions ?? 0);
          const rate = dim.name === "total" ? Number(r.conversion_rate ?? NaN) : NaN;

          return {
            date: day,
            source: WEB_SESSIONS_SOURCE,
            dimension: dim.name,
            value: dim.column ? String(r[dim.column] ?? "") : "",
            sessions: Number.isFinite(sessions) ? sessions : 0,
            conversionRate: Number.isFinite(rate) ? rate : null,
            syncedAt: input.now,
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);

      byDimension[dim.name] = (byDimension[dim.name] ?? 0) + values.length;
      rows += values.length;

      for (let i = 0; i < values.length; i += 2_000) {
        await input.db
          .insert(webSessions)
          .values(values.slice(i, i + 2_000))
          .onConflictDoUpdate({
            target: [webSessions.date, webSessions.source, webSessions.dimension, webSessions.value],
            set: {
              sessions: sql`excluded.sessions`,
              conversionRate: sql`excluded.conversion_rate`,
              syncedAt: sql`excluded.synced_at`,
            },
          });
      }
    }
  }

  const spanDays = Math.round(
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / 86_400_000
  );

  const problem =
    rows === 0 && spanDays >= SUSPICIOUSLY_LONG_EMPTY_DAYS
      ? `The scope was confirmed but no rows came back for ${window.startDate}..${window.endDate}. ` +
        `A window this long returning nothing is a failed read, not a site nobody visits.`
      : null;

  return { ok: true, window, rows, byDimension, skipped, error: null, problem };
}

/** The most recent day held for a source, or null when there is none. */
export async function getLatestSessionDate(db: Db, source = WEB_SESSIONS_SOURCE): Promise<string | null> {
  const [row] = (await db
    .select({ latest: sql<string | null>`MAX(${webSessions.date})` })
    .from(webSessions)
    .where(sql`${webSessions.source} = ${source}`)) as Array<{ latest: string | null }>;
  return row?.latest ?? null;
}

/** Shopify's sessions history begins here; verified against the live store. */
export const SESSIONS_HISTORY_START = "2023-09-01";

/**
 * Where this run should start reading.
 *
 * Nothing stored means the full backfill. Otherwise re-read a short overlap,
 * because Shopify revises recent days — and a fixed recent date would leave a
 * permanent hole after any missed run while every later run reported success.
 */
export function plannedSessionsStart(latestStored: string | null, now: Date): string {
  if (!latestStored) return SESSIONS_HISTORY_START;
  const from = new Date(`${latestStored}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 7);
  const earliest = new Date(`${SESSIONS_HISTORY_START}T00:00:00Z`);
  return isoDay(from < earliest ? earliest : from);
}
