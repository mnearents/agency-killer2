/**
 * Meta ads database queries — reads from Postgres and returns
 * typed data for the metrics and analysis modules.
 *
 * These are the DB read seam. Tests can mock these functions
 * instead of mocking the full Drizzle query builder.
 */

import { eq, gte, lte, and, sql, desc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { metaInsights, metaCampaigns, metaAds, metaCreatives } from "@/db/schema";
import type { InsightRow } from "./metrics";

export interface CampaignInsightSummary {
  campaignId: string;
  campaignName: string;
  rows: InsightRow[];
}

/**
 * Get aggregated insight rows for a date range, grouped by campaign.
 */
export async function getInsightsByCampaign(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<CampaignInsightSummary[]> {
  const rows = await db
    .select({
      campaignId: metaInsights.campaignId,
      spendCents: metaInsights.spendCents,
      impressions: metaInsights.impressions,
      clicks: metaInsights.clicks,
      reach: metaInsights.reach,
      purchases: metaInsights.purchases,
      purchaseValueCents: metaInsights.purchaseValueCents,
      addToCart: metaInsights.addToCart,
      initiateCheckout: metaInsights.initiateCheckout,
    })
    .from(metaInsights)
    .where(
      and(gte(metaInsights.date, startDate), lte(metaInsights.date, endDate))
    )
    .orderBy(metaInsights.campaignId);

  // Group by campaign
  const grouped = new Map<string, InsightRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.campaignId) ?? [];
    existing.push({
      spendCents: row.spendCents,
      impressions: Number(row.impressions),
      clicks: Number(row.clicks),
      reach: Number(row.reach),
      purchases: row.purchases,
      purchaseValueCents: row.purchaseValueCents,
      addToCart: row.addToCart,
      initiateCheckout: row.initiateCheckout,
    });
    grouped.set(row.campaignId, existing);
  }

  // Look up campaign names
  const results: CampaignInsightSummary[] = [];
  for (const [campaignId, insightRows] of grouped) {
    const campaign = await db
      .select({ name: metaCampaigns.name })
      .from(metaCampaigns)
      .where(eq(metaCampaigns.id, campaignId))
      .limit(1);

    results.push({
      campaignId,
      campaignName: campaign[0]?.name ?? campaignId,
      rows: insightRows,
    });
  }

  return results;
}

/**
 * Get total insight rows (all campaigns combined) for a date range.
 */
