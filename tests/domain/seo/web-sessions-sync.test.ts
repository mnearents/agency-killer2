/**
 * The Shopify sessions sync.
 *
 * Shopify Analytics is the only source that can see the collapse #21 exists
 * about — 37 months against GA4's two — so this is #21's core rather than a
 * fallback.
 *
 * The hazard is specific to ShopifyQL: a rejected query returns HTTP 200 with
 * `parseErrors` and no rows. The client throws on that, and this sync has to
 * propagate the throw as a failed sync rather than absorbing it into a day
 * with no traffic. A traffic feed that cannot tell "nobody came" from "we did
 * not ask" is worse than not having one.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  syncWebSessions,
  monthChunks,
  WEB_SESSION_DIMENSIONS,
} from "@/domain/seo/web-sessions-sync";
import type { ShopifyAnalyticsClient } from "@/integrations/shopify-analytics";

const NOW = new Date("2026-09-15T12:00:00Z");

function client(overrides: Partial<ShopifyAnalyticsClient> = {}): ShopifyAnalyticsClient {
  return {
    assertReportsAccess: vi.fn().mockResolvedValue(["read_reports"]),
    query: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function db() {
  const inserted: unknown[][] = [];
  return {
    _inserted: inserted,
    insert: () => ({
      values: (rows: unknown[]) => ({
        onConflictDoUpdate: () => {
          inserted.push(rows);
          return Promise.resolve();
        },
      }),
    }),
  } as never;
}
const rowsOf = (d: unknown) => (d as unknown as { _inserted: Array<Array<Record<string, unknown>>> })._inserted.flat();

describe("monthChunks", () => {
  it("splits a range into whole months, oldest first", () => {
    const chunks = monthChunks("2026-07-14", "2026-09-15");
    expect(chunks[0]).toEqual({ startDate: "2026-07-14", endDate: "2026-07-31" });
    expect(chunks[1]).toEqual({ startDate: "2026-08-01", endDate: "2026-08-31" });
    expect(chunks.at(-1)).toEqual({ startDate: "2026-09-01", endDate: "2026-09-15" });
  });

  it("handles a range inside one month", () => {
    expect(monthChunks("2026-09-01", "2026-09-15")).toEqual([
      { startDate: "2026-09-01", endDate: "2026-09-15" },
    ]);
  });

  it("returns nothing for an inverted range rather than looping", () => {
    expect(monthChunks("2026-09-15", "2026-09-01")).toEqual([]);
  });

  /**
   * Chunked because `GROUP BY day, landing_page_path` over three years is a
   * single enormous response, and ShopifyQL has its own cost budget. Month at
   * a time keeps each response small and makes a partial failure recoverable.
   */
  it("covers three years without gaps or overlaps", () => {
    const chunks = monthChunks("2023-09-01", "2026-09-15");
    expect(chunks).toHaveLength(37);
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = Date.parse(`${chunks[i - 1].endDate}T00:00:00Z`);
      const thisStart = Date.parse(`${chunks[i].startDate}T00:00:00Z`);
      expect(thisStart - prevEnd).toBe(86_400_000);
    }
  });
});

