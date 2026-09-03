/**
 * Meta ads quick status — returns a formatted summary of campaigns without
 * calling the AI. Fast, data-only response.
 *
 * This used to select only `status = 'ACTIVE'`. Every campaign on this account
 * is paused, so it reported "No active campaigns found... make sure Meta sync
 * has run" — blaming the sync for a deliberate decision to stop spending.
 * Paused is a state worth reporting, not an absence.
 */

import type { Db } from "@/db/client";
import { eq, gte, and, notInArray, sql } from "drizzle-orm";
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

/** Campaigns Meta considers gone. Everything else is worth reporting. */
const HIDDEN_STATUSES = ["DELETED", "ARCHIVED"];

/**
 * Get a quick status of every live-or-paused campaign with last 7 days metrics.
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

  const campaigns = await db
    .select({ id: metaCampaigns.id, name: metaCampaigns.name, status: metaCampaigns.status })
    .from(metaCampaigns)
    .where(notInArray(metaCampaigns.status, HIDDEN_STATUSES));

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

  // Biggest spender first — a paused campaign that burned the budget matters
  // more than a live one that never got going.
  results.sort((a, b) => b.metrics.spendDollars - a.metrics.spendDollars);

  return { campaigns: results, dateRange: { start: startStr, end: endStr } };
}

/** Plain-English label for a Meta campaign status. Tara reads these. */
function statusLabel(status: string): string {
  if (status === "ACTIVE") return "running";
  if (status === "PAUSED") return "paused";
  return status.toLowerCase().replace(/_/g, " ");
}

/**
 * Format ads status for Slack — no AI, just clean data presentation.
 */
export function formatAdsStatus(result: AdsStatusResult): string {
  // Only a genuinely empty campaign table can mean the sync never landed.
  if (result.campaigns.length === 0) {
    return `No campaigns in the database (${result.dateRange.start} to ${result.dateRange.end}). Nothing has been synced from Meta yet — check \`!data freshness\` for why.`;
  }

  const lines = [
    `*Ad Status* (${result.dateRange.start} to ${result.dateRange.end})`,
  ];

  const running = result.campaigns.filter((c) => c.status === "ACTIVE");
  if (running.length === 0) {
    lines.push(
      `_Nothing is running right now — all ${result.campaigns.length} campaign${result.campaigns.length === 1 ? " is" : "s are"} paused. The numbers below are from whatever spend fell inside this window._`
    );
  }
  lines.push("");

  for (const c of result.campaigns) {
    const m = c.metrics;
    lines.push(`*${c.name}* — ${statusLabel(c.status)}`);
    lines.push(`  Spend: $${m.spendDollars.toFixed(2)} | Revenue: $${m.revenueDollars.toFixed(2)} | ROAS: ${m.roas?.toFixed(2) ?? "N/A"}`);
    lines.push(`  CTR: ${m.ctr?.toFixed(2) ?? "N/A"}% | CPC: $${m.cpc?.toFixed(2) ?? "N/A"} | Purchases: ${m.roas !== null ? Math.round(m.revenueDollars / (m.costPerPurchaseDollars ?? 1)) : 0}`);
    lines.push("");
  }

  return lines.join("\n");
}
