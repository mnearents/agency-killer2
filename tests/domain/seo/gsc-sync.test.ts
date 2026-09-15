/**
 * The Search Console sync.
 *
 * The reason this issue is time-critical is the only thing that matters about
 * the design: the available window advances one day every day, and anything
 * that rolls off is gone at any price, by anyone, permanently. So the backfill
 * runs first and covers everything available, and the daily sync is the thing
 * that keeps it from happening again.
 *
 * Two shapes have to stay distinguishable, because the whole point of this
 * feed is noticing an absence:
 *
 * - **A day with no traffic** is a real answer.
 * - **A sync that read nothing** is a failure, and must never be reported in
 *   the language of the first.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  syncSearchConsole,
  plannedGscDays,
  GSC_DIMENSION_SETS,
  GSC_BACKFILL_DAYS,
  GSC_OVERLAP_DAYS,
  gscWindow,
} from "@/domain/seo/gsc-sync";
import type { SearchConsoleClient, GscRow } from "@/integrations/search-console";

const NOW = new Date("2026-09-15T12:00:00Z");

function client(overrides: Partial<SearchConsoleClient> = {}): SearchConsoleClient {
  return {
    listSites: vi.fn().mockResolvedValue([]),
    assertAccess: vi.fn().mockResolvedValue({ siteUrl: "sc-domain:x", permissionLevel: "siteRestrictedUser" }),
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

const row = (keys: string[], over: Partial<GscRow> = {}): GscRow => ({
  keys, clicks: 5, impressions: 100, ctr: 0.05, position: 3.2, ...over,
});

describe("gscWindow", () => {
  /**
   * Search Console lags two to three days. Asking for yesterday reliably
   * returns nothing, and a sync that treated that as the answer would write a
   * zero over a day that simply had not landed yet.
   */
  it("ends three days back, not yesterday", () => {
    expect(gscWindow(NOW, 30).endDate).toBe("2026-09-12");
  });

  it("covers the requested number of days", () => {
    const w = gscWindow(NOW, 7);
    expect(w.startDate).toBe("2026-09-06");
    expect(w.endDate).toBe("2026-09-12");
  });

  it("reaches back a full year for a backfill", () => {
    expect(gscWindow(NOW, 365).startDate).toBe("2025-09-13");
  });
});

