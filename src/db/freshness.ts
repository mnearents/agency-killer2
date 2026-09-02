/**
 * Data freshness — how current each synced source is.
 *
 * This exists because an analysis drawn from stale data looks exactly like an
 * analysis drawn from fresh data. Anything reading this database should be able
 * to ask "is this worth trusting?" before it draws a conclusion.
 */

import { sql } from "drizzle-orm";
import type { Db } from "./client";
import {
  metaInsights,
  shopifyOrders,
  shopifyInventory,
  socialPosts,
  attentiveCampaigns,
  sealSubscriptions,
} from "./schema";

/**
 * `synced` means the row records when we last pulled from the API.
 * `latest-data` means there is no sync timestamp and the newest data point is
 * the best proxy — true for manually imported sources.
 */
export type FreshnessBasis = "synced" | "latest-data";

export interface RawFreshness {
  source: string;
  table: string;
  basis: FreshnessBasis;
  staleAfterHours: number;
  rows: number;
  lastAt: Date | null;
}

export interface SourceFreshness {
  source: string;
  table: string;
  basis: FreshnessBasis;
  rows: number;
  lastAt: string | null;
  ageHours: number | null;
  stale: boolean;
}

const HOUR_MS = 60 * 60 * 1000;

export function classifyFreshness(rows: RawFreshness[], now: Date): SourceFreshness[] {
  return rows.map((r) => {
    // No timestamp or no rows means we have nothing, which is the loudest
    // possible signal — never let it read as a healthy empty result.
    if (!r.lastAt || r.rows === 0) {
      return {
        source: r.source,
        table: r.table,
        basis: r.basis,
        rows: r.rows,
        lastAt: null,
        ageHours: null,
        stale: true,
      };
    }

    const ageHours = (now.getTime() - r.lastAt.getTime()) / HOUR_MS;
    return {
      source: r.source,
      table: r.table,
      basis: r.basis,
      rows: r.rows,
      lastAt: r.lastAt.toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      stale: ageHours > r.staleAfterHours,
    };
  });
}

// Everything below syncs daily, so a day and a half without one is a problem.
const DAILY_SYNC_STALE_HOURS = 36;
// Attentive has no API — Matt imports it by hand, so two weeks is normal.
const MANUAL_IMPORT_STALE_HOURS = 336;

export async function getDataFreshness(db: Db, now: Date): Promise<SourceFreshness[]> {
  const sources = [
    { source: "Meta ads", table: metaInsights, name: "meta_insights", column: metaInsights.syncedAt, basis: "synced" as const, staleAfterHours: DAILY_SYNC_STALE_HOURS },
    { source: "Shopify orders", table: shopifyOrders, name: "shopify_orders", column: shopifyOrders.syncedAt, basis: "synced" as const, staleAfterHours: DAILY_SYNC_STALE_HOURS },
    { source: "Shopify inventory", table: shopifyInventory, name: "shopify_inventory", column: shopifyInventory.syncedAt, basis: "synced" as const, staleAfterHours: DAILY_SYNC_STALE_HOURS },
    { source: "Subscriptions (Seal)", table: sealSubscriptions, name: "seal_subscriptions", column: sealSubscriptions.syncedAt, basis: "synced" as const, staleAfterHours: DAILY_SYNC_STALE_HOURS },
    { source: "Instagram/Facebook posts", table: socialPosts, name: "social_posts", column: socialPosts.syncedAt, basis: "synced" as const, staleAfterHours: DAILY_SYNC_STALE_HOURS },
    { source: "Email/SMS (Attentive)", table: attentiveCampaigns, name: "attentive_campaigns", column: attentiveCampaigns.date, basis: "latest-data" as const, staleAfterHours: MANUAL_IMPORT_STALE_HOURS },
  ];

  const raw: RawFreshness[] = [];
  for (const s of sources) {
    const [row] = await db
      .select({
        rows: sql<number>`COUNT(*)`,
        lastAt: sql<Date | null>`MAX(${s.column})`,
      })
      .from(s.table);

    raw.push({
      source: s.source,
      table: s.name,
      basis: s.basis,
      staleAfterHours: s.staleAfterHours,
      rows: Number(row?.rows ?? 0),
      lastAt: row?.lastAt ? new Date(row.lastAt) : null,
    });
  }

  return classifyFreshness(raw, now);
}
