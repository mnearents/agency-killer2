/**
 * Seal subscription sync — full crawl, then upsert current state + a daily
 * snapshot.
 *
 * Seal offers no incremental read: there is no `since` parameter, and unknown
 * query params are silently ignored rather than rejected, so a filter that
 * looks like it worked may have done nothing. The only honest option is to
 * pull all ~88 pages every time.
 */

import type { SealApiClient } from "@/integrations/seal-api";
import type { Db } from "@/db/client";
import { sealSubscriptions, sealSubscriptionSnapshots } from "@/db/schema";
import {
  transformSubscription,
  summariseTransform,
  type TransformSummary,
} from "./sync-transform";

export interface SealSyncDeps {
  client: SealApiClient;
  db: Db;
}

export interface SealSyncLogger {
  warn: (message: string) => void;
}

export interface SealSyncResult {
  subscriptions: number;
  snapshots: number;
  summary: TransformSummary;
  errors: string[];
}

const flag = (b: boolean) => (b ? 1 : 0);

const EMPTY_SUMMARY: TransformSummary = {
  total: 0,
  byStatus: {},
  byTier: {},
  byCadence: {},
  inDunning: 0,
  unknownTier: 0,
  planConflicts: 0,
  manualOrigin: 0,
  priceAnomalies: 0,
  anomalousTotalCents: 0,
  mrrCents: 0,
  warnings: [],
};

export async function syncSubscriptions(
  deps: SealSyncDeps,
  now: Date,
  logger: SealSyncLogger = { warn: (m) => console.warn(`[sync:seal] ${m}`) }
): Promise<SealSyncResult> {
  const { client, db } = deps;
  const errors: string[] = [];
  let subscriptionCount = 0;
  let snapshotCount = 0;

  let raw;
  try {
    raw = await client.getAllSubscriptions();
  } catch (err) {
    errors.push(`Seal crawl: ${err instanceof Error ? err.message : String(err)}`);
    return { subscriptions: 0, snapshots: 0, summary: EMPTY_SUMMARY, errors };
  }

  // A crawl that returns nothing is far more likely to be a broken token or a
  // changed envelope than a store with zero subscribers. Writing it would
  // blank the current-state table and record a snapshot day showing total
  // collapse — a fabricated churn event that looks exactly like a real one.
  if (raw.length === 0) {
    errors.push("Seal crawl returned no subscriptions — refusing to write. Treating as a failed sync.");
    return { subscriptions: 0, snapshots: 0, summary: EMPTY_SUMMARY, errors };
  }

  const transformed = raw.map((s) => transformSubscription(s, now));
  const summary = summariseTransform(transformed);

  for (const warning of summary.warnings) logger.warn(warning);

  for (const { row, snapshot } of transformed) {
    const values = {
      id: row.id,
      orderId: row.orderId,
      shopifyOrderId: row.shopifyOrderId,
      manualOrigin: flag(row.manualOrigin),
      email: row.email,
      status: row.status,
      tier: row.tier,
      pricingCohort: row.pricingCohort,
      variantId: row.variantId,
      productId: row.productId,
      variantSku: row.variantSku,
      productTitle: row.productTitle,
      sellingPlanId: row.sellingPlanId,
      sellingPlanName: row.sellingPlanName,
      planConflict: flag(row.planConflict),
      priceCents: row.priceCents,
      priceAnomaly: flag(row.priceAnomaly),
      currency: row.currency,
      billingInterval: row.billingInterval,
      billingCadence: row.billingCadence,
      orderPlaced: row.orderPlaced,
      nextBillingDate: row.nextBillingDate,
      cancelledOn: row.cancelledOn,
      cancellationReason: row.cancellationReason,
      inDunning: flag(row.inDunning),
      lastErrorCode: row.lastErrorCode,
      lastErrorMessage: row.lastErrorMessage,
      lastErrorAt: row.lastErrorAt,
      rawJson: row.raw,
      syncedAt: row.syncedAt,
    };

    try {
      await db
        .insert(sealSubscriptions)
        .values(values)
        .onConflictDoUpdate({
          target: sealSubscriptions.id,
          set: { ...values, updatedAt: now },
        });
      subscriptionCount++;

      const snapshotValues = {
        id: `${snapshot.snapshotDate}:${snapshot.subscriptionId}`,
        snapshotDate: snapshot.snapshotDate,
        subscriptionId: snapshot.subscriptionId,
        status: snapshot.status,
        tier: snapshot.tier,
        pricingCohort: snapshot.pricingCohort,
        billingInterval: snapshot.billingInterval,
        billingCadence: snapshot.billingCadence,
        priceCents: snapshot.priceCents,
        inDunning: flag(snapshot.inDunning),
        createdAt: snapshot.createdAt,
      };

      // Re-running a sync on the same day corrects that day's snapshot rather
      // than duplicating it.
      await db
        .insert(sealSubscriptionSnapshots)
        .values(snapshotValues)
        .onConflictDoUpdate({
          target: sealSubscriptionSnapshots.id,
          set: snapshotValues,
        });
      snapshotCount++;
    } catch (err) {
      errors.push(
        `Subscription ${row.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { subscriptions: subscriptionCount, snapshots: snapshotCount, summary, errors };
}
