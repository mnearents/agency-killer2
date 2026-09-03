/**
 * Data freshness — how current each synced source is.
 *
 * This exists because an analysis drawn from stale data looks exactly like an
 * analysis drawn from fresh data. Anything reading this database should be able
 * to ask "is this worth trusting?" before it draws a conclusion.
 */

import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import {
  metaInsights,
  shopifyOrders,
  shopifyInventory,
  socialPosts,
  attentiveCampaigns,
  sealSubscriptions,
  syncRuns,
} from "./schema";
import { isFailure, type SyncOutcome } from "@/domain/meta/outcomes";
import { SYNC_TASK } from "@/domain/meta/sync";

/**
 * `synced` means the row records when we last pulled from the API.
 * `latest-data` means there is no sync timestamp and the newest data point is
 * the best proxy — true for manually imported sources.
 */
export type FreshnessBasis = "synced" | "latest-data";

/**
 * What the most recent sync attempt for this source did.
 *
 * Row counts alone cannot answer "why is this empty?" — a source that errored,
 * one that found nothing, and one that never ran all show zero rows. The
 * outcome is the only thing that tells them apart.
 */
export interface LastRun {
  outcome: SyncOutcome;
  at: string | null;
  errorMessage: string | null;
}

export interface RawFreshness {
  source: string;
  table: string;
  basis: FreshnessBasis;
  staleAfterHours: number;
  rows: number;
  lastAt: Date | null;
  /** Null for sources that do not record sync runs. */
  lastRun?: LastRun | null;
}

export interface SourceFreshness {
  source: string;
  table: string;
  basis: FreshnessBasis;
  rows: number;
  lastAt: string | null;
  ageHours: number | null;
  stale: boolean;
  lastRun: LastRun | null;
}

const HOUR_MS = 60 * 60 * 1000;

export function classifyFreshness(rows: RawFreshness[], now: Date): SourceFreshness[] {
  return rows.map((r) => {
    const lastRun = r.lastRun ?? null;

    // No timestamp or no rows means we have nothing, which is the loudest
    // possible signal — never let it read as a healthy empty result.
    if (!r.lastAt || r.rows === 0) {
      return {
        source: r.source,
        table: r.table,
        basis: r.basis,
        rows: r.rows,
        lastAt: null,
        ageHours: null,
        stale: true,
        lastRun,
      };
    }

    const ageHours = (now.getTime() - r.lastAt.getTime()) / HOUR_MS;
    return {
      source: r.source,
      table: r.table,
      basis: r.basis,
      rows: r.rows,
      lastAt: r.lastAt.toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      // A failed last run means the data is frozen at whatever it was, however
      // recent that looks. Age alone would call it healthy right up until it
      // crossed the window — days of silent rot before anyone noticed.
      stale: ageHours > r.staleAfterHours || (lastRun !== null && isFailure(lastRun.outcome)),
      lastRun,
    };
  });
}

// Everything below syncs daily, so a day and a half without one is a problem.
const DAILY_SYNC_STALE_HOURS = 36;
// Attentive has no API — Matt imports it by hand, so two weeks is normal.
const MANUAL_IMPORT_STALE_HOURS = 336;

/** The most recent recorded run for a task, or null if it has never run. */
async function lastRunFor(db: Db, task: string): Promise<LastRun | null> {
  const [row] = await db
    .select({
      outcome: syncRuns.outcome,
      finishedAt: syncRuns.finishedAt,
      errorMessage: syncRuns.errorMessage,
    })
    .from(syncRuns)
    .where(eq(syncRuns.task, task))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  if (!row) return null;
  return {
    outcome: row.outcome as SyncOutcome,
    at: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
    errorMessage: row.errorMessage ?? null,
  };
}

export async function getDataFreshness(db: Db, now: Date): Promise<SourceFreshness[]> {
  const sources = [
    { source: "Meta ads", table: metaInsights, name: "meta_insights", column: metaInsights.syncedAt, basis: "synced" as const, staleAfterHours: DAILY_SYNC_STALE_HOURS, task: SYNC_TASK },
    { source: "Shopify orders", table: shopifyOrders, name: "shopify_orders", column: shopifyOrders.syncedAt, basis: "synced" as const, staleAfterHours: DAILY_SYNC_STALE_HOURS },
    { source: "Shopify inventory", table: shopifyInventory, name: "shopify_inventory", column: shopifyInventory.syncedAt, basis: "synced" as const, staleAfterHours: DAILY_SYNC_STALE_HOURS },
    { source: "Subscriptions (Seal)", table: sealSubscriptions, name: "seal_subscriptions", column: sealSubscriptions.syncedAt, basis: "synced" as const, staleAfterHours: DAILY_SYNC_STALE_HOURS },
    { source: "Instagram/Facebook posts", table: socialPosts, name: "social_posts", column: socialPosts.syncedAt, basis: "synced" as const, staleAfterHours: DAILY_SYNC_STALE_HOURS },
    { source: "Email/SMS (Attentive)", table: attentiveCampaigns, name: "attentive_campaigns", column: attentiveCampaigns.date, basis: "latest-data" as const, staleAfterHours: MANUAL_IMPORT_STALE_HOURS },
  ];

  const raw: RawFreshness[] = [];
  for (const s of sources) {
    const [row] = await db
      .select({
        rows: sql<number>`COUNT(*)`,
        lastAt: sql<Date | null>`MAX(${s.column})`,
      })
      .from(s.table);

    raw.push({
      source: s.source,
      table: s.name,
      basis: s.basis,
      staleAfterHours: s.staleAfterHours,
      rows: Number(row?.rows ?? 0),
      lastAt: row?.lastAt ? new Date(row.lastAt) : null,
      lastRun: "task" in s && s.task ? await lastRunFor(db, s.task) : null,
    });
  }

  return classifyFreshness(raw, now);
}
