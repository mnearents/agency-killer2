/**
 * Meta sync service — orchestrates pulling data from Meta API,
 * transforming it, and upserting to the database.
 *
 * Dependencies injected for testability. The sync functions are
 * deterministic given their inputs — all I/O goes through the
 * injected client and db.
 */

import type { MetaApiClient } from "@/integrations/meta-api";
import type { Db } from "@/db/client";
import {
  metaCampaigns,
  metaAdSets,
  metaAds,
  metaCreatives,
  metaInsights,
  syncRuns,
} from "@/db/schema";
import {
  transformCampaign,
  transformAdSet,
  transformAd,
  transformCreative,
  transformInsight,
} from "./sync-transform";
import { classifyOutcome, type SyncOutcome } from "./outcomes";

/** The `sync_runs.task` value every daily Meta sync is recorded under. */
export const SYNC_TASK = "sync:meta";

export interface SyncDeps {
  client: MetaApiClient;
  db: Db;
  accountId: string;
  /** Injected for determinism in tests. */
  now?: () => Date;
}

export interface SyncResult {
  campaigns: number;
  adSets: number;
  ads: number;
  creatives: number;
  insights: number;
  errors: string[];
  /**
   * The thrown errors themselves, not just their messages.
   *
   * `errors` (strings) loses Meta's numeric error code, which is the only
   * reliable way to tell an expired token from a throttle. Keeping the objects
   * lets `syncIncremental` classify the run instead of guessing from text.
   */
  failures: unknown[];
}

/**
 * Sync campaign structure (campaigns, adsets, ads, creatives).
 * Does not pull insights — use syncInsights separately.
 */
export async function syncStructure(deps: SyncDeps): Promise<SyncResult> {
  const { client, db, accountId } = deps;
  const syncedAt = new Date();
  const errors: string[] = [];
  const failures: unknown[] = [];
  let campaignCount = 0;
  let adSetCount = 0;
  let adCount = 0;
  let creativeCount = 0;

  try {
    const rawCampaigns = await client.getCampaigns(accountId);
    for (const raw of rawCampaigns) {
      const row = transformCampaign(raw, syncedAt);
      row.accountId = accountId;
      await db
        .insert(metaCampaigns)
        .values(row)
        .onConflictDoUpdate({
          target: metaCampaigns.id,
          set: { ...row, updatedAt: syncedAt },
        });
      campaignCount++;
    }
  } catch (err) {
    errors.push(`Campaigns: ${err instanceof Error ? err.message : String(err)}`);
    failures.push(err);
  }

  try {
    const rawAdSets = await client.getAdSets(accountId);
    for (const raw of rawAdSets) {
      const row = transformAdSet(raw, syncedAt);
      await db
        .insert(metaAdSets)
        .values(row)
        .onConflictDoUpdate({
          target: metaAdSets.id,
          set: { ...row, updatedAt: syncedAt },
        });
      adSetCount++;
    }
  } catch (err) {
    errors.push(`AdSets: ${err instanceof Error ? err.message : String(err)}`);
    failures.push(err);
  }

  try {
    const rawAds = await client.getAds(accountId);
    for (const raw of rawAds) {
      const row = transformAd(raw, syncedAt);
      await db
        .insert(metaAds)
        .values(row)
        .onConflictDoUpdate({
          target: metaAds.id,
          set: { ...row, updatedAt: syncedAt },
        });
      adCount++;
    }
  } catch (err) {
    errors.push(`Ads: ${err instanceof Error ? err.message : String(err)}`);
    failures.push(err);
  }

  try {
    const rawCreatives = await client.getCreatives(accountId);
    for (const raw of rawCreatives) {
      const row = transformCreative(raw, syncedAt);
      await db
        .insert(metaCreatives)
        .values(row)
        .onConflictDoUpdate({
          target: metaCreatives.id,
          set: { ...row, updatedAt: syncedAt },
        });
      creativeCount++;
    }
  } catch (err) {
    errors.push(`Creatives: ${err instanceof Error ? err.message : String(err)}`);
    failures.push(err);
  }

  return {
    campaigns: campaignCount,
    adSets: adSetCount,
    ads: adCount,
    creatives: creativeCount,
    insights: 0,
    errors,
    failures,
  };
}

/**
 * Sync insights for a date range. Uses the dedup unique index
 * to upsert — same (ad_id, date, platform, position) overwrites.
 */
