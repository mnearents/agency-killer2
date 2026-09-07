import { describe, it, expect, vi } from "vitest";
import {
  monthWindows,
  backfillOrders,
  BACKFILL_TASK,
} from "@/domain/shopify/backfill";
import type { ShopifyApiOrder, ShopifyApiLineItem } from "@/integrations/shopify-api";

function lineItem(id: string): ShopifyApiLineItem {
  return {
    id,
    title: "Daily Planner",
    quantity: 1,
    originalUnitPriceSet: { shopMoney: { amount: "14.99" } },
    totalDiscountSet: { shopMoney: { amount: "3.00" } },
    requiresShipping: true,
    vendor: "Rad & Happy",
    product: { id: "gid://shopify/Product/1", productType: "Planner" },
    variant: { id: "gid://shopify/ProductVariant/1", sku: "PLN-1", title: "Large" },
  };
}

function order(id: string, lines = 1): ShopifyApiOrder {
  return {
    id,
    name: `#${id}`,
    createdAt: "2025-08-10T00:00:00Z",
    currencyCode: "USD",
    totalPriceSet: { shopMoney: { amount: "29.99" } },
    subtotalPriceSet: { shopMoney: { amount: "24.99" } },
    totalTaxSet: { shopMoney: { amount: "2.50" } },
    totalDiscountsSet: { shopMoney: { amount: "5.00" } },
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    customer: { id: "gid://shopify/Customer/1" },
    tags: [],
    discountCodes: [],
    sourceIdentifier: "web",
    lineItems: {
      nodes: Array.from({ length: lines }, (_, i) => lineItem(`${id}-l${i}`)),
    },
  };
}

/**
 * Fake DB that records sync runs and lets a test pre-seed completed windows,
 * so resumability is exercised without real SQL.
 */
function createMockDb(completedWindows: string[] = []) {
  const runs: Array<Record<string, unknown>> = [];
  const inserted: Array<Record<string, unknown>> = [];

  const db = {
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        if (v && typeof v.outcome === "string") runs.push(v);
        else inserted.push(v);
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        };
      }),
    })),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue(
            completedWindows.map((w) => ({ windowStart: new Date(w) }))
          ),
      }),
    }),
    _runs: runs,
    _inserted: inserted,
  };
  return db as never as Parameters<typeof backfillOrders>[0]["db"] & {
    _runs: Array<Record<string, unknown>>;
    _inserted: Array<Record<string, unknown>>;
  };
}

function mockClient(getOrders: unknown) {
  return {
    getOrders,
    getCustomersWithEnrollments: vi.fn().mockResolvedValue([]),
    getInventory: vi.fn().mockResolvedValue([]),
  } as never as Parameters<typeof backfillOrders>[0]["client"];
}

const NOW = () => new Date("2026-09-06T12:00:00Z");

// ─── Windowing ────────────────────────────────────────────────────────

describe("monthWindows", () => {
  // The upper bound is exclusive because that is what getOrders sends. Two
  // consecutive windows must abut exactly: an order stamped midnight on the
  // 1st belongs to exactly one of them.
  it("makes each window's until the next window's since", () => {
    const w = monthWindows("2025-07-01", "2025-10-01");
    expect(w).toEqual([
      { since: "2025-07-01", until: "2025-08-01" },
      { since: "2025-08-01", until: "2025-09-01" },
      { since: "2025-09-01", until: "2025-10-01" },
    ]);
  });

  it("clamps the first window to the requested start mid-month", () => {
    // 2025-07-22 is the earliest order currently in the table.
    const w = monthWindows("2025-07-22", "2025-09-01");
    expect(w[0]).toEqual({ since: "2025-07-22", until: "2025-08-01" });
  });

  it("clamps the last window to the requested end mid-month", () => {
    const w = monthWindows("2025-07-01", "2025-08-15");
    expect(w[w.length - 1]).toEqual({ since: "2025-08-01", until: "2025-08-15" });
  });

  it("returns a single window when start and end share a month", () => {
    expect(monthWindows("2025-07-10", "2025-07-20")).toEqual([
      { since: "2025-07-10", until: "2025-07-20" },
    ]);
  });

  it("returns nothing when the range is empty", () => {
    expect(monthWindows("2025-07-01", "2025-07-01")).toEqual([]);
  });

  it("crosses a year boundary", () => {
    const w = monthWindows("2025-12-01", "2026-02-01");
    expect(w).toEqual([
      { since: "2025-12-01", until: "2026-01-01" },
      { since: "2026-01-01", until: "2026-02-01" },
    ]);
  });
});

