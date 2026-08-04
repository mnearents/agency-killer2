/**
 * Attentive database queries — reads email/SMS campaign data
 * for the weekly report and analysis modules.
 */

import { gte, lte, and, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { attentiveCampaigns, attentiveRevenue } from "@/db/schema";

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
