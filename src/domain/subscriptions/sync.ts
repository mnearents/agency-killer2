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

/**
 * Customer IDs live only on the single-subscription endpoint, one request
 * each. The backfill script covers the existing ~4,390; this cap keeps a sync
 * that runs before the backfill from firing thousands of requests and looking
 * like a hang. Normal daily arrivals are a handful.
 */
const MAX_CUSTOMER_LOOKUPS_PER_SYNC = 50;
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
  /** Single-endpoint calls made this run to resolve new customer IDs. */
  customerLookups: number;
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
    return { subscriptions: 0, snapshots: 0, customerLookups: 0, summary: EMPTY_SUMMARY, errors };
  }

  // A crawl that returns nothing is far more likely to be a broken token or a
  // changed envelope than a store with zero subscribers. Writing it would
  // blank the current-state table and record a snapshot day showing total
  // collapse — a fabricated churn event that looks exactly like a real one.
  if (raw.length === 0) {
    errors.push("Seal crawl returned no subscriptions — refusing to write. Treating as a failed sync.");
    return { subscriptions: 0, snapshots: 0, customerLookups: 0, summary: EMPTY_SUMMARY, errors };
  }

  const transformed = raw.map((s) => transformSubscription(s, now));
  const summary = summariseTransform(transformed);

  // Reuse every customer ID already stored; only genuinely new subscriptions
  // cost a request.
  const knownCustomerIds = new Map<string, string | null>();
  const checkedAt = new Map<string, Date | null>();
  try {
    const rows = await db
      .select({
        id: sealSubscriptions.id,
        customerId: sealSubscriptions.customerId,
        customerIdCheckedAt: sealSubscriptions.customerIdCheckedAt,
      })
      .from(sealSubscriptions);
    for (const r of rows) {
      if (r.customerId) {
        knownCustomerIds.set(r.id, r.customerId);
        // Carried forward so a later sync does not blank the date it was found.
        checkedAt.set(r.id, r.customerIdCheckedAt ?? null);
      }
    }
  } catch (err) {
    // Not fatal: worst case every subscription looks new, and the cap keeps
    // that from turning into thousands of requests.
    errors.push(
      `Loading stored customer ids: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const needsLookup = transformed
    .map(({ row }) => row.id)
    .filter((id) => !knownCustomerIds.has(id));

  if (needsLookup.length > MAX_CUSTOMER_LOOKUPS_PER_SYNC) {
    logger.warn(
      `${needsLookup.length} subscriptions have no stored customer id; looking up ` +
        `${MAX_CUSTOMER_LOOKUPS_PER_SYNC} and leaving ${needsLookup.length - MAX_CUSTOMER_LOOKUPS_PER_SYNC} ` +
        `for the next sync. Run the customer-id backfill script if this is the initial load.`
    );
  }

  let customerLookups = 0;
  for (const id of needsLookup.slice(0, MAX_CUSTOMER_LOOKUPS_PER_SYNC)) {
    try {
      const customerId = await client.getSubscriptionCustomerId(id);
      // Record the check even when there is no customer, so "no customer" is
      // never mistaken for "not looked up yet".
      knownCustomerIds.set(id, customerId);
      checkedAt.set(id, now);
      customerLookups++;
    } catch (err) {
      errors.push(
        `Customer id lookup for ${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  for (const warning of summary.warnings) logger.warn(warning);

  for (const { row, snapshot } of transformed) {
    const values = {
      id: row.id,
      orderId: row.orderId,
      shopifyOrderId: row.shopifyOrderId,
      manualOrigin: flag(row.manualOrigin),
      email: row.email,
      customerId: knownCustomerIds.get(row.id) ?? null,
      customerIdCheckedAt: checkedAt.get(row.id) ?? null,
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
      cadenceNote: row.cadenceNote,
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
        cadenceNote: snapshot.cadenceNote,
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

  return {
    subscriptions: subscriptionCount,
    snapshots: snapshotCount,
    customerLookups,
    summary,
    errors,
  };
}