export async function syncInsights(
  deps: SyncDeps,
  startDate: string,
  endDate: string
): Promise<SyncResult> {
  const { client, db, accountId } = deps;
  const syncedAt = new Date();
  const errors: string[] = [];
  const failures: unknown[] = [];
  let insightCount = 0;

  try {
    const rawInsights = await client.getInsights(accountId, startDate, endDate);
    for (const raw of rawInsights) {
      const row = transformInsight(raw, syncedAt);
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
            cpm: row.cpm,
            cpc: row.cpc,
            ctr: row.ctr,
            purchases: row.purchases,
            purchaseValueCents: row.purchaseValueCents,
            addToCart: row.addToCart,
            initiateCheckout: row.initiateCheckout,
            rawJson: row.rawJson,
            syncedAt,
            updatedAt: syncedAt,
          },
        });
      insightCount++;
    }
  } catch (err) {
    errors.push(`Insights: ${err instanceof Error ? err.message : String(err)}`);
    failures.push(err);
  }

  return {
    campaigns: 0,
    adSets: 0,
    ads: 0,
    creatives: 0,
    insights: insightCount,
    errors,
    failures,
  };
}

export interface IncrementalSyncResult extends SyncResult {
  /** Why this run looks the way it does — recorded to `sync_runs` as well. */
  outcome: SyncOutcome;
  errorCode: number | null;
}

/**
 * Full incremental sync — structure + last N days of insights.
 * This is what the daily scheduled task calls.
 *
 * Every call writes exactly one `sync_runs` row. That row is the whole point:
 * without it, a run that errored, a run that found nothing, and a run that never
 * happened were three different problems wearing the same "Done: 0 insights".
 */
export async function syncIncremental(
  deps: SyncDeps,
  lookbackDays = 7
): Promise<IncrementalSyncResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();

  const structureResult = await syncStructure(deps);

  const endDate = startedAt.toISOString().split("T")[0];
  const startDate = new Date(startedAt.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const insightsResult = await syncInsights(deps, startDate, endDate);

  const failures = [...structureResult.failures, ...insightsResult.failures];
  const rowsWritten =
    structureResult.campaigns +
    structureResult.adSets +
    structureResult.ads +
    structureResult.creatives +
    insightsResult.insights;

  // The first failure classifies the run. Any failure at all outranks the row
  // count — a partial sync reported as "ok" is exactly the disguise this branch
  // exists to remove.
  const classified = classifyOutcome({
    configured: true,
    rowsWritten,
    error: failures[0],
  });

  await deps.db.insert(syncRuns).values({
    task: SYNC_TASK,
    outcome: classified.outcome,
    windowStart: new Date(`${startDate}T00:00:00Z`),
    windowEnd: new Date(`${endDate}T00:00:00Z`),
    rowsWritten,
    errorMessage:
      // Keep every message, not just the classified one: four entities sync
      // independently and any subset of them can fail.
      failures.length > 0
        ? [...structureResult.errors, ...insightsResult.errors].join("; ")
        : null,
    errorCode: classified.errorCode,
    startedAt,
    finishedAt: now(),
  });

  return {
    campaigns: structureResult.campaigns,
    adSets: structureResult.adSets,
    ads: structureResult.ads,
    creatives: structureResult.creatives,
    insights: insightsResult.insights,
    errors: [...structureResult.errors, ...insightsResult.errors],
    failures,
    outcome: classified.outcome,
    errorCode: classified.errorCode,
  };
}

/**
 * Record that the sync could not run at all because configuration is missing.
 *
 * Called from the worker's early-return path. Previously that path logged one
 * line and wrote nothing, which is why `meta_insights` could sit empty for
 * months without a single trace of the cause anywhere in the database.
 */
export async function recordUnconfiguredSync(
  db: Db,
  missing: string,
  now: () => Date = () => new Date()
): Promise<void> {
  const at = now();
  const classified = classifyOutcome({ configured: false, rowsWritten: 0 });

  await db.insert(syncRuns).values({
    task: SYNC_TASK,
    outcome: classified.outcome,
    windowStart: null,
    windowEnd: null,
    rowsWritten: 0,
    errorMessage: `Not configured: ${missing} is not set`,
    errorCode: null,
    startedAt: at,
    finishedAt: at,
  });
}
