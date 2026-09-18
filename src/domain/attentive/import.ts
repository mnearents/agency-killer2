/**
 * Attentive CSV import — parses CSV content and upserts to DB.
 * Handles deduplication via unique index on (date, message_variant).
 */

import type { Db } from "@/db/client";
import {
  attentiveCampaigns,
  attentiveCampaignMessages,
  attentiveCampaignSegments,
  attentiveJourneyMessages,
  attentiveMessageCosts,
  attentiveRevenue,
} from "@/db/schema";
import { sql } from "drizzle-orm";
import {
  parseCampaignPerformanceCsv,
  parseAttributedRevenueCsv,
  parseCampaignMessageCsv,
  parseCampaignSegmentCsv,
  parseJourneyMessageCsv,
  parseMessageCostCsv,
} from "./parse-csv";

export interface ImportResult {
  type: "campaign" | "revenue";
  imported: number;
  skipped: number;
  errors: string[];
}

function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export async function importCampaignPerformance(
  db: Db,
  csvContent: string
): Promise<ImportResult> {
  const rows = parseCampaignPerformanceCsv(csvContent);
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      await db
        .insert(attentiveCampaigns)
        .values({
          date: new Date(row.date + "T00:00:00Z"),
          messageVariant: row.messageVariant,
          hasMedia: row.hasMedia ? 1 : 0,
          delivered: row.delivered,
          totalClicks: row.totalClicks,
          totalClickRate: row.totalClickRate,
          conversions: row.conversions,
          conversionRate: row.conversionRate,
          revenueCents: dollarsToCents(row.revenueDollars),
          unsubscribes: row.unsubscribes,
          unsubscribeRate: row.unsubscribeRate,
        })
        .onConflictDoUpdate({
          target: [attentiveCampaigns.date, attentiveCampaigns.messageVariant],
          set: {
            delivered: sql`EXCLUDED.delivered`,
            totalClicks: sql`EXCLUDED.total_clicks`,
            totalClickRate: sql`EXCLUDED.total_click_rate`,
            conversions: sql`EXCLUDED.conversions`,
            conversionRate: sql`EXCLUDED.conversion_rate`,
            revenueCents: sql`EXCLUDED.revenue_cents`,
            unsubscribes: sql`EXCLUDED.unsubscribes`,
            unsubscribeRate: sql`EXCLUDED.unsubscribe_rate`,
            hasMedia: sql`EXCLUDED.has_media`,
          },
        });
      imported++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Row ${row.date} ${row.messageVariant}: ${msg}`);
      skipped++;
    }
  }

  return { type: "campaign", imported, skipped, errors };
}

export async function importAttributedRevenue(
  db: Db,
  csvContent: string
): Promise<ImportResult> {
  const rows = parseAttributedRevenueCsv(csvContent);
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      await db
        .insert(attentiveRevenue)
        .values({
          date: new Date(row.date + "T00:00:00Z"),
          conversions: row.conversions,
          revenueCents: dollarsToCents(row.totalRevenueDollars),
          avgOrderValueCents: dollarsToCents(row.avgOrderValueDollars),
        })
        .onConflictDoUpdate({
          target: [attentiveRevenue.date],
          set: {
            conversions: sql`EXCLUDED.conversions`,
            revenueCents: sql`EXCLUDED.revenue_cents`,
            avgOrderValueCents: sql`EXCLUDED.avg_order_value_cents`,
          },
        });
      imported++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Row ${row.date}: ${msg}`);
      skipped++;
    }
  }

  return { type: "revenue", imported, skipped, errors };
}

/**
 * Auto-detect CSV type from header and import accordingly.
 */
