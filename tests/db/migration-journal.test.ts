/**
 * Guards the migration journal's ordering invariant.
 *
 * Drizzle does not apply migrations in filename order. It reads the highest
 * `created_at` already in drizzle.__drizzle_migrations ONCE, then applies every
 * journal entry whose `when` is greater than that mark:
 *
 *   if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)
 *
 * So an entry numbered above its neighbours but stamped below them is skipped —
 * silently, with no row written and no non-zero exit. `pnpm db:migrate` prints
 * "Migrations complete." either way, and the missing table surfaces much later
 * as empty results rather than as a failed deploy.
 *
 * That is not hypothetical. Five branches forked off 0015 in parallel and hand-
 * wrote their timestamps as 0015's plus whole seconds, which left 0016 stamped
 * later than 0017 through 0021. Merging in the intended order would have applied
 * 0016 and then silently dropped the customers table.
 *
 * Parallel work is the normal state here, so this asserts the invariant rather
 * than relying on everyone remembering an unwritten rule.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";

const MIGRATIONS_DIR = join(__dirname, "../../src/db/migrations");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const journal: { entries: JournalEntry[] } = JSON.parse(
  readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")
);

/** "0017_customers_and_segments" -> 17 */
function numericPrefix(tag: string): number {
  const match = tag.match(/^(\d{4})_/);
  if (!match) throw new Error(`Migration tag is not NNNN_-prefixed: ${tag}`);
  return Number(match[1]);
}

describe("migration journal", () => {
  it("has at least one entry, so an empty journal cannot read as ordered", () => {
    // Every assertion below is vacuously true over an empty list. A journal
    // that failed to parse, or was emptied by a bad merge resolution, must
    // fail here rather than pass everything.
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it("numbers entries contiguously from zero", () => {
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual(idxs.map((_, i) => i));
  });

  it("agrees between each entry's idx and its filename number", () => {
    // A rename that misses the journal, or a journal edit that misses the
    // rename, leaves these disagreeing.
    for (const entry of journal.entries) {
      expect(numericPrefix(entry.tag)).toBe(entry.idx);
    }
  });

  // The one that matters. Everything else here is tidiness; this is the
  // invariant that decides whether a migration runs at all.
  it("stamps every entry later than the one before it", () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1];
      const curr = journal.entries[i];
      expect(
        curr.when,
        `${curr.tag} (when=${curr.when}) is stamped at or before ${prev.tag} ` +
          `(when=${prev.when}), so Drizzle will skip it once ${prev.tag} is applied`
      ).toBeGreaterThan(prev.when);
    }
  });

  it("stamps no two entries identically", () => {
    const whens = journal.entries.map((e) => e.when);
    expect(new Set(whens).size).toBe(whens.length);
  });

  it("has a SQL file for every entry", () => {
    const files = new Set(readdirSync(MIGRATIONS_DIR));
    for (const entry of journal.entries) {
      expect(files, `journal references ${entry.tag}.sql`).toContain(`${entry.tag}.sql`);
    }
  });

  it("has a journal entry for every SQL file", () => {
    // The reverse direction: a migration file nobody recorded never runs, and
    // its absence looks exactly like a migration that ran and did nothing.
    const tags = new Set(journal.entries.map((e) => e.tag));
    const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    for (const file of sqlFiles) {
      expect(tags, `${file} is not in the journal`).toContain(file.replace(/\.sql$/, ""));
    }
  });
});

