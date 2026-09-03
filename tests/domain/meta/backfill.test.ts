import { describe, it, expect, vi } from "vitest";
import { monthChunks, backfillInsights } from "@/domain/meta/backfill";
import { MetaApiError } from "@/integrations/meta-api";
import { createMockMetaApiClient } from "../../mocks/meta-api";
import type { MetaApiInsight } from "@/integrations/meta-api";

const SYNCED_AT = new Date("2026-09-02T12:00:00Z");

function insight(adId: string, date: string): MetaApiInsight {
  return {
    ad_id: adId,
    adset_id: "adset_1",
    campaign_id: "camp_1",
    date_start: date,
    spend: "10.00",
    impressions: "100",
  };
}

/**
 * Fake DB that records inserted sync runs and lets a test pre-seed completed
 * windows, so resumability can be exercised without real SQL.
 */
function createMockDb(completedWindows: string[] = []) {
  const runs: Array<Record<string, unknown>> = [];
  const inserted: unknown[] = [];

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
    // Stands in for the "which months are already done?" lookup.
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(
          completedWindows.map((w) => ({ windowStart: new Date(w) }))
        ),
      }),
    }),
    _runs: runs,
    _inserted: inserted,
  };
  return db as never as Parameters<typeof backfillInsights>[0]["db"] & {
    _runs: Array<Record<string, unknown>>;
  };
}

describe("monthChunks", () => {
  it("splits the full campaign lifetime into one chunk per month", () => {
    // Nov 2024 through Mar 2026 is the real spend window on this account.
    const chunks = monthChunks("2024-11-01", "2026-03-31");
    expect(chunks).toHaveLength(17);
    expect(chunks[0]).toEqual({ start: "2024-11-01", end: "2024-11-30" });
    expect(chunks[16]).toEqual({ start: "2026-03-01", end: "2026-03-31" });
  });

  it("gets February right in a non-leap year", () => {
    expect(monthChunks("2025-02-01", "2025-02-28")).toEqual([
      { start: "2025-02-01", end: "2025-02-28" },
    ]);
  });

  it("gets February right in a leap year", () => {
    expect(monthChunks("2024-02-01", "2024-02-29")).toEqual([
      { start: "2024-02-01", end: "2024-02-29" },
    ]);
  });

  it("clamps the final chunk to the requested end date", () => {
    const chunks = monthChunks("2026-01-01", "2026-03-15");
    expect(chunks.at(-1)).toEqual({ start: "2026-03-01", end: "2026-03-15" });
  });

  it("clamps the first chunk to the requested start date", () => {
    expect(monthChunks("2025-06-14", "2025-06-30")[0]).toEqual({
      start: "2025-06-14",
      end: "2025-06-30",
    });
  });

  it("returns a single chunk when start and end share a month", () => {
    expect(monthChunks("2025-05-03", "2025-05-09")).toHaveLength(1);
  });
});

