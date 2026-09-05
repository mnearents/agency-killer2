import { describe, it, expect, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { syncSubscriptions } from "@/domain/subscriptions/sync";
import { createMockSealApiClient, makeSealSubscription } from "../../mocks/seal-api";
import type { SealSubscription } from "@/integrations/seal-api";

/** Minimal Drizzle stub that records what would be written. */
function createDbStub(existing: { id: string; customerId: string | null }[] = []) {
  const inserted: { table: string; values: unknown }[] = [];
  const db = {
    select() {
      return { from: () => Promise.resolve(existing) };
    },
    insert(table: Parameters<typeof getTableName>[0]) {
      const name = getTableName(table);
      return {
        values(values: unknown) {
          return {
            onConflictDoUpdate() {
              inserted.push({ table: name, values });
              return Promise.resolve();
            },
            onConflictDoNothing() {
              inserted.push({ table: name, values });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return { db: db as never, inserted };
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
