import { describe, it, expect, vi } from "vitest";
import { runQuery, describeViews, ROW_CAP } from "@/mcp/query";
import { createMockAnalyticsDb, makeRows } from "../mocks/analytics-db";
import type { QueryLogEntry } from "@/mcp/query";

const NOW = new Date("2026-09-06T10:00:00.000Z");

function harness(overrides?: Parameters<typeof createMockAnalyticsDb>[0]) {
  const logged: QueryLogEntry[] = [];
  const analytics = createMockAnalyticsDb(overrides);
  const log = vi.fn(async (entry: QueryLogEntry) => {
    logged.push(entry);
  });
  return { analytics, log, logged, deps: { analytics, log } };
}

describe("runQuery", () => {
  it("returns the rows and the columns they came back in", async () => {
    const { deps } = harness({
      select: vi.fn().mockResolvedValue({
        columns: ["tier", "n"],
        rows: [{ tier: "spark", n: "10" }],
        truncated: false,
      }),
    });

    const result = await runQuery(deps, "SELECT tier, count(*) n FROM subscriptions GROUP BY 1", NOW);

    expect(result).toEqual({
      ok: true,
      sql: "SELECT tier, count(*) n FROM subscriptions GROUP BY 1",
      columns: ["tier", "n"],
      rowsReturned: 1,
      truncated: false,
      rows: [{ tier: "spark", n: "10" }],
    });
  });

  it("passes the row cap down to the connection", async () => {
    const { deps, analytics } = harness();
    await runQuery(deps, "SELECT 1", NOW);
    expect(analytics.select).toHaveBeenCalledWith("SELECT 1", ROW_CAP);
  });

  // A silently truncated result is a wrong answer that looks like a right one:
  // "we have 5,000 subscribers" when the real number is 40,000.
  it("says so explicitly when the cap was hit", async () => {
    const { deps } = harness({
      select: vi.fn().mockResolvedValue({
        columns: ["id", "tier"],
        rows: makeRows(ROW_CAP),
        truncated: true,
      }),
    });

    const result = await runQuery(deps, "SELECT * FROM subscriptions", NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.rowsReturned).toBe(ROW_CAP);
    expect(result.note).toMatch(/first 5000/i);
    expect(result.note).toMatch(/more rows matched/i);
  });

  it("adds no note when nothing was truncated", async () => {
    const { deps } = harness();
    const result = await runQuery(deps, "SELECT 1", NOW);
    expect(result.ok && "note" in result).toBe(false);
  });

  describe("refuses anything that is not a single read", () => {
    it("returns the guard's reason instead of running it", async () => {
      const { deps, analytics } = harness();
      const result = await runQuery(deps, "DELETE FROM subscriptions", NOW);
      expect(result).toEqual({
        ok: false,
        error: 'A query must begin with SELECT or WITH. This one begins with "DELETE".',
      });
      expect(analytics.select).not.toHaveBeenCalled();
    });

    // The log is the record of what was attempted. A blocked statement is the
    // most interesting thing that can happen, so it is the last thing that
    // should go unrecorded.
    it("logs the rejection", async () => {
      const { deps, logged } = harness();
      await runQuery(deps, "DROP TABLE seal_subscriptions", NOW);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        sqlText: "DROP TABLE seal_subscriptions",
        rowCount: 0,
        ranAt: NOW,
      });
      expect(logged[0].errorMessage).toMatch(/must begin with SELECT or WITH/);
    });
  });

  describe("errors", () => {
    // Postgres reports the real problem — a typo'd column, a missing view.
    // Swallowing it into "query failed" would leave the caller guessing.
    it("returns the database's message rather than throwing", async () => {
      const { deps } = harness({
        select: vi.fn().mockRejectedValue(new Error('column "teir" does not exist')),
      });
      const result = await runQuery(deps, "SELECT teir FROM subscriptions", NOW);
      expect(result).toEqual({ ok: false, error: 'column "teir" does not exist' });
    });

    // Half a result set is worse than none: it reads as a complete answer.
    it("returns no rows alongside an error", async () => {
      const { deps } = harness({
        select: vi.fn().mockRejectedValue(new Error("canceling statement due to statement timeout")),
      });
      const result = await runQuery(deps, "SELECT 1", NOW);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("rows");
    });

    it("logs a failed query with its error", async () => {
      const { deps, logged } = harness({
        select: vi.fn().mockRejectedValue(new Error("boom")),
      });
      await runQuery(deps, "SELECT 1", NOW);
      expect(logged[0]).toMatchObject({ sqlText: "SELECT 1", rowCount: 0, errorMessage: "boom" });
    });

    // The log is an audit trail, not a dependency. If it breaks, the answer
    // the user asked for still has to arrive.
    it("still answers when writing the log fails", async () => {
      const { analytics } = harness();
      const log = vi.fn().mockRejectedValue(new Error("log table missing"));
      const result = await runQuery({ analytics, log }, "SELECT 1", NOW);
      expect(result.ok).toBe(true);
    });
  });

  describe("the query log", () => {
    it("records the statement, the row count and the timestamp", async () => {
      const { deps, logged } = harness({
        select: vi.fn().mockResolvedValue({ columns: ["n"], rows: makeRows(3), truncated: false }),
      });
      await runQuery(deps, "SELECT * FROM subscriptions", NOW);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        ranAt: NOW,
        sqlText: "SELECT * FROM subscriptions",
        rowCount: 3,
        truncated: 0,
        errorMessage: null,
      });
      expect(typeof logged[0].durationMs).toBe("number");
      expect(logged[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("records that a result was truncated", async () => {
      const { deps, logged } = harness({
        select: vi.fn().mockResolvedValue({ columns: [], rows: makeRows(ROW_CAP), truncated: true }),
      });
      await runQuery(deps, "SELECT 1", NOW);
      expect(logged[0].truncated).toBe(1);
    });

    it("gives every entry a distinct id", async () => {
      const { deps, logged } = harness();
      await runQuery(deps, "SELECT 1", NOW);
      await runQuery(deps, "SELECT 1", NOW);
      expect(logged[0].id).not.toBe(logged[1].id);
    });
  });
});

describe("describeViews", () => {
  it("returns each view with its columns and comment", async () => {
    const analytics = createMockAnalyticsDb({
      describe: vi.fn().mockResolvedValue([
        {
          view: "subscriptions",
          comment: "Excludes email.",
          columns: [{ name: "id", type: "text" }],
        },
      ]),
    });

    const result = await describeViews({ analytics, log: vi.fn() });

    expect(result).toEqual({
      ok: true,
      schema: "analytics",
      viewCount: 1,
      views: [
        { view: "subscriptions", comment: "Excludes email.", columns: [{ name: "id", type: "text" }] },
      ],
    });
  });

  // An empty catalog means the migration never ran. Reporting it as "here are
  // your zero views" would send the caller off writing SQL against nothing.
  it("treats an empty catalog as an error, not an empty answer", async () => {
    const analytics = createMockAnalyticsDb({ describe: vi.fn().mockResolvedValue([]) });
    const result = await describeViews({ analytics, log: vi.fn() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no views/i);
  });

  it("returns a catalog failure rather than throwing", async () => {
    const analytics = createMockAnalyticsDb({
      describe: vi.fn().mockRejectedValue(new Error("permission denied for schema analytics")),
    });
    const result = await describeViews({ analytics, log: vi.fn() });
    expect(result).toEqual({ ok: false, error: "permission denied for schema analytics" });
  });
});