/**
 * ─── Snapshot drift ───────────────────────────────────────────────────
 *
 * Drizzle generates a migration by diffing `schema.ts` against the NEWEST
 * snapshot in `meta/`, never against the database. A hand-written migration
 * that does not also write a snapshot therefore leaves the snapshot describing
 * an older schema — and the next `drizzle-kit generate` emits everything that
 * happened in between, on top of whatever is genuinely new.
 *
 * That is not hypothetical. Snapshots were never written for 0016, 0017, 0018,
 * 0020 or 0021, so generating 0022 produced `CREATE TABLE segments`, `CREATE
 * TABLE shopify_customers`, `ADD COLUMN inventory_item_id` and three
 * `ADD CONSTRAINT`s alongside the two new tables. Every one of those objects
 * already exists in production; the file would have failed on its first
 * statement, and in a less lucky shape it would have succeeded and dropped
 * something.
 *
 * The invariant that catches it is that the newest snapshot has to describe the
 * same tables `schema.ts` does. When it does, the next diff is correct.
 */
describe("the newest drizzle snapshot", () => {
  const snapshotFiles = readdirSync(join(MIGRATIONS_DIR, "meta"))
    .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
    .sort();

  const newestSnapshot: { tables: Record<string, unknown> } = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", snapshotFiles[snapshotFiles.length - 1]), "utf8")
  );

  const declaredTables = new Set(
    Object.values(schema)
      .filter((v) => is(v, PgTable))
      .map((t) => getTableName(t as PgTable))
  );

  it("has snapshots at all, so the comparison below is not vacuous", () => {
    expect(snapshotFiles.length).toBeGreaterThan(0);
    expect(declaredTables.size).toBeGreaterThan(0);
  });

  it("belongs to the newest migration, so the next diff starts from here", () => {
    const newestEntry = journal.entries[journal.entries.length - 1];
    const snapshotIdx = snapshotFiles[snapshotFiles.length - 1].slice(0, 4);
    expect(
      Number(snapshotIdx),
      `newest journal entry is ${newestEntry.tag} but the newest snapshot is ` +
        `${snapshotIdx}_snapshot.json — the next generate will diff against a stale picture ` +
        `and re-emit everything since`
    ).toBe(newestEntry.idx);
  });

  it("describes exactly the tables schema.ts declares", () => {
    const inSnapshot = new Set(Object.keys(newestSnapshot.tables).map((k) => k.replace(/^public\./, "")));

    const missing = [...declaredTables].filter((t) => !inSnapshot.has(t));
    const extra = [...inSnapshot].filter((t) => !declaredTables.has(t));

    expect(
      missing,
      `schema.ts declares ${missing.join(", ")} but the newest snapshot does not — ` +
        `the next generate will emit CREATE TABLE for them again`
    ).toEqual([]);
    expect(
      extra,
      `the newest snapshot has ${extra.join(", ")} but schema.ts does not — ` +
        `the next generate will emit DROP TABLE for them`
    ).toEqual([]);
  });
});

/**
 * ─── The security boundary is defined by migrations (#36) ─────────────
 *
 * 0015 created `claude_readonly` as NOLOGIN, which was right when the role
 * only existed to own grants. The `query` tool arrived later, the role was
 * granted LOGIN by hand, and the migration was never updated — so the file
 * that defines the boundary described a role nothing could connect to.
 *
 * Production was fine. Any environment rebuilt from migrations was not.
 */
describe("claude_readonly is declared the way production has it", () => {
  const sqlFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const combined = sqlFiles
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n");

  it("grants the role LOGIN somewhere in the migration history", () => {
    expect(combined).toMatch(/claude_readonly\s+LOGIN|ALTER ROLE claude_readonly LOGIN/);
  });

  /**
   * The last word wins when migrations run in order, so what matters is that
   * no file AFTER the one granting LOGIN takes it away again.
   */
  it("does not revoke it afterwards", () => {
    const grantIdx = combined.search(/ALTER ROLE claude_readonly LOGIN/);
    expect(grantIdx).toBeGreaterThan(-1);
    expect(combined.slice(grantIdx)).not.toMatch(/ALTER ROLE claude_readonly\s+NOLOGIN/);
  });

  // A password in a migration is a password in the repository.
  it("sets no password for it anywhere", () => {
    expect(combined).not.toMatch(/claude_readonly[\s\S]{0,80}PASSWORD\s+'[^']/i);
  });
});
