/**
 * Weekly report generation — the full pipeline from DB to AI-generated
 * Monday morning briefing.
 *
 * Pulls data from all channels, formats it, runs through Claude,
 * and returns the finished report text.
 */

import type { Db } from "@/db/client";
import type { OrchestratorRequest, OrchestratorResult } from "@/ai/orchestrator";
import type { VoicePromptResult } from "@/domain/voice/voice";
import { getInsightsByCampaign, getInsightsByAdCreative } from "@/domain/meta/queries";
import { aggregateAndCompute } from "@/domain/meta/metrics";
import { getOrderSummary, getTopProducts } from "@/domain/shopify/queries";
import { getPostsByDateRange, toPostRow } from "@/domain/social/queries";
import { computePostMetrics, computeFormatBreakdown } from "@/domain/social/metrics";
import {
  computeWeekRange,
  formatWeeklyDataBlock,
  type AdsWeekData,
  type ShopifyWeekData,
  type SocialWeekData,
  type EmailSmsWeekData,
  type WeeklyReportData,
  type CreativeSummary,
} from "./weekly-data";
import { buildWeeklyReportRequest } from "./weekly-analysis";
import { getAttentiveWeekSummary } from "@/domain/attentive/queries";

export interface WeeklyReportDeps {
  db: Db;
  voice: VoicePromptResult;
  runOrchestrator: (request: OrchestratorRequest) => Promise<OrchestratorResult>;
  getKbContext?: () => Promise<string>;
}

export interface WeeklyReportResult {
  ok: boolean;
  text: string;
  weekRange: { start: string; end: string; label: string };
}

