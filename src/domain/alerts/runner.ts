/**
 * Alert runner — queries the DB for current state, runs all alert
 * checks, and returns any triggered alerts. Called after daily syncs.
 */

import type { Db } from "@/db/client";
import { gte, and, eq, sql } from "drizzle-orm";
import { metaInsights, shopifyOrders, socialPosts } from "@/db/schema";
import { aggregateAndCompute } from "@/domain/meta/metrics";
import { getPostSummary } from "@/domain/social/queries";
import { getUpcomingEntries } from "@/domain/calendar/queries";
import {
  checkNoEmailSends,
  checkReelOutperforming,
  checkRoasDropped,
  checkRevenueAnomaly,
  checkSubscriptionSignups,
  type Alert,
} from "./checks";

export async function runAlertChecks(db: Db): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // ─── Email/SMS check ──────────────────────────────────────────────
  try {
    const { attentiveCampaigns } = await import("@/db/schema");
    const [emailAgg] = await db
      .select({
        emailDelivered: sql<number>`COALESCE(SUM(CASE WHEN ${attentiveCampaigns.messageVariant} = 'Email' THEN ${attentiveCampaigns.delivered} ELSE 0 END), 0)`,
        smsDelivered: sql<number>`COALESCE(SUM(CASE WHEN ${attentiveCampaigns.messageVariant} = 'SMS' THEN ${attentiveCampaigns.delivered} ELSE 0 END), 0)`,
      })
      .from(attentiveCampaigns)
      .where(gte(attentiveCampaigns.date, sevenDaysAgo));

    // Check if there's an upcoming Email or SMS on the calendar
    let hasUpcoming = false;
    try {
      const upcoming = await getUpcomingEntries(db, 7);
      hasUpcoming = upcoming.some((e) => e.channel === "Email" || e.channel === "SMS");
    } catch {
      // Calendar table may not exist yet
    }

    const emailAlert = checkNoEmailSends({
      emailDelivered: Number(emailAgg.emailDelivered),
      smsDelivered: Number(emailAgg.smsDelivered),
      hasUpcomingCalendarEntry: hasUpcoming,
    });
    if (emailAlert) alerts.push(emailAlert);
  } catch {
    // Attentive table may not exist yet
  }

  // ─── Reel outperforming ───────────────────────────────────────────
  try {
    const socialSummary = await getPostSummary(db, 30);
    const recentPosts = await db
      .select({
        caption: socialPosts.caption,
        mediaProductType: socialPosts.mediaProductType,
        likeCount: socialPosts.likeCount,
        commentsCount: socialPosts.commentsCount,
        saved: socialPosts.saved,
        shares: socialPosts.shares,
        reach: socialPosts.reach,
        permalink: socialPosts.permalink,
      })
      .from(socialPosts)
      .where(gte(socialPosts.postedAt, sevenDaysAgo));

    // Find the top reel by engagement rate
    let topReel: { caption: string | null; engagementRate: number; saves: number; permalink: string | null } | null = null;
    for (const p of recentPosts) {
      if (p.mediaProductType !== "REELS" || p.reach === 0) continue;
      const eng = (p.likeCount + p.commentsCount + p.saved + p.shares) / p.reach * 100;
      if (!topReel || eng > topReel.engagementRate) {
        topReel = { caption: p.caption, engagementRate: eng, saves: p.saved, permalink: p.permalink };
      }
    }

    const reelAlert = checkReelOutperforming({
      avgEngagementRate: socialSummary.avgEngagementRate,
      topPost: topReel ? {
        caption: topReel.caption,
        engagementRate: topReel.engagementRate,
        saves: topReel.saves,
        format: "Reel",
        permalink: topReel.permalink,
      } : null,
    });
    if (reelAlert) alerts.push(reelAlert);
  } catch {
    // Social table may not exist yet
  }

  // ─── ROAS drop ────────────────────────────────────────────────────
  try {
    // This week's ROAS
    const thisWeekRows = await db
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
      .where(gte(metaInsights.date, sevenDaysAgo));

    // Last week's ROAS
    const lastWeekRows = await db
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
      .where(and(gte(metaInsights.date, fourteenDaysAgo), sql`${metaInsights.date} < ${sevenDaysAgo}`));

    const thisWeek = aggregateAndCompute(thisWeekRows.map((r) => ({
      spendCents: r.spendCents, impressions: Number(r.impressions),
      clicks: Number(r.clicks), reach: Number(r.reach),
      purchases: r.purchases, purchaseValueCents: r.purchaseValueCents,
      addToCart: r.addToCart, initiateCheckout: r.initiateCheckout,
    })));
    const lastWeek = aggregateAndCompute(lastWeekRows.map((r) => ({
      spendCents: r.spendCents, impressions: Number(r.impressions),
      clicks: Number(r.clicks), reach: Number(r.reach),
      purchases: r.purchases, purchaseValueCents: r.purchaseValueCents,
      addToCart: r.addToCart, initiateCheckout: r.initiateCheckout,
    })));

    const roasAlert = checkRoasDropped({
      thisWeekRoas: thisWeek.roas,
      lastWeekRoas: lastWeek.roas,
    });
    if (roasAlert) alerts.push(roasAlert);
  } catch {
    // Meta tables may not have data
  }

  // ─── Revenue anomaly ──────────────────────────────────────────────
  try {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dayStart = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const [dayRevenue] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${shopifyOrders.totalPriceCents}), 0)`,
      })
      .from(shopifyOrders)
      .where(and(gte(shopifyOrders.orderCreatedAt, dayStart), sql`${shopifyOrders.orderCreatedAt} < ${dayEnd}`));

    // Trailing 30-day average (excluding 1st of month days)
    const [trailingAvg] = await db
      .select({
        avgDaily: sql<number>`COALESCE(AVG(daily_total), 0)`,
      })
      .from(
        db
          .select({
            daily_total: sql<number>`SUM(${shopifyOrders.totalPriceCents})`.as("daily_total"),
            day_of_month: sql<number>`EXTRACT(DAY FROM ${shopifyOrders.orderCreatedAt})`.as("day_of_month"),
          })
          .from(shopifyOrders)
          .where(and(
            gte(shopifyOrders.orderCreatedAt, thirtyDaysAgo),
            sql`EXTRACT(DAY FROM ${shopifyOrders.orderCreatedAt}) != 1`
          ))
          .groupBy(sql`DATE(${shopifyOrders.orderCreatedAt}), EXTRACT(DAY FROM ${shopifyOrders.orderCreatedAt})`)
          .as("daily_totals")
      );

    const revenueAlert = checkRevenueAnomaly({
      todayRevenueCents: Number(dayRevenue.total),
      trailingAvgRevenueCents: Number(trailingAvg.avgDaily),
      todayDate: dayStart,
    });
    if (revenueAlert) alerts.push(revenueAlert);
  } catch {
    // May not have enough data yet
  }

  // ─── Subscription signups ─────────────────────────────────────────
  try {
    // This week's new subscription orders
    const [thisWeekSubs] = await db
      .select({
        count: sql<number>`COUNT(*)`,
      })
      .from(shopifyOrders)
      .where(and(
        gte(shopifyOrders.orderCreatedAt, sevenDaysAgo),
        eq(shopifyOrders.isRecurring, 1),
        // First-time subscription = their first recurring order
        // Approximate: look for orders with subscription tags
        sql`${shopifyOrders.orderCreatedAt} = (
          SELECT MIN(o2.order_created_at) FROM shopify_orders o2
          WHERE o2.customer_id = ${shopifyOrders.customerId} AND o2.is_recurring = 1
        )`
      ));

    // Average weekly new subs over last 30 days
    const [avgSubs] = await db
      .select({
        count: sql<number>`COUNT(*)`,
      })
      .from(shopifyOrders)
      .where(and(
        gte(shopifyOrders.orderCreatedAt, thirtyDaysAgo),
        eq(shopifyOrders.isRecurring, 1),
        sql`${shopifyOrders.orderCreatedAt} = (
          SELECT MIN(o2.order_created_at) FROM shopify_orders o2
          WHERE o2.customer_id = ${shopifyOrders.customerId} AND o2.is_recurring = 1
        )`
      ));

    const avgWeekly = Number(avgSubs.count) / 4.3; // ~4.3 weeks in 30 days

    const subAlert = checkSubscriptionSignups({
      newSubscribers: Number(thisWeekSubs.count),
      avgWeeklySubscribers: avgWeekly,
    });
    if (subAlert) alerts.push(subAlert);
  } catch {
    // May not have subscription data
  }

  return alerts;
}

/**
 * Format alerts for Slack posting.
 */
export function formatAlerts(alerts: Alert[]): string {
  if (alerts.length === 0) return "";

  const icons: Record<string, string> = {
    info: "INFO",
    warning: "HEADS UP",
    urgent: "URGENT",
  };

  return alerts
    .map((a) => `*[${icons[a.severity] ?? a.severity}]* ${a.message}`)
    .join("\n\n");
}
