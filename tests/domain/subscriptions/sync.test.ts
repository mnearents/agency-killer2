import { describe, it, expect, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { syncSubscriptions } from "@/domain/subscriptions/sync";
import { createMockSealApiClient, makeSealSubscription } from "../../mocks/seal-api";
import type { SealSubscription } from "@/integrations/seal-api";

/** Minimal Drizzle stub that records what would be written. */
function createDbStub() {
  const inserted: { table: string; values: unknown }[] = [];
  const db = {
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
