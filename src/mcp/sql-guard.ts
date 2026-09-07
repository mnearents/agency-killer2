/**
 * Fail-closed check that a statement is a single read.
 *
 * This is the SECOND line of defence, not the first. The `claude_readonly`
 * role has SELECT on the `analytics` views and nothing else: no base tables,
 * no writes, no DDL, no file or program functions, and every session runs in a
 * read-only transaction. A statement that slipped past this guard would still
 * be refused by Postgres.
 *
 * It exists anyway because a permission error arrives after the fact and reads
 * like a bug, while a refusal here names what was wrong with the query. And a
 * grant added carelessly later should not silently widen what the tool can do.
 *
 * The strategy is deliberately not "parse SQL". It is: make the statement
 * unambiguous by blanking out everything that is data, then refuse anything
 * that is not plainly one SELECT. Anything it cannot read confidently is
 * REJECTED — an unterminated quote means the rest of the statement was never
 * examined, which is exactly how something would get through.
 */

export type SqlGuardResult = { ok: true; sql: string } | { ok: false; reason: string };

/**
 * Keywords that cannot appear anywhere in a read, checked on whole words only.
 * `updated_at` and `deleted_count` are real column names; a substring match
 * would reject half the warehouse.
 *
 * INTO is here because `SELECT * INTO evil FROM x` creates a table and passes
 * the leading-keyword check. The DML verbs are here because Postgres allows a
 * writing CTE, so `WITH d AS (DELETE ...) SELECT * FROM d` also passes it.
 */
const FORBIDDEN = [
  "insert",
  "update",
  "delete",
  "merge",
  "truncate",
  "drop",
  "create",
  "alter",
  "grant",
  "revoke",
  "copy",
  "into",
  "vacuum",
  "analyze",
  "reindex",
  "cluster",
  "refresh",
  "listen",
  "notify",
  "prepare",
  "execute",
  "call",
  "do",
  "set",
  "reset",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "lock",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_logfile_rotate",
  "pg_sleep",
  "dblink",
  "dblink_connect",
  "lo_import",
  "lo_export",
  "pg_terminate_backend",
  "pg_cancel_backend",
];

/**
 * Replace every literal, quoted identifier and comment with spaces, so that
 * what remains is only SQL structure. Spaces rather than nothing, so that
 * `a'x'b` cannot become the single word `ab`.
 *
 * Returns null when the statement cannot be read to the end.
 */
function blankOutData(sql: string): { text: string } | { unterminated: string } {
  let out = "";
  let i = 0;
  const pad = (n: number) => " ".repeat(n);

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += pad(stop - i);
      i = stop;
      continue;
    }

    if (c === "/" && next === "*") {
      // Postgres block comments nest, so a naive search for the first `*/`
      // would stop inside an inner comment and treat the rest as SQL.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      if (depth > 0) return { unterminated: "block comment" };
      out += pad(j - i);
      i = j;
      continue;
    }

    if (c === "'" || c === '"') {
      // A doubled quote is an escaped quote, not the end of the literal.
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else {
            j++;
            closed = true;
            break;
          }
        } else j++;
      }
      if (!closed) return { unterminated: c === "'" ? "string literal" : "quoted identifier" };
      out += pad(j - i);
      i = j;
      continue;
    }

    if (c === "$") {
      const tag = /^\$[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close === -1) return { unterminated: "dollar-quoted string" };
        const end = close + tag[0].length;
        out += pad(end - i);
        i = end;
        continue;
      }
    }

    out += c;
    i++;
  }

  return { text: out };
}

export function guardReadOnlySql(raw: string): SqlGuardResult {
  const blanked = blankOutData(raw);
  if ("unterminated" in blanked) {
    return { ok: false, reason: `Unterminated ${blanked.unterminated} — the statement could not be read to the end, so it is refused.` };
  }

  // Trailing semicolons are what every SQL client appends; only a semicolon
  // with something after it means a second statement.
  const text = blanked.text.replace(/[\s;]+$/, "");
  if (text.trim() === "") {
    return { ok: false, reason: "Empty statement — there is nothing to run." };
  }
  if (text.includes(";")) {
    return {
      ok: false,
      reason: "Only a single statement is allowed; the query contains more than one.",
    };
  }

  const first = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  const keyword = first?.[1].toLowerCase();
  if (keyword !== "select" && keyword !== "with") {
    return {
      ok: false,
      reason: `A query must begin with SELECT or WITH. This one begins with "${first?.[1] ?? text.trim().slice(0, 12)}".`,
    };
  }

  const lower = text.toLowerCase();
  for (const word of FORBIDDEN) {
    if (new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`).test(lower)) {
      return {
        ok: false,
        reason: `A read-only query may not contain ${word.toUpperCase()}.`,
      };
    }
  }

  // The ORIGINAL text is what runs. The blanked copy exists only to be read.
  return { ok: true, sql: raw };
}