describe("backfillInsights", () => {
  it("walks every month and writes a sync run per chunk", async () => {
    const client = createMockMetaApiClient({
      getInsights: vi.fn().mockResolvedValue([insight("ad_1", "2025-01-05")]),
    });
    const db = createMockDb();

    const result = await backfillInsights({
      client, db, accountId: "act_1",
      startDate: "2025-01-01", endDate: "2025-03-31",
      now: () => SYNCED_AT, sleep: async () => {},
    });

    expect(client.getInsights).toHaveBeenCalledTimes(3);
    expect(result.chunksCompleted).toBe(3);
    expect(db._runs).toHaveLength(3);
    expect(db._runs.every((r) => r.task === "backfill:meta")).toBe(true);
  });

  it("skips months already recorded as complete, so a restart resumes", async () => {
    const client = createMockMetaApiClient({
      getInsights: vi.fn().mockResolvedValue([insight("ad_1", "2025-03-05")]),
    });
    // Jan and Feb already done on a previous, throttled run.
    const db = createMockDb(["2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z"]);

    const result = await backfillInsights({
      client, db, accountId: "act_1",
      startDate: "2025-01-01", endDate: "2025-03-31",
      now: () => SYNCED_AT, sleep: async () => {},
    });

    expect(client.getInsights).toHaveBeenCalledTimes(1);
    expect(client.getInsights).toHaveBeenCalledWith("act_1", "2025-03-01", "2025-03-31");
    expect(result.chunksSkipped).toBe(2);
  });

  it("skips a completed first chunk even when it was clamped mid-month", async () => {
    // The resume lookup and the recorded windowStart must agree. If the lookup
    // normalises to the 1st but the record stores the clamped date, a partial
    // first month is refetched forever and never recognised as done.
    const client = createMockMetaApiClient({
      getInsights: vi.fn().mockResolvedValue([insight("ad_1", "2025-06-20")]),
    });
    const db = createMockDb(["2025-06-14T00:00:00Z"]);

    const result = await backfillInsights({
      client, db, accountId: "act_1",
      startDate: "2025-06-14", endDate: "2025-06-30",
      now: () => SYNCED_AT, sleep: async () => {},
    });

    expect(result.chunksSkipped).toBe(1);
    expect(client.getInsights).not.toHaveBeenCalled();
  });

  it("retries with exponential backoff on a throttle, then succeeds", async () => {
    const getInsights = vi
      .fn()
      .mockRejectedValueOnce(new MetaApiError("throttled", 17))
      .mockRejectedValueOnce(new MetaApiError("throttled", 17))
      .mockResolvedValue([insight("ad_1", "2025-01-05")]);
    const client = createMockMetaApiClient({ getInsights });
    const db = createMockDb();
    const delays: number[] = [];

    const result = await backfillInsights({
      client, db, accountId: "act_1",
      startDate: "2025-01-01", endDate: "2025-01-31",
      now: () => SYNCED_AT,
      sleep: async (ms: number) => { delays.push(ms); },
    });

    expect(getInsights).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1000, 2000]); // doubling, deterministic
    expect(result.chunksCompleted).toBe(1);
    expect(db._runs.at(-1)?.outcome).toBe("ok");
  });

  it("stops immediately on auth failure rather than burning through months", async () => {
    // A dead token will fail identically for all 17 months. Continuing would
    // write 17 misleading failure rows and waste the rate-limit budget.
    const getInsights = vi
      .fn()
      .mockRejectedValue(new MetaApiError("Session expired", 190));
    const client = createMockMetaApiClient({ getInsights });
    const db = createMockDb();

    const result = await backfillInsights({
      client, db, accountId: "act_1",
      startDate: "2025-01-01", endDate: "2025-12-31",
      now: () => SYNCED_AT, sleep: async () => {},
    });

    expect(getInsights).toHaveBeenCalledTimes(1);
    expect(result.stoppedEarly).toBe(true);
    expect(result.outcome).toBe("auth-failed");
    expect(db._runs.at(-1)?.outcome).toBe("auth-failed");
  });

  it("gives up on a chunk after exhausting retries and records rate-limited", async () => {
    const getInsights = vi.fn().mockRejectedValue(new MetaApiError("throttled", 80000));
    const client = createMockMetaApiClient({ getInsights });
    const db = createMockDb();

    const result = await backfillInsights({
      client, db, accountId: "act_1",
      startDate: "2025-01-01", endDate: "2025-01-31",
      now: () => SYNCED_AT, sleep: async () => {}, maxRetries: 3,
    });

    expect(getInsights).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(result.chunksCompleted).toBe(0);
    expect(db._runs.at(-1)?.outcome).toBe("rate-limited");
    expect(result.stoppedEarly).toBe(true);
  });

  it("records no-data, not ok, for a month that returns nothing", async () => {
    const client = createMockMetaApiClient({
      getInsights: vi.fn().mockResolvedValue([]),
    });
    const db = createMockDb();

    await backfillInsights({
      client, db, accountId: "act_1",
      startDate: "2025-01-01", endDate: "2025-01-31",
      now: () => SYNCED_AT, sleep: async () => {},
    });

    expect(db._runs.at(-1)?.outcome).toBe("no-data");
    expect(db._runs.at(-1)?.rowsWritten).toBe(0);
  });

  it("stamps the attribution window onto the run for later labelling", async () => {
    const client = createMockMetaApiClient({
      getInsights: vi.fn().mockResolvedValue([insight("ad_1", "2025-01-05")]),
    });
    const db = createMockDb();

    const result = await backfillInsights({
      client, db, accountId: "act_1",
      startDate: "2025-01-01", endDate: "2025-01-31",
      now: () => SYNCED_AT, sleep: async () => {},
    });

    expect(result.attributionWindow).toBe("7d_click");
  });
});