export async function importAttentiveCsv(
  db: Db,
  csvContent: string
): Promise<ImportResult> {
  // Strip BOM and normalize line endings
  const cleaned = csvContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstLine = cleaned.split("\n")[0] ?? "";

  console.log(`[attentive] Header detected: "${firstLine.slice(0, 80)}..."`);

  if (firstLine.includes("Message Variant") || firstLine.includes("Message Send Date")) {
    return importCampaignPerformance(db, cleaned);
  }

  if (firstLine.includes("Conversion Date") || firstLine.includes("Average Order Value")) {
    return importAttributedRevenue(db, cleaned);
  }

  return {
    type: "campaign",
    imported: 0,
    skipped: 0,
    errors: ["Unrecognized CSV format. Expected Attentive Campaign Performance or Attributed Revenue export."],
  };
}

/**
 * ─── Campaign, segment, journey and cost imports (#23) ────────────────
 *
 * Each one upserts on the dedup index for its grain, so a re-import of an
 * overlapping window corrects rows rather than duplicating them. Attentive
 * restates recent days as conversions attribute, which is exactly why the
 * update path has to exist.
 *
 * A row that fails is counted and named, never swallowed: `skipped` with an
 * empty `errors` array and `skipped` with a reason are different states, and
 * only the second is diagnosable.
 */

/** One date parse, one place, so a timezone slip cannot differ per table. */
function asDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export interface DetailImportResult {
  type: "campaign-message" | "campaign-segment" | "journey-message" | "message-cost";
  imported: number;
  skipped: number;
  errors: string[];
}

