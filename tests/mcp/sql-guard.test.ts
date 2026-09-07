import { describe, it, expect } from "vitest";
import { guardReadOnlySql } from "@/mcp/sql-guard";

const ok = (sql: string) => {
  const r = guardReadOnlySql(sql);
  if (!r.ok) throw new Error(`expected allowed, was rejected: ${r.reason}`);
  return r;
};

/** Asserts rejection AND that the reason names the right problem. */
const rejected = (sql: string, reason: RegExp) => {
  const r = guardReadOnlySql(sql);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.reason).toMatch(reason);
};

describe("guardReadOnlySql", () => {
  describe("allows a genuine read", () => {
    it("a plain SELECT", () => {
      expect(ok("SELECT * FROM subscriptions").sql).toBe("SELECT * FROM subscriptions");
    });

    it("a WITH ... SELECT", () => {
      ok("WITH m AS (SELECT 1 AS n) SELECT n FROM m");
    });

    it("leading whitespace, comments, and mixed case", () => {
      ok("  -- how many are active?\n  select COUNT(*) from subscriptions where status = 'ACTIVE'");
      ok("/* block */ SeLeCt 1");
    });

    it("a trailing semicolon, which every SQL client appends", () => {
      ok("SELECT 1;");
      ok("SELECT 1 ;  \n");
    });

    it("subqueries, joins, unions and window functions", () => {
      ok(`SELECT s.tier, count(*) FROM subscriptions s
          JOIN tier_change_events t ON t.subscription_id = s.id
          WHERE s.status IN (SELECT 'ACTIVE') GROUP BY 1
          UNION ALL SELECT 'x', 0`);
      ok("SELECT id, row_number() OVER (ORDER BY changed_at) FROM tier_change_events");
    });

    // A deny-list that matched substrings would reject half the warehouse:
    // these are real column and table names.
    it("identifiers that merely contain a forbidden word", () => {
      ok("SELECT updated_at, created_at FROM subscriptions");
      ok("SELECT deleted_count, insertion_order, granted_at FROM subscriptions");
      ok("SELECT * FROM subscriptions WHERE cancellation_reason IS NOT NULL");
    });

    // The words only matter as SQL. Inside a literal they are just text.
    it("a forbidden word inside a string literal", () => {
      ok("SELECT * FROM pilot_notes WHERE body LIKE '%delete the campaign%'");
      ok("SELECT 'drop table students' AS joke");
    });
  });

  describe("rejects anything that is not a single read", () => {
    it("a second statement after a semicolon", () => {
      rejected("SELECT 1; DROP TABLE seal_subscriptions", /single statement/i);
      rejected("SELECT 1;SELECT 2", /single statement/i);
      rejected("SELECT 1; -- trailing\nDELETE FROM subscriptions", /single statement/i);
    });

    it("a statement that does not begin with SELECT or WITH", () => {
      rejected("INSERT INTO pilot_notes (id) VALUES ('x')", /must begin with SELECT or WITH/i);
      rejected("UPDATE subscriptions SET tier = 'studio'", /must begin with SELECT or WITH/i);
      rejected("DELETE FROM subscriptions", /must begin with SELECT or WITH/i);
      rejected("DROP VIEW analytics.subscriptions", /must begin with SELECT or WITH/i);
      rejected("GRANT ALL ON SCHEMA public TO claude_readonly", /must begin with SELECT or WITH/i);
      rejected("SET ROLE postgres", /must begin with SELECT or WITH/i);
      rejected("COPY (SELECT 1) TO PROGRAM 'id'", /must begin with SELECT or WITH/i);
      rejected("DO $$ BEGIN END $$", /must begin with SELECT or WITH/i);
      rejected("CALL something()", /must begin with SELECT or WITH/i);
    });

    // Postgres lets a CTE write. This one starts with WITH and would otherwise
    // sail through the first-keyword check.
    it("a data-modifying CTE", () => {
      rejected(
        "WITH d AS (DELETE FROM seal_subscriptions RETURNING id) SELECT * FROM d",
        /may not contain DELETE/i
      );
      rejected(
        "WITH i AS (INSERT INTO pilot_notes (id) VALUES ('x') RETURNING id) SELECT * FROM i",
        /may not contain INSERT/i
      );
      rejected(
        "WITH u AS (UPDATE subscriptions SET tier='studio' RETURNING id) SELECT * FROM u",
        /may not contain UPDATE/i
      );
    });

    // SELECT ... INTO creates a table. It starts with SELECT.
    it("SELECT INTO, which writes a new table", () => {
      rejected("SELECT * INTO evil FROM subscriptions", /may not contain INTO/i);
    });

    it("functions that reach outside the database", () => {
      rejected("SELECT pg_read_file('/etc/passwd')", /pg_read_file/i);
      rejected("SELECT dblink('host=evil', 'SELECT 1')", /dblink/i);
      rejected("SELECT lo_import('/etc/passwd')", /lo_import/i);
    });

    it("an empty or blank statement", () => {
      rejected("", /empty/i);
      rejected("   \n  ", /empty/i);
      rejected("-- just a comment", /empty/i);
      rejected(";", /empty/i);
    });
  });

  describe("cannot be fooled by quoting", () => {
    // If the stripper mishandled these, a semicolon or keyword hidden inside
    // would be invisible to every check above.
    it("counts a semicolon inside a literal as data, not a separator", () => {
      ok("SELECT * FROM pilot_notes WHERE body = 'a; b'");
      ok(`SELECT * FROM pilot_notes WHERE body = 'it''s; fine'`);
    });

    it("reads a dollar-quoted body as data", () => {
      ok("SELECT $tag$ ; DROP TABLE x $tag$ AS note");
      ok("SELECT $$ ; delete $$ AS note");
    });

    // A dollar quote whose closing tag never arrives means the rest of the
    // statement is unparsed. Guessing would be how an injected statement gets
    // through, so an unreadable statement is refused outright.
    it("refuses a statement whose quoting never closes", () => {
      rejected("SELECT 'unterminated", /unterminated/i);
      rejected("SELECT $tag$ never closed", /unterminated/i);
      rejected("SELECT 1 /* never closed", /unterminated/i);
      rejected('SELECT "unterminated', /unterminated/i);
    });

    it("does not let a quoted identifier stand in for the leading keyword", () => {
      rejected('"SELECT" 1', /must begin with SELECT or WITH/i);
    });

    it("sees a keyword split across a comment", () => {
      rejected("SELECT 1; /* x */ DROP TABLE y", /single statement/i);
    });
  });

  it("returns the original SQL unchanged, not the stripped analysis copy", () => {
    const sql = "SELECT 'a; b' AS x -- note\n FROM subscriptions";
    expect(ok(sql).sql).toBe(sql);
  });
});