// ─── Crawl ────────────────────────────────────────────────────────────

describe("backfillOrders", () => {
  it("fetches one bounded window per month", async () => {
    const getOrders = vi.fn().mockResolvedValue([]);
    const result = await backfillOrders({
      client: mockClient(getOrders),
      db: createMockDb(),
      startDate: "2025-07-01",
      endDate: "2025-09-01",
      now: NOW,
    });

    expect(getOrders.mock.calls.map((c) => c[0])).toEqual([
      { since: "2025-07-01", until: "2025-08-01" },
      { since: "2025-08-01", until: "2025-09-01" },
    ]);
    expect(result.windowsCompleted).toBe(2);
  });

  it("upserts every order and every line item", async () => {
    const db = createMockDb();
    const getOrders = vi.fn().mockResolvedValue([order("o1", 2), order("o2", 1)]);

    const result = await backfillOrders({
      client: mockClient(getOrders),
      db,
      startDate: "2025-07-01",
      endDate: "2025-08-01",
      now: NOW,
    });

    expect(result.orders).toBe(2);
    expect(result.lineItems).toBe(3);
  });

  // The whole point of the re-crawl: existing rows must gain the new columns,
  // not be skipped as already-present.
  it("writes the new line item columns", async () => {
    const db = createMockDb();
    await backfillOrders({
      client: mockClient(vi.fn().mockResolvedValue([order("o1", 1)])),
      db,
      startDate: "2025-07-01",
      endDate: "2025-08-01",
      now: NOW,
    });

    const line = db._inserted.find((r) => r.totalDiscountCents !== undefined);
    expect(line).toBeDefined();
    expect(line!.totalDiscountCents).toBe(300);
    expect(line!.requiresShipping).toBe(1);
    expect(line!.vendor).toBe("Rad & Happy");
    expect(line!.variantTitle).toBe("Large");
  });

  it("records a sync run per window with the crawled bounds", async () => {
    const db = createMockDb();
    await backfillOrders({
      client: mockClient(vi.fn().mockResolvedValue([order("o1")])),
      db,
      startDate: "2025-07-01",
      endDate: "2025-08-01",
      now: NOW,
    });

    expect(db._runs).toHaveLength(1);
    expect(db._runs[0].task).toBe(BACKFILL_TASK);
    expect(db._runs[0].outcome).toBe("ok");
    expect(db._runs[0].windowStart).toEqual(new Date("2025-07-01T00:00:00Z"));
    expect(db._runs[0].windowEnd).toEqual(new Date("2025-08-01T00:00:00Z"));
  });

  // Zero orders in a month is an answer. Recording it as no-data stops the
  // next run re-crawling a month that genuinely had no sales.
  it("records an empty month as no-data, not as a failure", async () => {
    const db = createMockDb();
    const result = await backfillOrders({
      client: mockClient(vi.fn().mockResolvedValue([])),
      db,
      startDate: "2025-07-01",
      endDate: "2025-08-01",
      now: NOW,
    });

    expect(db._runs[0].outcome).toBe("no-data");
    expect(result.stoppedEarly).toBe(false);
  });

  it("skips months already recorded as done and refetches nothing for them", async () => {
    const getOrders = vi.fn().mockResolvedValue([]);
    const result = await backfillOrders({
      client: mockClient(getOrders),
      db: createMockDb(["2025-07-01T00:00:00Z"]),
      startDate: "2025-07-01",
      endDate: "2025-09-01",
      now: NOW,
    });

    expect(getOrders).toHaveBeenCalledTimes(1);
    expect(getOrders.mock.calls[0][0].since).toBe("2025-08-01");
    expect(result.windowsSkipped).toBe(1);
  });
});

