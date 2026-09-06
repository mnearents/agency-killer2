/**
 * Reads over the Seal subscription tables.
 *
 * Kept deliberately thin: these pull rows and hand them to the pure functions
 * in ./analytics, so every number the MCP tools report is computed in code that
 * runs without a database and is covered by fast tests.
 */

import { and, gte, isNotNull, lte } from "drizzle-orm";
import type { Db } from "@/db/client";
import { sealSubscriptions, sealSubscriptionSnapshots } from "@/db/schema";
import type { SubscriptionFact, SnapshotFact, TierChangeFact } from "./analytics";
import { toTierChangeFacts } from "./tier-changes";

export async function getSubscriptionFacts(db: Db): Promise<SubscriptionFact[]> {
  const rows = await db
    .select({
      id: sealSubscriptions.id,
      status: sealSubscriptions.status,
      tier: sealSubscriptions.tier,
      pricingCohort: sealSubscriptions.pricingCohort,
      billingInterval: sealSubscriptions.billingInterval,
      billingCadence: sealSubscriptions.billingCadence,
      priceCents: sealSubscriptions.priceCents,
      priceAnomaly: sealSubscriptions.priceAnomaly,
      inDunning: sealSubscriptions.inDunning,
      manualOrigin: sealSubscriptions.manualOrigin,
      orderPlaced: sealSubscriptions.orderPlaced,
      cancelledOn: sealSubscriptions.cancelledOn,
    })
    .from(sealSubscriptions);

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    tier: r.tier,
    pricingCohort: r.pricingCohort,
    billingInterval: r.billingInterval,
    billingCadence: r.billingCadence,
    priceCents: r.priceCents === null ? null : Number(r.priceCents),
    priceAnomaly: r.priceAnomaly === 1,
    inDunning: r.inDunning === 1,
    manualOrigin: r.manualOrigin === 1,
    orderPlaced: r.orderPlaced,
    cancelledOn: r.cancelledOn,
  }));
}

/** Snapshot rows for a date window, used to detect tier movement. */
export async function getSnapshotFacts(
  db: Db,
  startDate: string,
  endDate: string
): Promise<SnapshotFact[]> {
  return db
    .select({
      snapshotDate: sealSubscriptionSnapshots.snapshotDate,
      subscriptionId: sealSubscriptionSnapshots.subscriptionId,
      tier: sealSubscriptionSnapshots.tier,
      pricingCohort: sealSubscriptionSnapshots.pricingCohort,
      status: sealSubscriptionSnapshots.status,
    })
    .from(sealSubscriptionSnapshots)
    .where(
      and(
        gte(sealSubscriptionSnapshots.snapshotDate, startDate),
        lte(sealSubscriptionSnapshots.snapshotDate, endDate)
      )
    );
}

/**
 * Every tier change Seal's log records, across all subscriptions.
 *
 * Not date-filtered in SQL: a subscription's log has to be folded whole to know
 * what tier it was on when a window opened, so the window is applied after
 * parsing. 4,395 rows, so the whole-table read is cheap.
 */
export async function getTierChangeFacts(db: Db): Promise<TierChangeFact[]> {
  const rows = await db
    .select({
      id: sealSubscriptions.id,
      pricingCohort: sealSubscriptions.pricingCohort,
      log: sealSubscriptions.log,
    })
    .from(sealSubscriptions)
    .where(isNotNull(sealSubscriptions.log));

  return toTierChangeFacts(rows);
}