export async function generateWeeklyReport(
  deps: WeeklyReportDeps
): Promise<WeeklyReportResult> {
  const now = new Date();
  const weekRange = computeWeekRange(now);
  const startDate = new Date(weekRange.start + "T00:00:00Z");
  const endDate = new Date(weekRange.end + "T23:59:59Z");

  // ─── Ads data ────────────────────────────────────────────────────
  let ads: AdsWeekData = {
    totalSpendDollars: 0, totalRevenueDollars: 0, roas: null,
    totalImpressions: 0, totalClicks: 0, ctr: null,
    totalPurchases: 0, costPerPurchaseDollars: null, topCreatives: [],
  };

  try {
    const campaignData = await getInsightsByCampaign(deps.db, startDate, endDate);
    if (campaignData.length > 0) {
      const allRows = campaignData.flatMap((c) => c.rows);
      const metrics = aggregateAndCompute(allRows);
      ads = {
        totalSpendDollars: metrics.spendDollars,
        totalRevenueDollars: metrics.revenueDollars,
        roas: metrics.roas,
        totalImpressions: allRows.reduce((a, r) => a + r.impressions, 0),
        totalClicks: allRows.reduce((a, r) => a + r.clicks, 0),
        ctr: metrics.ctr,
        totalPurchases: allRows.reduce((a, r) => a + r.purchases, 0),
        costPerPurchaseDollars: metrics.costPerPurchaseDollars,
        topCreatives: [],
      };

      // Get top creatives
      try {
        const creativeData = await getInsightsByAdCreative(deps.db, startDate, endDate);
        const creativeSummaries: CreativeSummary[] = creativeData
          .map((c) => {
            const m = aggregateAndCompute(c.rows);
            return {
              name: c.adName,
              roas: m.roas,
              spendDollars: m.spendDollars,
              revenueDollars: m.revenueDollars,
            };
          })
          .filter((c) => c.spendDollars > 0)
          .sort((a, b) => (b.roas ?? -1) - (a.roas ?? -1))
          .slice(0, 5);
        ads.topCreatives = creativeSummaries;
      } catch {
        // Non-fatal
      }
    }
  } catch (err) {
    console.error("[weekly-report] Failed to fetch ads data:", err);
  }

  // ─── Shopify data ────────────────────────────────────────────────
  let shopify: ShopifyWeekData = {
    totalOrders: 0, totalRevenueDollars: 0,
    subscriptionOrders: 0, subscriptionRevenueDollars: 0,
    avgOrderValueDollars: 0, topProducts: [],
  };

  try {
    const summary = await getOrderSummary(deps.db, 7);
    const products = await getTopProducts(deps.db, 5);

    shopify = {
      totalOrders: summary.totalOrders,
      totalRevenueDollars: summary.totalRevenueCents / 100,
      subscriptionOrders: summary.subscriptionOrders,
      subscriptionRevenueDollars: summary.subscriptionRevenueCents / 100,
      avgOrderValueDollars: summary.totalOrders > 0
        ? summary.totalRevenueCents / 100 / summary.totalOrders
        : 0,
      topProducts: products.map((p) => ({
        title: p.title,
        count: 0, // getTopProducts doesn't return count, just ranked
      })),
    };
  } catch (err) {
    console.error("[weekly-report] Failed to fetch Shopify data:", err);
  }

  // ─── Social data ─────────────────────────────────────────────────
  let social: SocialWeekData = {
    postsPublished: 0, totalReach: 0, avgEngagementRate: null,
    totalSaves: 0, totalShares: 0, topPost: null, reelPlays: 0,
  };

  try {
    const posts = await getPostsByDateRange(deps.db, startDate, endDate);
    if (posts.length > 0) {
      const postRows = posts.map(toPostRow);
      const totalEng = postRows.reduce(
        (a, p) => a + p.likeCount + p.commentsCount + p.saved + p.shares, 0
      );
      const totalReach = postRows.reduce((a, p) => a + p.reach, 0);

      // Find top post by engagement rate
      const metricsWithIdx = postRows.map((row, idx) => ({
        row,
        idx,
        metrics: computePostMetrics(row),
      }));
      metricsWithIdx.sort((a, b) => {
        const aVal = a.metrics.engagementRate ?? -Infinity;
        const bVal = b.metrics.engagementRate ?? -Infinity;
        return bVal - aVal;
      });

      const best = metricsWithIdx[0];
      const bestPost = posts[best.idx];

      const formatLabel = best.metrics.isReel
        ? "Reel"
        : best.row.mediaType === "CAROUSEL_ALBUM"
        ? "Carousel"
        : "Image";

      social = {
        postsPublished: posts.length,
        totalReach,
        avgEngagementRate: totalReach > 0 ? (totalEng / totalReach) * 100 : null,
        totalSaves: postRows.reduce((a, p) => a + p.saved, 0),
        totalShares: postRows.reduce((a, p) => a + p.shares, 0),
        topPost: {
          caption: bestPost.caption,
          engagementRate: best.metrics.engagementRate,
          saves: best.row.saved,
          format: formatLabel,
          permalink: bestPost.permalink,
        },
        reelPlays: postRows
          .filter((p) => p.mediaProductType === "REELS")
          .reduce((a, p) => a + p.plays, 0),
      };
    }
  } catch (err) {
    console.error("[weekly-report] Failed to fetch social data:", err);
  }

  // ─── Attentive (Email/SMS) data ───────────────────────────────────
  let emailSms: EmailSmsWeekData | undefined;
  try {
    const attentive = await getAttentiveWeekSummary(deps.db, startDate, endDate);
    if (attentive.emailDelivered > 0 || attentive.smsDelivered > 0) {
      emailSms = {
        emailDelivered: attentive.emailDelivered,
        emailClicks: attentive.emailClicks,
        emailConversions: attentive.emailConversions,
        emailRevenueDollars: attentive.emailRevenueCents / 100,
        emailUnsubscribes: attentive.emailUnsubscribes,
        smsDelivered: attentive.smsDelivered,
        smsClicks: attentive.smsClicks,
        smsConversions: attentive.smsConversions,
        smsRevenueDollars: attentive.smsRevenueCents / 100,
        smsUnsubscribes: attentive.smsUnsubscribes,
      };
    }
  } catch {
    // Table may not exist yet — non-fatal
  }

  // ─── Assemble and generate ───────────────────────────────────────
  const reportData: WeeklyReportData = { weekRange, ads, shopify, social, emailSms };
  const dataBlock = formatWeeklyDataBlock(reportData);

  let kbContext: string | undefined;
  if (deps.getKbContext) {
    try {
      kbContext = await deps.getKbContext();
    } catch {
      // Non-fatal
    }
  }

  const request = buildWeeklyReportRequest({
    dataBlock,
    voice: deps.voice,
    kbContext,
  });

  const result = await deps.runOrchestrator(request);

  if (!result.ok) {
    const violations = result.guardrailResult.violations
      .map((v) => v.detail)
      .join("; ");
    return {
      ok: false,
      text: `Weekly report was blocked by guardrails: ${violations}`,
      weekRange,
    };
  }

  return {
    ok: true,
    text: result.text,
    weekRange,
  };
}
