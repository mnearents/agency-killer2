/**
 * Historical re-crawl of Shopify orders and line items.
 *
 * `syncOrders` only ever looks back 30 days, so the four line-item fields added
 * for per-product net revenue (discount, requiresShipping, vendor, variant
 * title) are null on every row already in the table. Those columns are only
 * obtainable by asking Shopify for the orders again — there is no patch
 * endpoint and the stored raw_json predates the fields.
 *
 * Three constraints shape the design:
 *
 * 1. ~54k orders is far more than one request budget allows. Work is chunked by
 *    calendar month, and each month is a separate crawl.
 * 2. A throttle mid-run must not lose completed work, so every month writes a
 *    `sync_runs` row and a restart skips months already recorded as done. The
 *    Shopify client backs off and retries internally; by the time it throws,
 *    the right move is to stop and let a human re-run, not to hammer it.
 * 3. Zero orders in a month is an answer, not an absence — recorded as
 *    `no-data` so the next run does not re-crawl a month that had no sales.
 */

import type { ShopifyApiClient } from "@/integrations/shopify-api";
import type { Db } from "@/db/client";
import { and, eq, inArray } from "drizzle-orm";
import { shopifyOrders, shopifyLineItems, syncRuns } from "@/db/schema";
import { transformOrderWithLineItems } from "./sync-transform";
import type { SyncOutcome } from "@/domain/meta/outcomes";

export const BACKFILL_TASK = "backfill:shopify-orders";

export interface OrderWindow {
  since: string;
  /** Exclusive. Equal to the next window's `since`, so an order stamped
   *  exactly on a month boundary lands in exactly one window. */
  until: string;
}

/**
 * Split a half-open [startDate, endDate) range into calendar-month windows.
 *
 * Month boundaries rather than fixed 30-day spans keep windows aligned with the
 * `sync_runs` rows used for resumption, so a restart matches completed work by
 * `windowStart` alone.
 */
export function monthWindows(startDate: string, endDate: string): OrderWindow[] {
  const windows: OrderWindow[] = [];
  const end = new Date(`${endDate}T00:00:00Z`);
  let cursor = new Date(`${startDate}T00:00:00Z`);

  while (cursor < end) {
    const nextMonth = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)
    );
    const until = nextMonth > end ? end : nextMonth;
    windows.push({ since: isoDate(cursor), until: isoDate(until) });
    cursor = until;
  }

  return windows;
}

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Reduce a failed crawl to one outcome.
 *
 * The Shopify client throws plain `Error`s carrying the HTTP status or the
 * GraphQL error payload in the message, so the status is matched out of the
 * text. A throttle that survived the client's own retries is `rate-limited`
 * rather than `api-error`: the human needs to know to wait, not to debug.
 */
function classifyError(error: unknown): {
  outcome: SyncOutcome;
  errorMessage: string;
} {
  const message = error instanceof Error ? error.message : String(error);

  if (/\(429\)/.test(message) || /THROTTLED/.test(message)) {
    return { outcome: "rate-limited", errorMessage: message };
  }
  if (/\(401\)/.test(message) || /\(403\)/.test(message)) {
    return { outcome: "auth-failed", errorMessage: message };
  }
  return { outcome: "api-error", errorMessage: message };
}

/**
 * Which months are already done, by `windowStart`.
 *
 * Only `ok` and `no-data` count. A `rate-limited` or `api-error` month is
 * deliberately retried on the next run — treating a failed window as complete
 * is how a backfill ends up with a hole nothing goes back to fill.
 */
async function completedWindowStarts(db: Db): Promise<Set<number>> {
  const rows = await db
    .select({ windowStart: syncRuns.windowStart })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.task, BACKFILL_TASK),
        inArray(syncRuns.outcome, ["ok", "no-data"])
      )
    );
  return new Set(
    rows
      .map((r: { windowStart: Date | null }) => r.windowStart?.getTime())
      .filter((t): t is number => t !== undefined)
  );
}

export interface BackfillOrdersDeps {
  client: ShopifyApiClient;
  db: Db;
  startDate: string;
  /** Exclusive. */
  endDate: string;
  /** Injected for determinism in tests. */
  now?: () => Date;
}

export interface BackfillOrdersResult {
  windowsCompleted: number;
  windowsSkipped: number;
  orders: number;
  lineItems: number;
  /** True when the run aborted rather than attempting every remaining month. */
  stoppedEarly: boolean;
  outcome: SyncOutcome;
  windows: Array<{
    since: string;
    until: string;
    outcome: SyncOutcome;
    orders: number;
  }>;
}

export async function backfillOrders(
  deps: BackfillOrdersDeps
): Promise<BackfillOrdersResult> {
  const { client, db, startDate, endDate, now = () => new Date() } = deps;

  const windows = monthWindows(startDate, endDate);
  const alreadyDone = await completedWindowStarts(db);

  const result: BackfillOrdersResult = {
    windowsCompleted: 0,
    windowsSkipped: 0,
    orders: 0,
    lineItems: 0,
    stoppedEarly: false,
    outcome: "ok",
    windows: [],
  };

  for (const window of windows) {
    const windowStart = new Date(`${window.since}T00:00:00Z`);
    const windowEnd = new Date(`${window.until}T00:00:00Z`);

    if (alreadyDone.has(windowStart.getTime())) {
      result.windowsSkipped += 1;
      continue;
    }

    const startedAt = now();
    let orderCount = 0;
    let lineItemCount = 0;
    let failure: { outcome: SyncOutcome; errorMessage: string } | undefined;

    try {
      const raw = await client.getOrders({
        since: window.since,
        until: window.until,
      });
      const syncedAt = now();

      for (const rawOrder of raw) {
        const { order, lineItems } = transformOrderWithLineItems(rawOrder, syncedAt);

        await db
          .insert(shopifyOrders)
          .values(order)
          .onConflictDoUpdate({
            target: shopifyOrders.id,
            set: { ...order, updatedAt: syncedAt },
          });
        orderCount += 1;

        for (const item of lineItems) {
          // Upsert, not insert-if-absent: the point of the re-crawl is that
          // rows already present are missing the new columns.
          await db
            .insert(shopifyLineItems)
            .values(item)
            .onConflictDoUpdate({
              target: shopifyLineItems.id,
              set: { ...item },
            });
          lineItemCount += 1;
        }
      }
    } catch (err) {
      failure = classifyError(err);
    }

    const outcome: SyncOutcome = failure
      ? failure.outcome
      : orderCount > 0
        ? "ok"
        : "no-data";

    await db.insert(syncRuns).values({
      task: BACKFILL_TASK,
      outcome,
      windowStart,
      windowEnd,
      rowsWritten: orderCount + lineItemCount,
      errorMessage: failure?.errorMessage ?? null,
      startedAt,
      finishedAt: now(),
    });

    result.orders += orderCount;
    result.lineItems += lineItemCount;
    result.windows.push({
      since: window.since,
      until: window.until,
      outcome,
      orders: orderCount,
    });

    if (!failure) {
      result.windowsCompleted += 1;
      continue;
    }

    // A failure that will repeat for every remaining month — stop and surface
    // it rather than writing a wall of identical failure rows.
    result.stoppedEarly = true;
    result.outcome = failure.outcome;
    return result;
  }

  return result;
}