export async function getInsightTotals(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<InsightRow[]> {
  const rows = await db
    .select({
      spendCents: metaInsights.spendCents,
      impressions: metaInsights.impressions,
      clicks: metaInsights.clicks,
      reach: metaInsights.reach,
      purchases: metaInsights.purchases,
      purchaseValueCents: metaInsights.purchaseValueCents,
      addToCart: metaInsights.addToCart,
      initiateCheckout: metaInsights.initiateCheckout,
    })
    .from(metaInsights)
    .where(
      and(gte(metaInsights.date, startDate), lte(metaInsights.date, endDate))
    );

  return rows.map((row) => ({
    spendCents: row.spendCents,
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    reach: Number(row.reach),
    purchases: row.purchases,
    purchaseValueCents: row.purchaseValueCents,
    addToCart: row.addToCart,
    initiateCheckout: row.initiateCheckout,
  }));
}

export interface DailyMetrics {
  date: string; // YYYY-MM-DD
  spendCents: number;
  revenueCents: number;
  impressions: number;
  clicks: number;
  purchases: number;
}

/**
 * Get daily aggregated metrics for trending charts.
 */
export async function getDailyMetrics(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<DailyMetrics[]> {
  const rows = await db
    .select({
      date: sql<string>`DATE(${metaInsights.date})`.as("date"),
      spendCents: sql<number>`SUM(${metaInsights.spendCents})`.as("spend_cents"),
      revenueCents: sql<number>`SUM(${metaInsights.purchaseValueCents})`.as("revenue_cents"),
      impressions: sql<number>`SUM(${metaInsights.impressions})`.as("impressions"),
      clicks: sql<number>`SUM(${metaInsights.clicks})`.as("clicks"),
      purchases: sql<number>`SUM(${metaInsights.purchases})`.as("purchases"),
    })
    .from(metaInsights)
    .where(and(gte(metaInsights.date, startDate), lte(metaInsights.date, endDate)))
    .groupBy(sql`DATE(${metaInsights.date})`)
    .orderBy(sql`DATE(${metaInsights.date})`);

  return rows.map((r) => ({
    date: String(r.date).split("T")[0],
    spendCents: Number(r.spendCents ?? 0),
    revenueCents: Number(r.revenueCents ?? 0),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    purchases: Number(r.purchases ?? 0),
  }));
}

export interface AdCreativeInsight {
  adId: string;
  adName: string;
  campaignName: string;
  creativeTitle: string | null;
  creativeBody: string | null;
  creativeImageUrl: string | null;
  rows: InsightRow[];
}

/**
 * Get insight rows grouped by ad, with creative metadata.
 * This is the foundation for creative-focused analysis.
 */
export async function getInsightsByAdCreative(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<AdCreativeInsight[]> {
  // Get all insights grouped by ad
  const rows = await db
    .select({
      adId: metaInsights.adId,
      campaignId: metaInsights.campaignId,
      spendCents: metaInsights.spendCents,
      impressions: metaInsights.impressions,
      clicks: metaInsights.clicks,
      reach: metaInsights.reach,
      purchases: metaInsights.purchases,
      purchaseValueCents: metaInsights.purchaseValueCents,
      addToCart: metaInsights.addToCart,
      initiateCheckout: metaInsights.initiateCheckout,
    })
    .from(metaInsights)
    .where(
      and(gte(metaInsights.date, startDate), lte(metaInsights.date, endDate))
    )
    .orderBy(metaInsights.adId);

  // Group by ad
  const grouped = new Map<string, { campaignId: string; rows: InsightRow[] }>();
  for (const row of rows) {
    const existing = grouped.get(row.adId) ?? { campaignId: row.campaignId, rows: [] };
    existing.rows.push({
      spendCents: row.spendCents,
      impressions: Number(row.impressions),
      clicks: Number(row.clicks),
      reach: Number(row.reach),
      purchases: row.purchases,
      purchaseValueCents: row.purchaseValueCents,
      addToCart: row.addToCart,
      initiateCheckout: row.initiateCheckout,
    });
    grouped.set(row.adId, existing);
  }

  // Look up ad names, campaign names, and creative metadata
  const results: AdCreativeInsight[] = [];
  for (const [adId, data] of grouped) {
    const [ad] = await db
      .select({ name: metaAds.name, creativeId: metaAds.creativeId })
      .from(metaAds)
      .where(eq(metaAds.id, adId))
      .limit(1);

    const [campaign] = await db
      .select({ name: metaCampaigns.name })
      .from(metaCampaigns)
      .where(eq(metaCampaigns.id, data.campaignId))
      .limit(1);

    let creativeTitle: string | null = null;
    let creativeBody: string | null = null;
    let creativeImageUrl: string | null = null;

    if (ad?.creativeId) {
      const [creative] = await db
        .select({
          title: metaCreatives.title,
          body: metaCreatives.body,
          imageUrl: metaCreatives.imageUrl,
        })
        .from(metaCreatives)
        .where(eq(metaCreatives.id, ad.creativeId))
        .limit(1);

      if (creative) {
        creativeTitle = creative.title;
        creativeBody = creative.body;
        creativeImageUrl = creative.imageUrl;
      }
    }

    results.push({
      adId,
      adName: ad?.name ?? adId,
      campaignName: campaign?.name ?? data.campaignId,
      creativeTitle,
      creativeBody,
      creativeImageUrl,
      rows: data.rows,
    });
  }

  return results;
}