describe("syncSearchConsole", () => {
  it("confirms access before reading anything", async () => {
    const assertAccess = vi.fn().mockResolvedValue({ siteUrl: "x", permissionLevel: "y" });
    const query = vi.fn().mockResolvedValue([]);
    await syncSearchConsole({ client: client({ assertAccess, query }), db: db(), now: NOW, days: 7 });
    expect(assertAccess).toHaveBeenCalled();
    expect(assertAccess.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[0]);
  });

  /**
   * The failure this whole issue is about. An ungranted credential returns a
   * 200 with nothing; `assertAccess` throws on it, and that has to surface as
   * a failed sync rather than a successful one that wrote no rows.
   */
  it("fails the sync when access cannot be confirmed, and writes nothing", async () => {
    const d = db();
    const result = await syncSearchConsole({
      client: client({ assertAccess: vi.fn().mockRejectedValue(new Error("access to no properties")) }),
      db: d,
      now: NOW,
      days: 7,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no properties/);
    expect(result.rows).toBe(0);
    expect((d as unknown as { _inserted: unknown[] })._inserted).toHaveLength(0);
  });

  it("reads every dimension it means to", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await syncSearchConsole({ client: client({ query }), db: db(), now: NOW, days: 7 });
    const asked = query.mock.calls.map(([q]) => q.dimensions.join("+"));
    expect(asked).toEqual(GSC_DIMENSION_SETS.map((s) => s.dimensions.join("+")));
  });

  it("writes rows keyed by date, dimension and value", async () => {
    const query = vi.fn().mockImplementation(({ dimensions }) =>
      dimensions.length === 1
        ? [row(["2026-09-01"], { clicks: 90 })]
        : [row(["2026-09-01", "rad and happy"], { clicks: 50 })]
    );
    const d = db();
    await syncSearchConsole({ client: client({ query }), db: d, now: NOW, days: 7 });

    const all = (d as unknown as { _inserted: Array<Array<Record<string, unknown>>> })._inserted.flat();
    expect(all).toContainEqual(expect.objectContaining({ date: "2026-09-01", dimension: "total", value: "", clicks: 90 }));
    expect(all).toContainEqual(
      expect.objectContaining({ date: "2026-09-01", dimension: "query", value: "rad and happy", clicks: 50 })
    );
  });

  it("reports how many rows each dimension contributed", async () => {
    const query = vi.fn().mockImplementation(({ dimensions }) =>
      dimensions.length === 1 ? [row(["2026-09-01"])] : [row(["2026-09-01", "a"]), row(["2026-09-01", "b"])]
    );
    const r = await syncSearchConsole({ client: client({ query }), db: db(), now: NOW, days: 7 });
    expect(r.ok).toBe(true);
    expect(r.byDimension.total).toBe(1);
    expect(r.byDimension.query).toBe(2);
    expect(r.rows).toBe(9);
  });

  /**
   * Zero is UNKNOWN until something proves it means zero. A property with
   * confirmed access that returns nothing at all over a year is not a quiet
   * site — it is a sync that read nothing, and it must say so.
   */
  it("flags a sync that confirmed access and still read nothing", async () => {
    const r = await syncSearchConsole({ client: client(), db: db(), now: NOW, days: 365 });
    expect(r.rows).toBe(0);
    expect(r.problem).toMatch(/no rows/i);
  });

  // A quiet recent window is ordinary; only a long one is suspicious.
  it("does not flag an empty short window", async () => {
    const r = await syncSearchConsole({ client: client(), db: db(), now: NOW, days: 3 });
    expect(r.problem).toBeNull();
  });

  it("surfaces a query failure as a failed sync rather than partial success", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([row(["2026-09-01"])])
      .mockRejectedValue(new Error("429 quota"));
    const r = await syncSearchConsole({ client: client({ query }), db: db(), now: NOW, days: 7 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/quota/);
  });

  it("skips a malformed row rather than writing a row with no date", async () => {
    const query = vi.fn().mockResolvedValue([{ keys: [], clicks: 1, impressions: 1, ctr: 1, position: 1 }]);
    const r = await syncSearchConsole({ client: client({ query }), db: db(), now: NOW, days: 7 });
    expect(r.rows).toBe(0);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it("names the window it covered, so a short sync is not mistaken for a full one", async () => {
    const r = await syncSearchConsole({ client: client(), db: db(), now: NOW, days: 30 });
    expect(r.window).toEqual({ startDate: "2026-08-14", endDate: "2026-09-12" });
  });
});

/**
 * How much to ask for on any given run.
 *
 * Getting this wrong is silent in both directions: too small and a gap is
 * never filled while every run reports success, too large and the backfill
 * re-runs daily. The window is derived from what is already stored rather
 * than from a fixed constant, so a worker that was down for a month
 * self-heals instead of leaving a hole nobody looks for.
 */
describe("plannedGscDays", () => {
  it("backfills the whole available window when nothing is stored", () => {
    expect(plannedGscDays(null, NOW)).toBe(GSC_BACKFILL_DAYS);
  });

  // Search Console revises recent days, so the last few are re-read every run.
  it("re-reads a short overlap when the data is current", () => {
    expect(plannedGscDays("2026-09-12", NOW)).toBe(GSC_OVERLAP_DAYS);
  });

  it("covers the whole gap when the sync has not run for a while", () => {
    // Latest stored 2026-08-13; the window ends 2026-09-12, so 30 days are
    // missing and the overlap is added on top.
    expect(plannedGscDays("2026-08-13", NOW)).toBeGreaterThanOrEqual(30);
  });

  it("never asks for more than the API can return", () => {
    expect(plannedGscDays("2020-01-01", NOW)).toBe(GSC_BACKFILL_DAYS);
  });

  // A stored date ahead of the window means something is wrong with the clock
  // or the data; asking for a negative range would throw at the API.
  it("still asks for the overlap when the stored date is somehow in the future", () => {
    expect(plannedGscDays("2027-01-01", NOW)).toBe(GSC_OVERLAP_DAYS);
  });
});

/**
 * The call site. A sync defined and never registered reports exactly like one
 * that ran and found nothing — which, for this feed, is the failure it exists
 * to detect.
 */
describe("worker wiring", () => {
  const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");
  const registry = readFileSync(join(process.cwd(), "src/worker/tasks/registry.ts"), "utf-8");

  it("registers a gsc-sync task", () => {
    expect(registry).toMatch(/id:\s*"gsc-sync"/);
    expect(registry).toMatch(/"gsc-sync":\s*"sync:gsc"/);
  });

  it("is enabled, since a disabled one loses a day of history per day", () => {
    // Non-greedy to the first brace would stop inside the schedule object, so
    // this anchors on the next task entry instead.
    const task = registry.match(/id:\s*"gsc-sync"[\s\S]*?enabled:\s*(true|false)/);
    expect(task, "no gsc-sync task found in the registry").not.toBeNull();
    expect(task![1]).toBe("true");
  });

  it("has a handler that actually calls the sync", () => {
    expect(worker).toMatch(/"sync:gsc":/);
    expect(worker).toMatch(/syncSearchConsole\s*\(/);
  });

  // The window is derived from what is stored; a hardcoded one would leave a
  // gap after any missed run and every later run would still report success.
  it("derives its window from what is already stored", () => {
    expect(worker).toMatch(/getLatestGscDate\s*\(\s*db\s*\)/);
    expect(worker).toMatch(/plannedGscDays\s*\(/);
  });

  /**
   * An unset credential must be loud. `[sync:meta] Skipped` logged calmly for
   * months on an unset env var is one of the nine instances this codebase has
   * produced, and this feed loses irreplaceable history while it waits.
   */
  it("reports a missing credential through console.error, not console.log", () => {
    const handler = worker.match(/"sync:gsc":[\s\S]{0,900}/);
    expect(handler).not.toBeNull();
    expect(handler![0]).toMatch(/NOT CONFIGURED/);
    expect(handler![0]).toMatch(/console\.error/);
    expect(handler![0]).not.toMatch(/console\.log\(`\[sync:gsc\] Skipped/);
  });

  it("surfaces the problem field rather than only the row count", () => {
    const handler = worker.match(/"sync:gsc":[\s\S]{0,1600}/);
    expect(handler![0]).toMatch(/result\.problem/);
  });
});
