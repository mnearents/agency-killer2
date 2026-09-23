/**
 * Reads over Search Console and web sessions.
 *
 * ## The one thing every session figure has to carry
 *
 * Shopify's counted sessions step-change on **2025-12-31** (#74). Before that
 * date Shopify sessions and Search Console clicks tracked each other at 82-107%;
 * from that day GSC clicks never fall below ~130% of Shopify sessions and
 * average ~170%. It is a step on a single day and only one side moves, so it is
 * a measurement change rather than drift.
 *
 * The consequence is specific: **any comparison that spans that date mixes two
 * measurement regimes**, and the headline "traffic collapsed 62% year over
 * year" may be substantially an artefact. Dec 2025 to Jan 2026 is -18% by GSC
 * clicks and -56% by Shopify sessions; both cannot be right.
 *
 * So the query layer returns whether a window crosses the break, and the tools
 * put that in the payload rather than in prose. A session count that looks
 * authoritative and is not is exactly the failure this codebase treats as worse
 * than a missing number.
 *
 * Search Console is unaffected and is the sounder series across the boundary.
 */

import { sql, and, gte, lte, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { gscDaily, webSessions } from "@/db/schema";

/** The day Shopify's session counting changed. See #74. */
export const SESSION_MEASUREMENT_BREAK = "2025-12-31";

export const GSC_DIMENSIONS = ["total", "query", "page", "device", "country"] as const;
export type GscDimension = (typeof GSC_DIMENSIONS)[number];

export const SESSION_DIMENSIONS = ["total", "referrer_source", "referrer_name", "landing_page"] as const;
export type SessionDimension = (typeof SESSION_DIMENSIONS)[number];

export interface DateRange {
  from: string;
  to: string;
}

/**
 * Whether a window spans the session measurement break.
 *
 * `SESSION_MEASUREMENT_BREAK` is the FIRST day of the new regime — 2025-12-31
 * is itself the stepped day in #74's table, at 187% where the days before it
 * sit at 82-107%. So a window crosses only if it contains a day before it AND
 * a day on or after it. A window starting exactly on the break is wholly in
 * the new regime and does not cross; one ending exactly on it does.
 *
 * Returned rather than logged: a caller comparing two halves of a window needs
 * to know the halves are not measured the same way, and cannot learn that from
 * the numbers themselves.
 */
export function crossesSessionBreak(range: DateRange): boolean {
  return range.from < SESSION_MEASUREMENT_BREAK && range.to >= SESSION_MEASUREMENT_BREAK;
}

export interface GscTotals {
  clicks: number;
  impressions: number;
  /** Computed from the totals, not averaged from daily rates. */
  ctr: number | null;
  /** Impression-weighted, because averaging a position over days ignores volume. */
  position: number | null;
  days: number;
  firstDate: string | null;
  lastDate: string | null;
}

export async function getGscTotals(db: Db, range: DateRange): Promise<GscTotals> {
  const [row] = await db
    .select({
      clicks: sql<number>`coalesce(sum(${gscDaily.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${gscDaily.impressions}), 0)::int`,
      position: sql<number | null>`
        case when sum(${gscDaily.impressions}) > 0
        then round((sum(${gscDaily.position} * ${gscDaily.impressions}) / sum(${gscDaily.impressions}))::numeric, 2)
        else null end`,
      days: sql<number>`count(distinct ${gscDaily.date})::int`,
      firstDate: sql<string | null>`min(${gscDaily.date})::text`,
      lastDate: sql<string | null>`max(${gscDaily.date})::text`,
    })
    .from(gscDaily)
    .where(and(eq(gscDaily.dimension, "total"), gte(gscDaily.date, range.from), lte(gscDaily.date, range.to)));

  return {
    ...row,
    // From the totals: averaging daily CTRs weights a quiet day like a busy one.
    ctr: row.impressions > 0 ? Number((row.clicks / row.impressions).toFixed(4)) : null,
    position: row.position === null ? null : Number(row.position),
  };
}

export interface GscRow {
  value: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export async function getGscByDimension(
  db: Db,
  dimension: GscDimension,
  range: DateRange,
  limit: number,
): Promise<{ rows: GscRow[]; matched: number }> {
  const base = and(
    eq(gscDaily.dimension, dimension),
    gte(gscDaily.date, range.from),
    lte(gscDaily.date, range.to),
  );

  const [{ matched }] = await db
    .select({ matched: sql<number>`count(distinct ${gscDaily.value})::int` })
    .from(gscDaily)
    .where(base);

  const rows = await db
    .select({
      value: gscDaily.value,
      clicks: sql<number>`sum(${gscDaily.clicks})::int`,
      impressions: sql<number>`sum(${gscDaily.impressions})::int`,
      position: sql<number | null>`
        case when sum(${gscDaily.impressions}) > 0
        then round((sum(${gscDaily.position} * ${gscDaily.impressions}) / sum(${gscDaily.impressions}))::numeric, 2)
        else null end`,
    })
    .from(gscDaily)
    .where(base)
    .groupBy(gscDaily.value)
    .orderBy(sql`sum(${gscDaily.clicks}) desc`)
    .limit(limit);

  return {
    matched,
    rows: rows.map((r) => ({
      ...r,
      ctr: r.impressions > 0 ? Number((r.clicks / r.impressions).toFixed(4)) : null,
      position: r.position === null ? null : Number(r.position),
    })),
  };
}

export interface SessionRow {
  value: string;
  sessions: number;
}

export async function getSessionTotals(
  db: Db,
  range: DateRange,
): Promise<{ sessions: number; days: number; firstDate: string | null; lastDate: string | null }> {
  const [row] = await db
    .select({
      sessions: sql<number>`coalesce(sum(${webSessions.sessions}), 0)::int`,
      days: sql<number>`count(distinct ${webSessions.date})::int`,
      firstDate: sql<string | null>`min(${webSessions.date})::text`,
      lastDate: sql<string | null>`max(${webSessions.date})::text`,
    })
    .from(webSessions)
    .where(
      and(
        eq(webSessions.dimension, "total"),
        gte(webSessions.date, range.from),
        lte(webSessions.date, range.to),
      ),
    );
  return row;
}

export async function getSessionsByDimension(
  db: Db,
  dimension: SessionDimension,
  range: DateRange,
  limit: number,
): Promise<{ rows: SessionRow[]; matched: number }> {
  const base = and(
    eq(webSessions.dimension, dimension),
    gte(webSessions.date, range.from),
    lte(webSessions.date, range.to),
  );

  const [{ matched }] = await db
    .select({ matched: sql<number>`count(distinct ${webSessions.value})::int` })
    .from(webSessions)
    .where(base);

  const rows = await db
    .select({
      value: webSessions.value,
      sessions: sql<number>`sum(${webSessions.sessions})::int`,
    })
    .from(webSessions)
    .where(base)
    .groupBy(webSessions.value)
    .orderBy(sql`sum(${webSessions.sessions}) desc`)
    .limit(limit);

  return { rows, matched };
}

export interface SessionsVsClicks {
  sessions: number;
  clicks: number;
  /** GSC clicks as a share of Shopify search sessions. */
  ratio: number | null;
}

/**
 * The cross-check that found the break: Search Console clicks against Shopify's
 * counted search sessions. A ratio near 1.0 is healthy; sustained above ~1.3
 * means Shopify is undercounting.
 */
export async function getSessionsVsClicks(db: Db, range: DateRange): Promise<SessionsVsClicks> {
  const [sessions] = await db
    .select({ n: sql<number>`coalesce(sum(${webSessions.sessions}), 0)::int` })
    .from(webSessions)
    .where(
      and(
        eq(webSessions.dimension, "referrer_source"),
        sql`lower(${webSessions.value}) = 'search'`,
        gte(webSessions.date, range.from),
        lte(webSessions.date, range.to),
      ),
    );

  const [clicks] = await db
    .select({ n: sql<number>`coalesce(sum(${gscDaily.clicks}), 0)::int` })
    .from(gscDaily)
    .where(and(eq(gscDaily.dimension, "total"), gte(gscDaily.date, range.from), lte(gscDaily.date, range.to)));

  return {
    sessions: sessions.n,
    clicks: clicks.n,
    ratio: sessions.n > 0 ? Number((clicks.n / sessions.n).toFixed(2)) : null,
  };
}
