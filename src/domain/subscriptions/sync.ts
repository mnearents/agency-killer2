/**
 * Seal subscription sync — full crawl, then upsert current state + a daily
 * snapshot.
 *
 * Seal offers no incremental read: there is no `since` parameter, and unknown
 * query params are silently ignored rather than rejected, so a filter that
 * looks like it worked may have done nothing. The only honest option is to
 * pull all ~88 pages every time.
 */

import { getTableColumns, isNotNull, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { SealApiClient } from "@/integrations/seal-api";
import type { Db } from "@/db/client";
import { sealSubscriptions, sealSubscriptionSnapshots, sealTierChangeEvents } from "@/db/schema";
import { buildTierChangeEvents } from "./tier-changes";

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
  /** Tier-change rows rebuilt from the stored logs after the write. */
  tierChangeEvents: number;
  summary: TransformSummary;
  errors: string[];
}

const flag = (b: boolean) => (b ? 1 : 0);

/**
 * Rows per upsert statement. The whole crawl in one statement would be a single
 * point of failure and a very large query; one row per statement was 8,790
 * round trips a night. 500 keeps both the parameter count and the cost of
 * re-running a failed chunk row-by-row small.
 */
const UPSERT_CHUNK_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Row = Record<string, unknown>;

/**
 * `set` clause assigning each column the value the INSERT proposed for it.
 *
 * A batched upsert has one `set` for every row in it, so the per-row object the
 * single-row version used cannot be reused — `excluded` is how Postgres refers
 * to the row that would have been inserted.
 */
function excludedSet(table: PgTable, keys: string[], extra: Row = {}): Row {
  const columns = getTableColumns(table) as unknown as Record<string, { name: string }>;
  const set: Row = {};
  for (const key of keys) set[key] = sql.raw(`excluded."${columns[key].name}"`);
  return { ...set, ...extra };
}

/**
 * Upsert rows in batches, falling back to one statement per row for any batch
 * that fails so a single bad row costs only itself.
 *
 * Every row in `rows` must carry the same keys: Drizzle builds one column list
 * for the whole statement from the union of the rows, and emits `default` —
 * which for these nullable columns means NULL — wherever a row lacks a key. A
 * batch mixing a row that has `log` with rows that do not would therefore write
 * NULL over every stored log. Callers group before calling.
 */
