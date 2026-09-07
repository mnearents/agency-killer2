/**
 * The `query` tool's logic: guard, run, cap, log.
 *
 * Split from the tool definition so it can be tested against a mocked
 * connection — the interesting behaviour here is what happens at the edges
 * (a blocked statement, a hit cap, a failed log write) and none of it needs a
 * database to exercise.
 */

import { randomUUID } from "node:crypto";
import { guardReadOnlySql } from "./sql-guard";
import type { AnalyticsDb } from "./analytics-db";

/**
 * Rows handed back at most. A model reading 200,000 rows learns nothing it
 * could not learn from an aggregate, and would blow its context doing it.
 */
export const ROW_CAP = 5000;

export interface QueryLogEntry {
  id: string;
  ranAt: Date;
  sqlText: string;
  rowCount: number;
  truncated: number;
  durationMs: number;
  errorMessage: string | null;
}

export interface QueryDeps {
  analytics: AnalyticsDb;
  /** Writes to `query_log` on the owner connection — the role has no INSERT. */
  log: (entry: QueryLogEntry) => Promise<unknown>;
}

export type QueryResult =
  | {
      ok: true;
      sql: string;
      columns: string[];
      rowsReturned: number;
      truncated: boolean;
      note?: string;
      rows: Record<string, unknown>[];
    }
  | { ok: false; error: string };

export type DescribeResult =
  | { ok: true; schema: string; viewCount: number; views: unknown[] }
  | { ok: false; error: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The audit trail must not be able to take the answer down with it. A missing
 * `query_log` table is a problem to fix, not a reason to withhold a result the
 * database already returned.
 */
async function record(deps: QueryDeps, entry: QueryLogEntry): Promise<void> {
  try {
    await deps.log(entry);
  } catch {
    // Deliberately swallowed. stderr is the JSON-RPC-safe channel here.
    console.error(`[mcp:query] could not write query_log for ${entry.id}`);
  }
}

export async function runQuery(deps: QueryDeps, sql: string, now: Date): Promise<QueryResult> {
  const started = Date.now();
  const entry = (over: Partial<QueryLogEntry>): QueryLogEntry => ({
    id: randomUUID(),
    ranAt: now,
    sqlText: sql,
    rowCount: 0,
    truncated: 0,
    durationMs: Date.now() - started,
    errorMessage: null,
    ...over,
  });

  const guard = guardReadOnlySql(sql);
  if (!guard.ok) {
    await record(deps, entry({ errorMessage: guard.reason }));
    return { ok: false, error: guard.reason };
  }

  try {
    const { columns, rows, truncated } = await deps.analytics.select(guard.sql, ROW_CAP);
    await record(deps, entry({ rowCount: rows.length, truncated: truncated ? 1 : 0 }));

    return {
      ok: true,
      sql,
      columns,
      rowsReturned: rows.length,
      truncated,
      // Stated rather than implied. A caller that ignores a `truncated: true`
      // flag will not ignore a sentence telling it the answer is incomplete.
      ...(truncated
        ? {
            note:
              `Showing the first ${ROW_CAP} rows; more rows matched. ` +
              `This is a prefix, not the whole answer — add an aggregate, a ` +
              `WHERE clause, or a LIMIT with an ORDER BY to get a complete one.`,
          }
        : {}),
      rows,
    };
  } catch (err) {
    // No rows travel with an error: a partial result set reads exactly like a
    // complete one once it is out of context.
    await record(deps, entry({ errorMessage: message(err) }));
    return { ok: false, error: message(err) };
  }
}

export async function describeViews(deps: QueryDeps): Promise<DescribeResult> {
  try {
    const views = await deps.analytics.describe();
    if (views.length === 0) {
      return {
        ok: false,
        error:
          "The analytics schema contains no views. The migration that creates them has probably not run — do not write queries against it until it has.",
      };
    }
    return { ok: true, schema: "analytics", viewCount: views.length, views };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}