describe("syncWebSessions", () => {
  it("confirms the read_reports scope before querying anything", async () => {
    const assertReportsAccess = vi.fn().mockResolvedValue(["read_reports"]);
    const query = vi.fn().mockResolvedValue([]);
    await syncWebSessions({ client: client({ assertReportsAccess, query }), db: db(), now: NOW, startDate: "2026-09-01" });
    expect(assertReportsAccess.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[0]);
  });

  it("fails the sync and writes nothing when the scope is missing", async () => {
    const d = db();
    const r = await syncWebSessions({
      client: client({ assertReportsAccess: vi.fn().mockRejectedValue(new Error('does not carry "read_reports"')) }),
      db: d, now: NOW, startDate: "2026-09-01",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/read_reports/);
    expect(rowsOf(d)).toHaveLength(0);
  });

  it("stores rows tagged with their source, never blended", async () => {
    const query = vi.fn().mockImplementation((q: string) =>
      q.includes("referrer_source")
        ? [{ day: "2026-09-01", referrer_source: "direct", sessions: 80 }]
        : [{ day: "2026-09-01", sessions: 128, conversion_rate: 0.02 }]
    );
    const d = db();
    await syncWebSessions({ client: client({ query }), db: d, now: NOW, startDate: "2026-09-01" });

    const all = rowsOf(d);
    expect(all.every((r) => r.source === "shopify")).toBe(true);
    expect(all).toContainEqual(expect.objectContaining({ dimension: "total", value: "", sessions: 128 }));
    expect(all).toContainEqual(
      expect.objectContaining({ dimension: "referrer_source", value: "direct", sessions: 80 })
    );
  });

  it("reads every dimension it means to", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await syncWebSessions({ client: client({ query }), db: db(), now: NOW, startDate: "2026-09-01" });
    for (const dim of WEB_SESSION_DIMENSIONS) {
      expect(query.mock.calls.some(([q]) => q.includes(dim.shopifyqlGroupBy))).toBe(true);
    }
  });

  /**
   * The failure mode this sync is built around. A rejected ShopifyQL query
   * throws in the client; absorbing it here would record a day with no
   * traffic, which is exactly what a traffic feed must never do silently.
   */
  it("fails the sync when a query is rejected, rather than recording no traffic", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ day: "2026-09-01", sessions: 10 }])
      .mockRejectedValue(new Error("ShopifyQL rejected the query: Column Not Found"));
    const r = await syncWebSessions({ client: client({ query }), db: db(), now: NOW, startDate: "2026-09-01" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Column Not Found/);
  });

  it("reports rows per dimension and the window it covered", async () => {
    const query = vi.fn().mockResolvedValue([{ day: "2026-09-01", sessions: 5 }]);
    const r = await syncWebSessions({ client: client({ query }), db: db(), now: NOW, startDate: "2026-09-01" });
    expect(r.ok).toBe(true);
    expect(r.window.startDate).toBe("2026-09-01");
    expect(r.byDimension.total).toBeGreaterThan(0);
  });

  // Zero is UNKNOWN until something proves it means zero.
  it("flags a long window that came back with nothing at all", async () => {
    const r = await syncWebSessions({ client: client(), db: db(), now: NOW, startDate: "2023-09-01" });
    expect(r.rows).toBe(0);
    expect(r.problem).toMatch(/no rows/i);
  });

  it("skips a row with no usable day rather than writing one", async () => {
    const query = vi.fn().mockResolvedValue([{ day: "", sessions: 5 }]);
    const r = await syncWebSessions({ client: client({ query }), db: db(), now: NOW, startDate: "2026-09-01" });
    expect(r.rows).toBe(0);
    expect(r.skipped).toBeGreaterThan(0);
  });

  // ShopifyQL returns the day as a timestamp; the table stores a calendar date.
  it("normalises a timestamped day to a calendar date", async () => {
    const query = vi.fn().mockResolvedValue([{ day: "2026-09-01T00:00:00Z", sessions: 5 }]);
    const d = db();
    await syncWebSessions({ client: client({ query }), db: d, now: NOW, startDate: "2026-09-01" });
    expect(rowsOf(d)[0]).toMatchObject({ date: "2026-09-01" });
  });
});

describe("worker wiring", () => {
  const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");
  const registry = readFileSync(join(process.cwd(), "src/worker/tasks/registry.ts"), "utf-8");

  it("registers a sessions sync task", () => {
    expect(registry).toMatch(/id:\s*"sessions-sync"/);
    expect(registry).toMatch(/"sessions-sync":\s*"sync:sessions"/);
  });

  it("is enabled", () => {
    const task = registry.match(/id:\s*"sessions-sync"[\s\S]*?enabled:\s*(true|false)/);
    expect(task).not.toBeNull();
    expect(task![1]).toBe("true");
  });

  it("has a handler that calls the sync", () => {
    expect(worker).toMatch(/"sync:sessions":/);
    expect(worker).toMatch(/syncWebSessions\s*\(/);
  });

  it("surfaces a failure through console.error", () => {
    const handler = worker.match(/"sync:sessions":[\s\S]{0,1400}/);
    expect(handler![0]).toMatch(/console\.error/);
    expect(handler![0]).toMatch(/result\.problem|result\.error/);
  });
});