async function upsertBatched(
  db: Db,
  table: PgTable,
  conflictTarget: unknown,
  rows: Row[],
  extraSet: Row,
  onError: (row: Row, err: unknown) => void
): Promise<Row[]> {
  const written: Row[] = [];
  if (rows.length === 0) return written;
  const keys = Object.keys(rows[0]);
  const set = excludedSet(table, keys, extraSet);

  for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
    const run = (values: Row[]) =>
      db
        .insert(table)
        .values(values as never)
        .onConflictDoUpdate({ target: conflictTarget as never, set: set as never });
    try {
      await run(batch);
      written.push(...batch);
    } catch {
      // The batch says only that something in it failed, not what. Retrying a
      // row at a time is what turns that into a named subscription.
      for (const row of batch) {
        try {
          await run([row]);
          written.push(row);
        } catch (err) {
          onError(row, err);
        }
      }
    }
  }
  return written;
}

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
    return { subscriptions: 0, snapshots: 0, customerLookups: 0, tierChangeEvents: 0, summary: EMPTY_SUMMARY, errors };
  }

  // A crawl that returns nothing is far more likely to be a broken token or a
  // changed envelope than a store with zero subscribers. Writing it would
  // blank the current-state table and record a snapshot day showing total
  // collapse — a fabricated churn event that looks exactly like a real one.
  if (raw.length === 0) {
    errors.push("Seal crawl returned no subscriptions — refusing to write. Treating as a failed sync.");
    return { subscriptions: 0, snapshots: 0, customerLookups: 0, tierChangeEvents: 0, summary: EMPTY_SUMMARY, errors };
  }

  const transformed = raw.map((s) => transformSubscription(s, now));
  const summary = summariseTransform(transformed);

  // Reuse every customer ID already stored; only genuinely new subscriptions
  // cost a request.
  const knownCustomerIds = new Map<string, string | null>();
  const checkedAt = new Map<string, Date | null>();
  // Only populated for subscriptions looked up this run. Existing rows keep the
  // log the backfill captured — the upsert below must not overwrite it with null.
  const freshDetail = new Map<string, { log: unknown; tags: unknown }>();
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
      const detail = await client.getSubscriptionDetail(id);
      // Record the check even when there is no customer, so "no customer" is
      // never mistaken for "not looked up yet".
      knownCustomerIds.set(id, detail.customerId);
      checkedAt.set(id, now);
      // The same response already carries the log and tags, so capturing them
      // here is free and keeps new subscriptions from needing a second crawl.
      freshDetail.set(id, { log: detail.log, tags: detail.tags });
      customerLookups++;
    } catch (err) {
      errors.push(
        `Customer id lookup for ${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  for (const warning of summary.warnings) logger.warn(warning);

  // Grouped by whether the row carries log/tags, because a batch has one column
  // list for all its rows: mixing them would write NULL over every stored log.
  const withDetail: Row[] = [];
  const withoutDetail: Row[] = [];
  const snapshotById = new Map<string, Row>();

  for (const { row, snapshot } of transformed) {
    // Only subscriptions looked up this run have a log to write. Including the
    // column unconditionally would set it to null for every existing row on
    // every nightly sync, erasing the backfilled history a day after capture.
    const detail = freshDetail.get(row.id);
    const detailValues = detail
      ? { log: detail.log, tags: detail.tags, detailCheckedAt: now }
      : {};

    const values = {
      ...detailValues,
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

    (detail ? withDetail : withoutDetail).push(values);

    snapshotById.set(row.id, {
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
    });
  }

  const noteError = (row: Row, err: unknown) => {
    errors.push(`Subscription ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const writtenSubscriptions: Row[] = [];
  for (const group of [withoutDetail, withDetail]) {
    writtenSubscriptions.push(
      ...(await upsertBatched(db, sealSubscriptions, sealSubscriptions.id, group, { updatedAt: now }, noteError))
    );
  }
  subscriptionCount = writtenSubscriptions.length;

  // Only for subscriptions whose current state actually saved. A snapshot for a
  // row that failed would leave the two tables disagreeing about the same day.
  const snapshotRows = writtenSubscriptions.map((r) => snapshotById.get(String(r.id))!);
  // Re-running a sync on the same day corrects that day's snapshot rather than
  // duplicating it.
  snapshotCount = (
    await upsertBatched(
      db,
      sealSubscriptionSnapshots,
      sealSubscriptionSnapshots.id,
      snapshotRows,
      {},
      (row, err) =>
        errors.push(
          `Subscription ${row.subscriptionId}: snapshot: ${err instanceof Error ? err.message : String(err)}`
        )
    )
  ).length;

  const tierChangeEvents = await rebuildTierChangeEvents(db, now, errors);

  return {
    subscriptions: subscriptionCount,
    snapshots: snapshotCount,
    customerLookups,
    tierChangeEvents,
    summary,
    errors,
  };
}

/**
 * Refold every stored log into `seal_tier_change_events`.
 *
 * Runs after the write so it sees the logs this sync just captured, and reads
 * the table rather than working from memory because most logs belong to
 * subscriptions this run never fetched detail for.
 *
 * The whole set is rebuilt each night rather than only the changed rows. Event
 * IDs are `subscriptionId:timestamp`, so a rebuild upserts over itself; a
 * partial rebuild would leave the table agreeing with no particular day. The
 * cost is one scan and ~80 upserted rows.
 *
 * A failure here is reported but does not fail the sync: this table feeds the
 * analytics views, while the current-state and snapshot rows written above feed
 * every number Tara sees.
 */
async function rebuildTierChangeEvents(db: Db, now: Date, errors: string[]): Promise<number> {
  try {
    const rows = await db
      .select({
        id: sealSubscriptions.id,
        pricingCohort: sealSubscriptions.pricingCohort,
        log: sealSubscriptions.log,
      })
      .from(sealSubscriptions)
      .where(isNotNull(sealSubscriptions.log));

    const events = buildTierChangeEvents(rows, now);
    const written = await upsertBatched(
      db,
      sealTierChangeEvents,
      sealTierChangeEvents.id,
      events as unknown as Row[],
      {},
      (row, err) =>
        errors.push(
          `Tier change ${row.id}: ${err instanceof Error ? err.message : String(err)}`
        )
    );
    return written.length;
  } catch (err) {
    errors.push(
      `Rebuilding tier change events: ${err instanceof Error ? err.message : String(err)}`
    );
    return 0;
  }
}
