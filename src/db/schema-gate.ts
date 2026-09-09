/**
 * Blocks the worker from booting against a schema older than its own code.
 *
 * ## Why this exists
 *
 * Migrations run as a pre-deploy step on the **web** service only
 * (`railway.toml` → `preDeployCommand = ["pnpm db:migrate"]`). The worker
 * (`worker.railway.toml`) has no such step, and both services deploy in parallel
 * from the same commit. Nothing orders the worker's boot after the migration, so
 * which one goes first varies per deploy with no code change at all.
 *
 * On 2026-09-09 the worker won that race by 54 seconds against a commit that
 * added `voice_samples.source_key` **and** the code that selects it. The corpus
 * sync died on the missing column, the fallback swallowed it, and the worker
 * spent the entire deploy cycle generating from a stale corpus while logging a
 * clean boot. See #54.
 *
 * ## What it does
 *
 * Waits for the newest migration in the repo's journal to appear in
 * `drizzle.__drizzle_migrations`, then gives up. The caller exits non-zero on
 * failure, and the worker's `restartPolicyMaxRetries = 5` retries it into a
 * window where the migration has landed. A bounded wait followed by a real
 * failure, instead of a silent success against old schema.
 *
 * ## Two properties worth keeping
 *
 * The expected mark is **derived from `meta/_journal.json`**, not written down.
 * A hand-maintained constant is one forgotten bump away from a gate that passes
 * on everything, and it would fail open exactly when a migration was added.
 *
 * The gate **fails closed**. A probe that throws has established nothing, and
 * "I could not check" is not "the schema is current". Collapsing those two is
 * the same mistake that made #54 invisible in the first place.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "./client";

export interface SchemaMark {
  /** `folderMillis` of the migration — what Drizzle stores as `created_at`. */
  when: number;
  tag: string;
}

/** Reads the high-water `created_at` from the database, or null if none. */
export type SchemaProbe = () => Promise<number | null>;

export interface AwaitSchemaOptions {
  attempts: number;
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export type AwaitSchemaResult = { ok: true } | { ok: false; reason: string };

interface JournalEntry {
  when: number;
  tag: string;
}

/** The newest migration this build carries. */
export function expectedSchemaMark(): SchemaMark {
  const path = join(process.cwd(), "src/db/migrations/meta/_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as {
    entries: JournalEntry[];
  };

  if (journal.entries.length === 0) {
    throw new Error("Migration journal is empty — cannot establish a schema mark.");
  }

  // By `when`, not by array position. The journal is ordered in practice, but a
  // gate that trusts ordering it does not check is a gate that silently accepts
  // an older mark the one time the ordering is wrong.
  return journal.entries.reduce((a, b) => (b.when > a.when ? b : a));
}

export function createSchemaProbe(db: Db): SchemaProbe {
  return async () => {
    const rows = (await db.execute(
      sql`SELECT max(created_at::bigint) AS mark FROM drizzle.__drizzle_migrations`
    )) as unknown as Array<{ mark: string | number | null }>;
    const mark = rows[0]?.mark;
    return mark === null || mark === undefined ? null : Number(mark);
  };
}

export async function awaitSchema(
  probe: SchemaProbe,
  expected: SchemaMark,
  { attempts, delayMs, sleep }: AwaitSchemaOptions
): Promise<AwaitSchemaResult> {
  const wait = sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let observed: number | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      observed = await probe();
      lastError = null;
      // Ahead is fine — a rolling deploy can leave the database several
      // migrations past this build. Only behind is a problem.
      if (observed !== null && observed >= expected.when) return { ok: true };
    } catch (err) {
      lastError = err;
      observed = null;
    }
    if (attempt < attempts) await wait(delayMs);
  }

  if (lastError !== null) {
    return {
      ok: false,
      reason:
        `Could not read drizzle.__drizzle_migrations after ${attempts} attempts, ` +
        `so the schema was never confirmed to include ${expected.tag}: ${lastError}`,
    };
  }

  return {
    ok: false,
    reason:
      `Database schema is behind this build after ${attempts} attempts. ` +
      `Expected at least ${expected.tag} (${expected.when}), saw ` +
      `${observed === null ? "no migrations at all" : observed}. ` +
      "Migrations run as a pre-deploy step on the web service; this worker " +
      "deploys in parallel and has started first.",
  };
}