// ─── Failure ──────────────────────────────────────────────────────────

describe("backfillOrders: failure", () => {
  it("stops at the first failing window rather than writing a wall of failures", async () => {
    const db = createMockDb();
    const getOrders = vi.fn().mockRejectedValue(new Error("Shopify API error (500): boom"));

    const result = await backfillOrders({
      client: mockClient(getOrders),
      db,
      startDate: "2025-07-01",
      endDate: "2025-10-01",
      now: NOW,
    });

    expect(getOrders).toHaveBeenCalledTimes(1);
    expect(result.stoppedEarly).toBe(true);
    expect(result.outcome).toBe("api-error");
    expect(db._runs).toHaveLength(1);
  });

  // Recorded as rate-limited, not api-error: the client already exhausted its
  // own retries, so the human needs to know to wait rather than to debug.
  it("classifies an exhausted throttle as rate-limited", async () => {
    const db = createMockDb();
    await backfillOrders({
      client: mockClient(
        vi.fn().mockRejectedValue(new Error("Shopify API error (429): Too Many Requests"))
      ),
      db,
      startDate: "2025-07-01",
      endDate: "2025-08-01",
      now: NOW,
    });

    expect(db._runs[0].outcome).toBe("rate-limited");
  });

  it("classifies a GraphQL THROTTLED error as rate-limited", async () => {
    const db = createMockDb();
    await backfillOrders({
      client: mockClient(
        vi
          .fn()
          .mockRejectedValue(
            new Error('Shopify GraphQL error: [{"extensions":{"code":"THROTTLED"}}]')
          )
      ),
      db,
      startDate: "2025-07-01",
      endDate: "2025-08-01",
      now: NOW,
    });

    expect(db._runs[0].outcome).toBe("rate-limited");
  });

  it("classifies a rejected token as auth-failed", async () => {
    const db = createMockDb();
    await backfillOrders({
      client: mockClient(
        vi.fn().mockRejectedValue(new Error("Shopify API error (401): Unauthorized"))
      ),
      db,
      startDate: "2025-07-01",
      endDate: "2025-08-01",
      now: NOW,
    });

    expect(db._runs[0].outcome).toBe("auth-failed");
  });

  // A window that failed must NOT be treated as done, or the backfill ends up
  // with a silent hole that nothing will ever go back and fill.
  it("does not mark a failed window as complete", async () => {
    const db = createMockDb();
    const result = await backfillOrders({
      client: mockClient(vi.fn().mockRejectedValue(new Error("boom"))),
      db,
      startDate: "2025-07-01",
      endDate: "2025-08-01",
      now: NOW,
    });

    expect(result.windowsCompleted).toBe(0);
    expect(["ok", "no-data"]).not.toContain(db._runs[0].outcome);
  });

  // Partial progress within a window is real work, but the window is still a
  // failure — reporting it as ok would let the resume logic skip it.
  it("counts rows written before a mid-window failure without calling it ok", async () => {
    const db = createMockDb();
    let call = 0;
    const getOrders = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve([order("o1")]);
      return Promise.reject(new Error("Shopify API error (500): boom"));
    });

    const result = await backfillOrders({
      client: mockClient(getOrders),
      db,
      startDate: "2025-07-01",
      endDate: "2025-09-01",
      now: NOW,
    });

    expect(result.orders).toBe(1);
    expect(db._runs[0].outcome).toBe("ok");
    expect(db._runs[1].outcome).toBe("api-error");
    expect(result.stoppedEarly).toBe(true);
  });
});
