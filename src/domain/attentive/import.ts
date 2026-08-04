/**
 * Attentive CSV import — parses CSV content and upserts to DB.
 * Handles deduplication via unique index on (date, message_variant).
 */

import type { Db } from "@/db/client";
import { attentiveCampaigns, attentiveRevenue } from "@/db/schema";
import { sql } from "drizzle-orm";
import {
  parseCampaignPerformanceCsv,
  parseAttributedRevenueCsv,
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
