import { describe, it, expect, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { syncSubscriptions } from "@/domain/subscriptions/sync";
import { createMockSealApiClient, makeSealSubscription } from "../../mocks/seal-api";
import type { SealSubscription } from "@/integrations/seal-api";

type Row = Record<string, unknown>;

/**
 * Minimal Drizzle stub that records what would be written.
 *
 * The sync batches its upserts, so `values` is an array. `statements` keeps
 * one entry per round trip — that is what the batching is measured against —
 * while `inserted` flattens back to one entry per row so assertions about what
 * a row contains stay about the row.
 *
 * `failOn` makes a write reject when the predicate matches a row, which is how
 * per-row isolation is tested: a batch containing a bad row must fail, and the
 * good rows around it must still land.
 */
function createDbStub(
  existing: { id: string; customerId: string | null }[] = [],
  failOn: (row: Row) => boolean = () => false
) {
  const statements: { table: string; rows: Row[] }[] = [];
  const inserted: { table: string; values: Row }[] = [];
  const db = {
    select() {
      return { from: () => Promise.resolve(existing) };
    },
    insert(table: Parameters<typeof getTableName>[0]) {
      const name = getTableName(table);
      return {
        values(values: Row | Row[]) {
          const rows = Array.isArray(values) ? values : [values];
          const write = () => {
            statements.push({ table: name, rows });
            const bad = rows.find(failOn);
            if (bad) return Promise.reject(new Error(`constraint violation on ${String(bad.id)}`));
            for (const r of rows) inserted.push({ table: name, values: r });
            return Promise.resolve();
          };
          return { onConflictDoUpdate: write, onConflictDoNothing: write };
        },
      };
    },
  };
  return { db: db as never, inserted, statements };
}

const NOW = new Date("2026-09-02T13:20:00Z");

describe("syncSubscriptions", () => {
  it("writes a current-state row and a snapshot row per subscription", async () => {
    const client = createMockSealApiClient({
      getAllSubscriptions: vi.fn().mockResolvedValue([makeSealSubscription()]),
    });
    const { db, inserted } = createDbStub();

    const result = await syncSubscriptions({ client, db }, NOW);

    expect(result.subscriptions).toBe(1);
    expect(result.snapshots).toBe(1);
    expect(result.errors).toEqual([]);
    expect(inserted.filter((i) => i.table === "seal_subscriptions")).toHaveLength(1);
    expect(inserted.filter((i) => i.table === "seal_subscription_snapshots")).toHaveLength(1);
  });

  it("reports the status breakdown the acceptance test checks", async () => {
    const subs: SealSubscription[] = [
      makeSealSubscription({ id: 1 }),
      makeSealSubscription({ id: 2 }),
      makeSealSubscription({ id: 3, status: "CANCELLED", cancelled_on: "2026-09-01T13:09:35+00:00" }),
    ];
    const client = createMockSealApiClient({
      getAllSubscriptions: vi.fn().mockResolvedValue(subs),
    });
    const { db } = createDbStub();

    const result = await syncSubscriptions({ client, db }, NOW);

    expect(result.summary.total).toBe(3);
    expect(result.summary.byStatus.ACTIVE).toBe(2);
    expect(result.summary.byStatus.CANCELLED).toBe(1);
  });

  it("counts dunning from attempt status, not error code", async () => {
    const subs: SealSubscription[] = [
      makeSealSubscription({
        id: 1,
        billing_attempts: [
          { id: 1, date: "2026-09-01T08:00:00+00:00", status: "error", order_id: "", error_code: "INSUFFICIENT_FUNDS", error_message: "x", triggered_manually: "", customer_authentication_challenge_url: "", completed_at: "" },
        ],
      }),
      // Succeeded on retry but kept the old code — must NOT count.
      makeSealSubscription({
        id: 2,
        billing_attempts: [
          { id: 2, date: "2026-08-01T08:00:00+00:00", status: "completed", order_id: "77", error_code: "EXPIRED_CARD", error_message: "x", triggered_manually: "", customer_authentication_challenge_url: "", completed_at: "2026-08-05T10:06:44+00:00" },
        ],
      }),
    ];
    const client = createMockSealApiClient({
      getAllSubscriptions: vi.fn().mockResolvedValue(subs),
    });
    const { db } = createDbStub();

    const result = await syncSubscriptions({ client, db }, NOW);
    expect(result.summary.inDunning).toBe(1);
  });

  // An unmapped variant is a product nobody has priced. Silence here would
  // mean a whole tier quietly missing from every revenue number.
  it("surfaces unmapped variants as warnings and counts them", async () => {
    const client = createMockSealApiClient({
      getAllSubscriptions: vi.fn().mockResolvedValue([
        makeSealSubscription({
          id: 9,
          items: [{ ...makeSealSubscription().items[0], variant_id: "11112222333344" }],
        }),
      ]),
    });
    const { db } = createDbStub();
    const warn = vi.fn();

    const result = await syncSubscriptions({ client, db }, NOW, { warn });

    expect(result.summary.unknownTier).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("11112222333344");
  });

  // A failed crawl that returns an empty array would otherwise look like
  // "every subscription was cancelled".
  it("returns the API error and writes nothing when the crawl fails", async () => {
    const client = createMockSealApiClient({
      getAllSubscriptions: vi.fn().mockRejectedValue(new Error("Seal API 503")),
    });
    const { db, inserted } = createDbStub();

    const result = await syncSubscriptions({ client, db }, NOW);

    expect(result.errors[0]).toContain("Seal API 503");
    expect(result.subscriptions).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("refuses to write an empty crawl rather than blanking the tables", async () => {
    const client = createMockSealApiClient({
      getAllSubscriptions: vi.fn().mockResolvedValue([]),
    });
    const { db, inserted } = createDbStub();

    const result = await syncSubscriptions({ client, db }, NOW);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/no subscriptions/i);
    expect(inserted).toHaveLength(0);
  });

  it("keys each snapshot to the sync date and subscription", async () => {
    const client = createMockSealApiClient({
      getAllSubscriptions: vi.fn().mockResolvedValue([makeSealSubscription({ id: 42 })]),
    });
    const { db, inserted } = createDbStub();

    await syncSubscriptions({ client, db }, NOW);

    const snap = inserted.find((i) => i.table === "seal_subscription_snapshots")
      ?.values as Record<string, unknown>;
    expect(snap.id).toBe("2026-09-02:42");
    expect(snap.snapshotDate).toBe("2026-09-02");
  });

  // The list endpoint has no customer_id, so each one costs a request. Doing
  // that for all 4,390 daily would be 4,390 requests against a 10-concurrent
  // limit; the backfill script does it once and the sync only covers new
  // arrivals.
  describe("customer id lookups", () => {
    it("looks up only subscriptions it has not stored a customer for", async () => {
      const getSubscriptionDetail = vi.fn().mockResolvedValue({ customerId: "555", log: null, tags: null });
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue([
          makeSealSubscription({ id: 1 }),
          makeSealSubscription({ id: 2 }),
        ]),
        getSubscriptionDetail,
      });
      const { db, inserted } = createDbStub([{ id: "1", customerId: "111" }]);

      await syncSubscriptions({ client, db }, NOW);

      expect(getSubscriptionDetail).toHaveBeenCalledTimes(1);
      expect(getSubscriptionDetail).toHaveBeenCalledWith("2");

      const rows = inserted.filter((i) => i.table === "seal_subscriptions");
      const byId = new Map(
        rows.map((r) => [(r.values as Record<string, unknown>).id, r.values as Record<string, unknown>])
      );
      expect(byId.get("1")!.customerId).toBe("111");
      expect(byId.get("2")!.customerId).toBe("555");
    });

    it("does not call the API at all when every customer is already stored", async () => {
      const getSubscriptionDetail = vi.fn();
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue([makeSealSubscription({ id: 1 })]),
        getSubscriptionDetail,
      });
      const { db } = createDbStub([{ id: "1", customerId: "111" }]);

      await syncSubscriptions({ client, db }, NOW);
      expect(getSubscriptionDetail).not.toHaveBeenCalled();
    });

    // Without a cap, a sync run before the backfill would quietly fire
    // thousands of requests and look like a hang.
    it("stops at the lookup cap and reports how many it skipped", async () => {
      const subs = Array.from({ length: 60 }, (_, i) => makeSealSubscription({ id: i + 1 }));
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue(subs),
        getSubscriptionDetail: vi.fn().mockResolvedValue({ customerId: "555", log: null, tags: null }),
      });
      const { db } = createDbStub();
      const warn = vi.fn();

      const result = await syncSubscriptions({ client, db }, NOW, { warn });

      expect(client.getSubscriptionDetail).toHaveBeenCalledTimes(50);
      const capWarning = warn.mock.calls
        .map((c) => c[0] as string)
        .find((m) => m.includes("10 "));
      expect(capWarning).toBeDefined();
      expect(capWarning).toMatch(/backfill/i);
      expect(result.customerLookups).toBe(50);
    });

    // One bad lookup must not cost the whole crawl.
    it("records the subscription even when its lookup fails", async () => {
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue([makeSealSubscription({ id: 1 })]),
        getSubscriptionDetail: vi.fn().mockRejectedValue(new Error("Seal API 503")),
      });
      const { db, inserted } = createDbStub();

      const result = await syncSubscriptions({ client, db }, NOW, { warn: vi.fn() });

      const row = inserted.find((i) => i.table === "seal_subscriptions")
        ?.values as Record<string, unknown>;
      expect(row.customerId).toBeNull();
      expect(row.customerIdCheckedAt).toBeNull();
      expect(result.subscriptions).toBe(1);
      expect(result.errors.some((e) => e.includes("503"))).toBe(true);
    });

    // A subscription with no customer and one never looked up must not be
    // confusable, or the backfill can never tell what is left to do.
    it("marks a lookup that found nothing as checked", async () => {
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue([makeSealSubscription({ id: 1 })]),
        getSubscriptionDetail: vi.fn().mockResolvedValue({ customerId: null, log: null, tags: null }),
      });
      const { db, inserted } = createDbStub();

      await syncSubscriptions({ client, db }, NOW);

      const row = inserted.find((i) => i.table === "seal_subscriptions")
        ?.values as Record<string, unknown>;
      expect(row.customerId).toBeNull();
      expect(row.customerIdCheckedAt).toEqual(NOW);
    });

    // The same response already carries these, so a new subscription should
    // never need a second crawl to get its log.
    it("stores the log and tags for a subscription it looks up", async () => {
      const log = [{ content: "Merchant added item", created: "2026-08-03 17:13:50" }];
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue([makeSealSubscription({ id: 1 })]),
        getSubscriptionDetail: vi
          .fn()
          .mockResolvedValue({ customerId: "555", log, tags: ["subscription"] }),
      });
      const { db, inserted } = createDbStub();

      await syncSubscriptions({ client, db }, NOW);

      const row = inserted.find((i) => i.table === "seal_subscriptions")
        ?.values as Record<string, unknown>;
      expect(row.log).toEqual(log);
      expect(row.tags).toEqual(["subscription"]);
      expect(row.detailCheckedAt).toEqual(NOW);
    });

    // THE regression that would quietly destroy the backfill: an already-known
    // subscription is never looked up, so the sync has no log in hand. Writing
    // the column anyway sets it to null, and a single nightly run erases the
    // entire captured upgrade history a day after it was gathered.
    it("does not touch log or tags for a subscription it did not look up", async () => {
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue([makeSealSubscription({ id: 1 })]),
      });
      const { db, inserted } = createDbStub([{ id: "1", customerId: "111" }]);

      await syncSubscriptions({ client, db }, NOW);

      const row = inserted.find((i) => i.table === "seal_subscriptions")
        ?.values as Record<string, unknown>;
      expect(client.getSubscriptionDetail).not.toHaveBeenCalled();
      expect("log" in row).toBe(false);
      expect("tags" in row).toBe(false);
      expect("detailCheckedAt" in row).toBe(false);
    });
  });

  // 4,395 subscriptions upserted one statement at a time, twice each, is 8,790
  // sequential round trips and about 749s of a daily cron spent waiting on
  // latency. The writes are independent, so they go in batches.
  describe("batching", () => {
    const manySubs = (n: number) =>
      Array.from({ length: n }, (_, i) => makeSealSubscription({ id: i + 1 }));

    it("writes a thousand subscriptions in a handful of round trips", async () => {
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue(manySubs(1000)),
      });
      const existing = Array.from({ length: 1000 }, (_, i) => ({
        id: String(i + 1),
        customerId: "c",
      }));
      const { db, statements } = createDbStub(existing);

      const result = await syncSubscriptions({ client, db }, NOW);

      expect(result.subscriptions).toBe(1000);
      expect(result.snapshots).toBe(1000);
      expect(result.errors).toEqual([]);
      // Two tables, 500 to a chunk. The point is that it is a small constant
      // number of trips rather than one per row.
      expect(statements.length).toBeLessThan(10);
    });

    it("writes every row when the crawl spans several chunks", async () => {
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue(manySubs(1200)),
      });
      const existing = Array.from({ length: 1200 }, (_, i) => ({
        id: String(i + 1),
        customerId: "c",
      }));
      const { db, inserted } = createDbStub(existing);

      await syncSubscriptions({ client, db }, NOW);

      const ids = inserted
        .filter((i) => i.table === "seal_subscriptions")
        .map((i) => i.values.id);
      expect(new Set(ids).size).toBe(1200);
    });

    // THE regression batching invites. Drizzle builds one column list for the
    // whole statement, so a chunk mixing a looked-up row (which has a log) with
    // stored rows (which do not) would emit `log` for all of them and write
    // NULL into every stored row — erasing the backfilled upgrade history in a
    // single nightly run. Rows are grouped by which columns they carry.
    it("does not blank a stored log when batched beside a freshly looked-up row", async () => {
      const log = [{ content: "Merchant added item", created: "2026-08-03 17:13:50" }];
      const client = createMockSealApiClient({
        getAllSubscriptions: vi
          .fn()
          .mockResolvedValue([makeSealSubscription({ id: 1 }), makeSealSubscription({ id: 2 })]),
        getSubscriptionDetail: vi.fn().mockResolvedValue({ customerId: "555", log, tags: ["x"] }),
      });
      // 1 is known, so it is never looked up and has no log in hand. 2 is new.
      const { db, statements } = createDbStub([{ id: "1", customerId: "111" }]);

      await syncSubscriptions({ client, db }, NOW);

      const subStatements = statements.filter((s) => s.table === "seal_subscriptions");
      for (const s of subStatements) {
        const carriesLog = s.rows.map((r) => "log" in r);
        expect(new Set(carriesLog).size).toBe(1);
      }
      const stored = subStatements.flatMap((s) => s.rows).find((r) => r.id === "1")!;
      expect("log" in stored).toBe(false);
      const fresh = subStatements.flatMap((s) => s.rows).find((r) => r.id === "2")!;
      expect(fresh.log).toEqual(log);
    });

    // A batch is all-or-nothing, so one bad row would otherwise cost every
    // good row beside it. The chunk is retried a row at a time to find it.
    it("keeps the good rows in a chunk when one row fails", async () => {
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue(manySubs(5)),
      });
      const existing = Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), customerId: "c" }));
      const { db, inserted } = createDbStub(existing, (r) => r.id === "3");

      const result = await syncSubscriptions({ client, db }, NOW);

      const ids = inserted
        .filter((i) => i.table === "seal_subscriptions")
        .map((i) => i.values.id);
      expect(ids.sort()).toEqual(["1", "2", "4", "5"]);
      expect(result.subscriptions).toBe(4);
    });

    it("names the subscription that failed", async () => {
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue(manySubs(3)),
      });
      const existing = Array.from({ length: 3 }, (_, i) => ({ id: String(i + 1), customerId: "c" }));
      const { db } = createDbStub(existing, (r) => r.id === "2");

      const result = await syncSubscriptions({ client, db }, NOW);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Subscription 2");
      expect(result.errors[0]).toContain("constraint violation");
    });

    // The snapshot is the day's record of a subscription's state. Writing one
    // for a row whose current state failed to save would put the two tables
    // into a disagreement nothing else would explain.
    it("writes no snapshot for a subscription whose row failed", async () => {
      const client = createMockSealApiClient({
        getAllSubscriptions: vi.fn().mockResolvedValue(manySubs(3)),
      });
      const existing = Array.from({ length: 3 }, (_, i) => ({ id: String(i + 1), customerId: "c" }));
      const { db, inserted } = createDbStub(existing, (r) => r.id === "2");

      const result = await syncSubscriptions({ client, db }, NOW);

      const snapIds = inserted
        .filter((i) => i.table === "seal_subscription_snapshots")
        .map((i) => i.values.subscriptionId);
      expect(snapIds.sort()).toEqual(["1", "3"]);
      expect(result.snapshots).toBe(2);
    });
  });

  it("stores booleans as the integer flags the schema uses", async () => {
    const client = createMockSealApiClient({
      getAllSubscriptions: vi.fn().mockResolvedValue([
        makeSealSubscription({ order_id: "_manual_ftg79" }),
      ]),
    });
    const { db, inserted } = createDbStub();

    await syncSubscriptions({ client, db }, NOW);

    const row = inserted.find((i) => i.table === "seal_subscriptions")
      ?.values as Record<string, unknown>;
    expect(row.manualOrigin).toBe(1);
    expect(row.inDunning).toBe(0);
    expect(row.shopifyOrderId).toBeNull();
  });
});
