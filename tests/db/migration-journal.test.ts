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
