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
} from "@/db/schema";
import {
  transformCampaign,
  transformAdSet,
  transformAd,
  transformCreative,
  transformInsight,
} from "./sync-transform";

export interface SyncDeps {
  client: MetaApiClient;
  db: Db;
  accountId: string;
}

export interface SyncResult {
  campaigns: number;
  adSets: number;
  ads: number;
  creatives: number;
  insights: number;
  errors: string[];
}

/**
 * Sync campaign structure (campaigns, adsets, ads, creatives).
 * Does not pull insights — use syncInsights separately.
 */
export async function syncStructure(deps: SyncDeps): Promise<SyncResult> {
  const { client, db, accountId } = deps;
  const syncedAt = new Date();
  const errors: string[] = [];
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
  }

  return {
    campaigns: campaignCount,
    adSets: adSetCount,
    ads: adCount,
    creatives: creativeCount,
    insights: 0,
    errors,
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
  }

  return {
    campaigns: 0,
    adSets: 0,
    ads: 0,
    creatives: 0,
    insights: insightCount,
    errors,
  };
}

/**
 * Full incremental sync — structure + last N days of insights.
 * This is what the daily scheduled task calls.
 */
export async function syncIncremental(
  deps: SyncDeps,
  lookbackDays = 7
): Promise<SyncResult> {
  const structureResult = await syncStructure(deps);

  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const insightsResult = await syncInsights(deps, startDate, endDate);

  return {
    campaigns: structureResult.campaigns,
    adSets: structureResult.adSets,
    ads: structureResult.ads,
    creatives: structureResult.creatives,
    insights: insightsResult.insights,
    errors: [...structureResult.errors, ...insightsResult.errors],
  };
}