export async function importCampaignMessages(
  db: Db,
  csvContent: string
): Promise<DetailImportResult> {
  const result: DetailImportResult = {
    type: "campaign-message",
    imported: 0,
    skipped: 0,
    errors: [],
  };

  for (const row of parseCampaignMessageCsv(csvContent)) {
    try {
      await db
        .insert(attentiveCampaignMessages)
        .values({
          date: asDate(row.date),
          campaign: row.campaign,
          message: row.message,
          messageVariant: row.messageVariant,
          channel: row.channel,
          hasMedia: row.hasMedia ? 1 : 0,
          delivered: row.delivered,
          emailSends: row.emailSends,
          emailUniqueOpens: row.emailUniqueOpens,
          emailUniqueClicks: row.emailUniqueClicks,
          totalClicks: row.totalClicks,
          conversions: row.conversions,
          revenueCents: row.revenueCents,
          avgOrderValueCents: row.avgOrderValueCents,
          unsubscribes: row.unsubscribes,
          emailHardBounces: row.emailHardBounces,
        })
        .onConflictDoUpdate({
          target: [
            attentiveCampaignMessages.date,
            attentiveCampaignMessages.campaign,
            attentiveCampaignMessages.message,
            attentiveCampaignMessages.channel,
          ],
          set: {
            messageVariant: sql`EXCLUDED.message_variant`,
            hasMedia: sql`EXCLUDED.has_media`,
            delivered: sql`EXCLUDED.delivered`,
            emailSends: sql`EXCLUDED.email_sends`,
            emailUniqueOpens: sql`EXCLUDED.email_unique_opens`,
            emailUniqueClicks: sql`EXCLUDED.email_unique_clicks`,
            totalClicks: sql`EXCLUDED.total_clicks`,
            conversions: sql`EXCLUDED.conversions`,
            revenueCents: sql`EXCLUDED.revenue_cents`,
            avgOrderValueCents: sql`EXCLUDED.avg_order_value_cents`,
            unsubscribes: sql`EXCLUDED.unsubscribes`,
            emailHardBounces: sql`EXCLUDED.email_hard_bounces`,
            importedAt: sql`NOW()`,
          },
        });
      result.imported++;
    } catch (err) {
      result.skipped++;
      result.errors.push(
        `${row.date} ${row.campaign} / ${row.message}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

export async function importCampaignSegments(
  db: Db,
  csvContent: string
): Promise<DetailImportResult> {
  const result: DetailImportResult = {
    type: "campaign-segment",
    imported: 0,
    skipped: 0,
    errors: [],
  };

  for (const row of parseCampaignSegmentCsv(csvContent)) {
    try {
      await db
        .insert(attentiveCampaignSegments)
        .values({
          date: asDate(row.date),
          message: row.message,
          segment: row.segment,
          channel: row.channel,
          delivered: row.delivered,
          totalClicks: row.totalClicks,
          conversions: row.conversions,
          revenueCents: row.revenueCents,
          unsubscribes: row.unsubscribes,
        })
        .onConflictDoUpdate({
          target: [
            attentiveCampaignSegments.date,
            attentiveCampaignSegments.message,
            attentiveCampaignSegments.segment,
            attentiveCampaignSegments.channel,
          ],
          set: {
            delivered: sql`EXCLUDED.delivered`,
            totalClicks: sql`EXCLUDED.total_clicks`,
            conversions: sql`EXCLUDED.conversions`,
            revenueCents: sql`EXCLUDED.revenue_cents`,
            unsubscribes: sql`EXCLUDED.unsubscribes`,
            importedAt: sql`NOW()`,
          },
        });
      result.imported++;
    } catch (err) {
      result.skipped++;
      result.errors.push(
        `${row.date} ${row.message} / ${row.segment}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

export async function importJourneyMessages(
  db: Db,
  csvContent: string
): Promise<DetailImportResult> {
  const result: DetailImportResult = {
    type: "journey-message",
    imported: 0,
    skipped: 0,
    errors: [],
  };

  for (const row of parseJourneyMessageCsv(csvContent)) {
    try {
      await db
        .insert(attentiveJourneyMessages)
        .values({
          date: asDate(row.date),
          journeyName: row.journeyName,
          triggerName: row.triggerName,
          message: row.message,
          channel: row.channel,
          delivered: row.delivered,
          totalClicks: row.totalClicks,
          conversions: row.conversions,
          revenueCents: row.revenueCents,
          avgOrderValueCents: row.avgOrderValueCents,
          unsubscribes: row.unsubscribes,
        })
        .onConflictDoUpdate({
          target: [
            attentiveJourneyMessages.date,
            attentiveJourneyMessages.journeyName,
            attentiveJourneyMessages.message,
            attentiveJourneyMessages.channel,
          ],
          set: {
            triggerName: sql`EXCLUDED.trigger_name`,
            delivered: sql`EXCLUDED.delivered`,
            totalClicks: sql`EXCLUDED.total_clicks`,
            conversions: sql`EXCLUDED.conversions`,
            revenueCents: sql`EXCLUDED.revenue_cents`,
            avgOrderValueCents: sql`EXCLUDED.avg_order_value_cents`,
            unsubscribes: sql`EXCLUDED.unsubscribes`,
            importedAt: sql`NOW()`,
          },
        });
      result.imported++;
    } catch (err) {
      result.skipped++;
      result.errors.push(
        `${row.date} ${row.journeyName} / ${row.message}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

export async function importMessageCosts(
  db: Db,
  csvContent: string
): Promise<DetailImportResult> {
  const result: DetailImportResult = {
    type: "message-cost",
    imported: 0,
    skipped: 0,
    errors: [],
  };

  for (const row of parseMessageCostCsv(csvContent)) {
    try {
      await db
        .insert(attentiveMessageCosts)
        .values({
          date: asDate(row.date),
          campaignCostCents: row.campaignCostCents,
          automatedSendCostCents: row.automatedSendCostCents,
          receivedCostCents: row.receivedCostCents,
          carrierFeesCents: row.carrierFeesCents,
          totalCents: row.totalCents,
        })
        .onConflictDoUpdate({
          target: [attentiveMessageCosts.date],
          set: {
            campaignCostCents: sql`EXCLUDED.campaign_cost_cents`,
            automatedSendCostCents: sql`EXCLUDED.automated_send_cost_cents`,
            receivedCostCents: sql`EXCLUDED.received_cost_cents`,
            carrierFeesCents: sql`EXCLUDED.carrier_fees_cents`,
            totalCents: sql`EXCLUDED.total_cents`,
            importedAt: sql`NOW()`,
          },
        });
      result.imported++;
    } catch (err) {
      result.skipped++;
      result.errors.push(
        `${row.date}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}
