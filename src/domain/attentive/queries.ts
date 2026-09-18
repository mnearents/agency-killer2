/**
 * Attentive database queries — reads email/SMS campaign data
 * for the weekly report and analysis modules.
 */

import { gte, lte, and, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  attentiveCampaigns,
  attentiveCampaignMessages,
  attentiveCampaignSegments,
  attentiveJourneyMessages,
  attentiveMessageCosts,
  attentiveRevenue,
} from "@/db/schema";

export interface AttentiveWeekSummary {
  // Campaign performance
  emailDelivered: number;
  emailClicks: number;
  emailConversions: number;
  emailRevenueCents: number;
  emailUnsubscribes: number;
  smsDelivered: number;
  smsClicks: number;
  smsConversions: number;
  smsRevenueCents: number;
  smsUnsubscribes: number;
  // Attributed revenue
  totalAttributedConversions: number;
  totalAttributedRevenueCents: number;
}

export async function getAttentiveWeekSummary(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<AttentiveWeekSummary> {
  // Campaign data by variant
  const campaignRows = await db
    .select({
      messageVariant: attentiveCampaigns.messageVariant,
      delivered: sql<number>`COALESCE(SUM(${attentiveCampaigns.delivered}), 0)`,
      clicks: sql<number>`COALESCE(SUM(${attentiveCampaigns.totalClicks}), 0)`,
      conversions: sql<number>`COALESCE(SUM(${attentiveCampaigns.conversions}), 0)`,
      revenueCents: sql<number>`COALESCE(SUM(${attentiveCampaigns.revenueCents}), 0)`,
      unsubscribes: sql<number>`COALESCE(SUM(${attentiveCampaigns.unsubscribes}), 0)`,
    })
    .from(attentiveCampaigns)
    .where(
      and(
        gte(attentiveCampaigns.date, startDate),
        lte(attentiveCampaigns.date, endDate)
      )
    )
    .groupBy(attentiveCampaigns.messageVariant);

  const emailRow = campaignRows.find((r) => r.messageVariant === "Email");
  const smsRow = campaignRows.find((r) => r.messageVariant === "SMS");

  // Attributed revenue
  const [revenueAgg] = await db
    .select({
      conversions: sql<number>`COALESCE(SUM(${attentiveRevenue.conversions}), 0)`,
      revenueCents: sql<number>`COALESCE(SUM(${attentiveRevenue.revenueCents}), 0)`,
    })
    .from(attentiveRevenue)
    .where(
      and(
        gte(attentiveRevenue.date, startDate),
        lte(attentiveRevenue.date, endDate)
      )
    );

  return {
    emailDelivered: Number(emailRow?.delivered ?? 0),
    emailClicks: Number(emailRow?.clicks ?? 0),
    emailConversions: Number(emailRow?.conversions ?? 0),
    emailRevenueCents: Number(emailRow?.revenueCents ?? 0),
    emailUnsubscribes: Number(emailRow?.unsubscribes ?? 0),
    smsDelivered: Number(smsRow?.delivered ?? 0),
    smsClicks: Number(smsRow?.clicks ?? 0),
    smsConversions: Number(smsRow?.conversions ?? 0),
    smsRevenueCents: Number(smsRow?.revenueCents ?? 0),
    smsUnsubscribes: Number(smsRow?.unsubscribes ?? 0),
    totalAttributedConversions: Number(revenueAgg?.conversions ?? 0),
    totalAttributedRevenueCents: Number(revenueAgg?.revenueCents ?? 0),
  };
}

/**
 * ─── Campaign and journey detail (#23) ────────────────────────────────
 *
 * The aggregate above is one row per day per channel, so a winning launch
 * email and four filler sends average into one mediocre number and neither
 * fact survives. These read the per-message grain.
 *
 * Every one returns unsubscribes alongside revenue. #23: "a campaign with
 * strong revenue and a spike in unsubscribes borrowed from future sends rather
 * than earning anything, and with revenue alone it looks like a win worth
 * repeating."
 */

export interface CampaignMessagePerformance {
  date: string;
  campaign: string;
  message: string;
  channel: string;
  delivered: number;
  emailUniqueOpens: number;
  totalClicks: number;
  conversions: number;
  revenueCents: number;
  unsubscribes: number;
}

export async function getCampaignMessagePerformance(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<CampaignMessagePerformance[]> {
  const rows = await db
    .select({
      date: attentiveCampaignMessages.date,
      campaign: attentiveCampaignMessages.campaign,
      message: attentiveCampaignMessages.message,
      channel: attentiveCampaignMessages.channel,
      delivered: attentiveCampaignMessages.delivered,
      emailUniqueOpens: attentiveCampaignMessages.emailUniqueOpens,
      totalClicks: attentiveCampaignMessages.totalClicks,
      conversions: attentiveCampaignMessages.conversions,
      revenueCents: attentiveCampaignMessages.revenueCents,
      unsubscribes: attentiveCampaignMessages.unsubscribes,
    })
    .from(attentiveCampaignMessages)
    .where(
      and(
        gte(attentiveCampaignMessages.date, startDate),
        lte(attentiveCampaignMessages.date, endDate)
      )
    )
    .orderBy(sql`${attentiveCampaignMessages.revenueCents} DESC`);

  return rows.map((r) => ({ ...r, date: r.date.toISOString().slice(0, 10) }));
}

export interface SegmentPerformance {
  date: string;
  message: string;
  segment: string;
  channel: string;
  delivered: number;
  totalClicks: number;
  conversions: number;
  revenueCents: number;
  unsubscribes: number;
}

export async function getCampaignSegmentPerformance(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<SegmentPerformance[]> {
  const rows = await db
    .select({
      date: attentiveCampaignSegments.date,
      message: attentiveCampaignSegments.message,
      segment: attentiveCampaignSegments.segment,
      channel: attentiveCampaignSegments.channel,
      delivered: attentiveCampaignSegments.delivered,
      totalClicks: attentiveCampaignSegments.totalClicks,
      conversions: attentiveCampaignSegments.conversions,
      revenueCents: attentiveCampaignSegments.revenueCents,
      unsubscribes: attentiveCampaignSegments.unsubscribes,
    })
    .from(attentiveCampaignSegments)
    .where(
      and(
        gte(attentiveCampaignSegments.date, startDate),
        lte(attentiveCampaignSegments.date, endDate)
      )
    )
    .orderBy(sql`${attentiveCampaignSegments.revenueCents} DESC`);

  return rows.map((r) => ({ ...r, date: r.date.toISOString().slice(0, 10) }));
}

export interface JourneyMessagePerformance {
  journeyName: string;
  triggerName: string;
  message: string;
  channel: string;
  sendDays: number;
  delivered: number;
  totalClicks: number;
  conversions: number;
  revenueCents: number;
  unsubscribes: number;
}

/**
 * Journey messages, rolled up over the window.
 *
 * Per-day rows are the storage grain, but the question a journey poses is
 * "which step drops people", and one day of one step is too little traffic to
 * answer it. `sendDays` is returned so a step that ran twice is never mistaken
 * for one that ran all month.
 */
export async function getJourneyMessagePerformance(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<JourneyMessagePerformance[]> {
  return db
    .select({
      journeyName: attentiveJourneyMessages.journeyName,
      triggerName: sql<string>`MIN(${attentiveJourneyMessages.triggerName})`,
      message: attentiveJourneyMessages.message,
      channel: attentiveJourneyMessages.channel,
      sendDays: sql<number>`COUNT(DISTINCT ${attentiveJourneyMessages.date})`,
      delivered: sql<number>`COALESCE(SUM(${attentiveJourneyMessages.delivered}), 0)`,
      totalClicks: sql<number>`COALESCE(SUM(${attentiveJourneyMessages.totalClicks}), 0)`,
      conversions: sql<number>`COALESCE(SUM(${attentiveJourneyMessages.conversions}), 0)`,
      revenueCents: sql<number>`COALESCE(SUM(${attentiveJourneyMessages.revenueCents}), 0)`,
      unsubscribes: sql<number>`COALESCE(SUM(${attentiveJourneyMessages.unsubscribes}), 0)`,
    })
    .from(attentiveJourneyMessages)
    .where(
      and(
        gte(attentiveJourneyMessages.date, startDate),
        lte(attentiveJourneyMessages.date, endDate)
      )
    )
    .groupBy(
      attentiveJourneyMessages.journeyName,
      attentiveJourneyMessages.message,
      attentiveJourneyMessages.channel
    )
    .orderBy(sql`COALESCE(SUM(${attentiveJourneyMessages.revenueCents}), 0) DESC`);
}

export interface MessageCostTotals {
  campaignCostCents: number;
  automatedSendCostCents: number;
  receivedCostCents: number;
  carrierFeesCents: number;
  totalCents: number;
  /** Days with a cost row. Zero of thirty is a gap, not a free month. */
  days: number;
}

export async function getMessageCostTotals(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<MessageCostTotals> {
  const [row] = await db
    .select({
      campaignCostCents: sql<number>`COALESCE(SUM(${attentiveMessageCosts.campaignCostCents}), 0)`,
      automatedSendCostCents: sql<number>`COALESCE(SUM(${attentiveMessageCosts.automatedSendCostCents}), 0)`,
      receivedCostCents: sql<number>`COALESCE(SUM(${attentiveMessageCosts.receivedCostCents}), 0)`,
      carrierFeesCents: sql<number>`COALESCE(SUM(${attentiveMessageCosts.carrierFeesCents}), 0)`,
      totalCents: sql<number>`COALESCE(SUM(${attentiveMessageCosts.totalCents}), 0)`,
      days: sql<number>`COUNT(*)`,
    })
    .from(attentiveMessageCosts)
    .where(
      and(
        gte(attentiveMessageCosts.date, startDate),
        lte(attentiveMessageCosts.date, endDate)
      )
    );

  return {
    campaignCostCents: Number(row?.campaignCostCents ?? 0),
    automatedSendCostCents: Number(row?.automatedSendCostCents ?? 0),
    receivedCostCents: Number(row?.receivedCostCents ?? 0),
    carrierFeesCents: Number(row?.carrierFeesCents ?? 0),
    totalCents: Number(row?.totalCents ?? 0),
    days: Number(row?.days ?? 0),
  };
}
