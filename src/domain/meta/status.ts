/**
 * Meta ads quick status — returns a formatted summary of active
 * campaigns without calling the AI. Fast, data-only response.
 */

import type { Db } from "@/db/client";
import { eq, gte, and, sql } from "drizzle-orm";
import { metaCampaigns, metaInsights } from "@/db/schema";
import { aggregateAndCompute, type DerivedMetrics } from "./metrics";
import type { InsightRow } from "./metrics";

export interface CampaignStatus {
  id: string;
  name: string;
  status: string;
  metrics: DerivedMetrics;
}

export interface AdsStatusResult {
  campaigns: CampaignStatus[];
  dateRange: { start: string; end: string };
}

/**
 * Get a quick status of all active campaigns with last 7 days metrics.
 * No AI call — just formatted data from the DB.
 */
export async function getAdsStatus(
  db: Db,
  lookbackDays = 7
): Promise<AdsStatusResult> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  // Get active campaigns
  const campaigns = await db
    .select({ id: metaCampaigns.id, name: metaCampaigns.name, status: metaCampaigns.status })
    .from(metaCampaigns)
    .where(eq(metaCampaigns.status, "ACTIVE"));

  const results: CampaignStatus[] = [];

  for (const campaign of campaigns) {
    const insightRows = await db
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
        and(
          eq(metaInsights.campaignId, campaign.id),
          gte(metaInsights.date, startDate)
        )
      );

    const rows: InsightRow[] = insightRows.map((r) => ({
      spendCents: r.spendCents,
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
      reach: Number(r.reach),
      purchases: r.purchases,
      purchaseValueCents: r.purchaseValueCents,
      addToCart: r.addToCart,
      initiateCheckout: r.initiateCheckout,
    }));

    results.push({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      metrics: aggregateAndCompute(rows),
    });
  }

  return { campaigns: results, dateRange: { start: startStr, end: endStr } };
}

/**
 * Format ads status for Slack — no AI, just clean data presentation.
 */
export function formatAdsStatus(result: AdsStatusResult): string {
  if (result.campaigns.length === 0) {
    return `No active campaigns found (${result.dateRange.start} to ${result.dateRange.end}). Make sure Meta sync has run.`;
  }

  const lines = [
    `*Ad Status* (${result.dateRange.start} to ${result.dateRange.end})`,
    "",
  ];

  for (const c of result.campaigns) {
    const m = c.metrics;
    lines.push(`*${c.name}*`);
    lines.push(`  Spend: $${m.spendDollars.toFixed(2)} | Revenue: $${m.revenueDollars.toFixed(2)} | ROAS: ${m.roas?.toFixed(2) ?? "N/A"}`);
    lines.push(`  CTR: ${m.ctr?.toFixed(2) ?? "N/A"}% | CPC: $${m.cpc?.toFixed(2) ?? "N/A"} | Purchases: ${m.roas !== null ? Math.round(m.revenueDollars / (m.costPerPurchaseDollars ?? 1)) : 0}`);
    lines.push("");
  }

  return lines.join("\n");
}
