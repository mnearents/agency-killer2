/**
 * The read-only connection the `query` tool runs on.
 *
 * A separate seam from `@/db/client` on purpose. That pool connects as the
 * owner and can write everything; this one connects as `claude_readonly`,
 * which has SELECT on the `analytics` views and no privilege at all on
 * `public`. Sharing one pool would make the whole view-based security model
 * decorative — the views would still exclude PII, but nothing would stop a
 * query reading straight past them into `seal_subscriptions.email`.
 *
 * There is deliberately no fallback to `DATABASE_URL`. If the read-only URL is
 * missing the tool is unavailable, because the alternative is a tool that
 * silently runs arbitrary SQL as the owner.
 */

import postgres from "postgres";

export interface QueryRows {
  columns: string[];
  rows: Record<string, unknown>[];
  /** True when the cap was hit, so `rows` is a prefix of the real answer. */
  truncated: boolean;
}

export interface ViewColumn {
  name: string;
  type: string;
}

export interface ViewDescription {
  view: string;
  /** The COMMENT ON VIEW text, which records the traps in reading it. */
  comment: string | null;
  columns: ViewColumn[];
}

export interface AnalyticsDb {
  /** Runs `sql`, returning at most `limit` rows and whether more matched. */
  select(sql: string, limit: number): Promise<QueryRows>;
  /** Reads the live catalog — never a hardcoded list, which could drift. */
  describe(): Promise<ViewDescription[]>;
  close(): Promise<void>;
}

const SCHEMA = "analytics";

export function createAnalyticsDb(url: string): AnalyticsDb {
  const sql = postgres(url, {
    max: 2,
    // Belt and braces: the role already has this set, but a role setting can
    // be changed out from under the process.
    connection: { statement_timeout: 30_000 },
    onnotice: () => {},
  });

  return {
    async select(statement, limit) {
      // Asking for one more row than the cap is how truncation is detected
      // without counting the whole result set twice.
      const wrapped = `SELECT * FROM (${statement.replace(/[\s;]+$/, "")}) AS _capped LIMIT ${limit + 1}`;
      const result = await sql.unsafe(wrapped);
      const rows = result.slice(0, limit) as unknown as Record<string, unknown>[];
      return {
        columns: result.columns?.map((c) => c.name) ?? Object.keys(rows[0] ?? {}),
        rows,
        truncated: result.length > limit,
      };
    },

    async describe() {
      const rows = (await sql`
        SELECT c.table_name  AS view,
               c.column_name AS column,
               c.data_type   AS type,
               obj_description(format('%I.%I', c.table_schema, c.table_name)::regclass, 'pg_class') AS comment
        FROM information_schema.columns c
        JOIN information_schema.views v
          ON v.table_schema = c.table_schema AND v.table_name = c.table_name
        WHERE c.table_schema = ${SCHEMA}
        ORDER BY c.table_name, c.ordinal_position
      `) as unknown as { view: string; column: string; type: string; comment: string | null }[];

      const byView = new Map<string, ViewDescription>();
      for (const r of rows) {
        let entry = byView.get(r.view);
        if (!entry) {
          entry = { view: r.view, comment: r.comment, columns: [] };
          byView.set(r.view, entry);
        }
        entry.columns.push({ name: r.column, type: r.type });
      }
      return [...byView.values()];
    },

    close: () => sql.end(),
  };
}
