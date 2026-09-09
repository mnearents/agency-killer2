/**
 * The worker must not run against a schema older than the code it is running.
 *
 * Migrations are a pre-deploy step on the **web** service only
 * (`railway.toml` → `preDeployCommand`). The worker has no such step and deploys
 * in parallel, so nothing orders its boot after the migration. On 2026-09-09 the
 * worker won that race by 54 seconds against a commit that added
 * `voice_samples.source_key` and the code that selects it, and spent the whole
 * deploy cycle serving a stale corpus. See #54.
 *
 * The gate closes it by waiting for the journal's newest migration to appear in
 * `drizzle.__drizzle_migrations`, then exiting non-zero if it does not. The
 * worker's `restartPolicyMaxRetries = 5` turns that into a retry into a window
 * where the migration has landed — a bounded wait and then a real failure,
 * rather than a silent success on old schema.
 *
 * The expected mark is derived from `meta/_journal.json` rather than a constant,
 * so it cannot drift out of date the way a hand-maintained version would.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectedSchemaMark,
  awaitSchema,
  type SchemaProbe,
} from "@/db/schema-gate";

/** A probe that reports `marks` in order, one per attempt. */
const probeReturning = (...marks: Array<number | Error>): SchemaProbe => {
  let i = 0;
  return async () => {
    const m = marks[Math.min(i++, marks.length - 1)];
    if (m instanceof Error) throw m;
    return m;
  };
};

const opts = { attempts: 3, delayMs: 0, sleep: async () => {} };

describe("expectedSchemaMark", () => {
  it("reads the newest migration from the journal", () => {
    const mark = expectedSchemaMark();
    expect(mark.tag).toMatch(/^\d{4}_/);
    expect(mark.when).toBeGreaterThan(0);
  });

  // If this ever picks an earlier entry the gate passes against a schema that
  // is genuinely behind, which is the whole failure it exists to prevent.
  it("picks the newest entry, not the first or an arbitrary one", () => {
    const journal = JSON.parse(
      readFileSync("src/db/migrations/meta/_journal.json", "utf8")
    );
    const newest = journal.entries.reduce(
      (a: { when: number }, b: { when: number }) => (b.when > a.when ? b : a)
    );
    expect(expectedSchemaMark().when).toBe(newest.when);
    expect(expectedSchemaMark().tag).toBe(newest.tag);
  });
});

describe("awaitSchema", () => {
  it("returns immediately when the database is already at the expected mark", async () => {
    const probe = vi.fn(probeReturning(1788797927928));
    const r = await awaitSchema(probe, { when: 1788797927928, tag: "0021_x" }, opts);
    expect(r.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  // The web service may already be several migrations ahead of this worker's
  // commit during a rolling deploy. Ahead is fine; behind is not.
  it("accepts a database that is ahead of this build", async () => {
    const r = await awaitSchema(
      probeReturning(1788797999999),
      { when: 1788797927928, tag: "0021_x" },
      opts
    );
    expect(r.ok).toBe(true);
  });

  it("waits and retries while the database is behind", async () => {
    const probe = vi.fn(probeReturning(1788797926928, 1788797926928, 1788797927928));
    const r = await awaitSchema(probe, { when: 1788797927928, tag: "0021_x" }, opts);
    expect(r.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("gives up rather than waiting forever", async () => {
    const probe = vi.fn(probeReturning(1788797926928));
    const r = await awaitSchema(probe, { when: 1788797927928, tag: "0021_x" }, opts);
    expect(r.ok).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  // Fail closed. A probe that throws has established nothing, and "I could not
  // check" is not "the schema is current" — that equivalence is the exact bug
  // this gate was written for.
  it("treats an unreadable journal table as not-ready, never as ready", async () => {
    const r = await awaitSchema(
      probeReturning(new Error("relation \"__drizzle_migrations\" does not exist")),
      { when: 1788797927928, tag: "0021_x" },
      opts
    );
    expect(r.ok).toBe(false);
  });

  it("reports what it wanted and what it saw, so the failure is actionable", async () => {
    const r = await awaitSchema(
      probeReturning(1788797926928),
      { when: 1788797927928, tag: "0021_voice_source_key" },
      opts
    );
    if (r.ok) throw new Error("expected the gate to fail");
    expect(r.reason).toContain("0021_voice_source_key");
    expect(r.reason).toContain("1788797926928");
  });

  it("names the underlying error when the probe never succeeded", async () => {
    const r = await awaitSchema(
      probeReturning(new Error("connection refused")),
      { when: 1, tag: "0001_x" },
      opts
    );
    if (r.ok) throw new Error("expected the gate to fail");
    expect(r.reason).toMatch(/connection refused/);
  });

  // A database with no journal rows at all is a database that has never been
  // migrated, not one that is merely lagging.
  it("treats a database with no migrations as behind", async () => {
    const r = await awaitSchema(probeReturning(null as never), { when: 1, tag: "0001_x" }, opts);
    expect(r.ok).toBe(false);
  });
});

/**
 * A gate wired to nothing is indistinguishable from a gate that always passes.
 * This whole module is worthless without the call site, so the call site is what
 * gets asserted — see CLAUDE.md, "Assert the call site, not just the behavior".
 */
describe("worker schema gate wiring", () => {
  const workerSource = readFileSync(
    join(process.cwd(), "src/worker/index.ts"),
    "utf-8"
  );

  it("awaits the schema during boot", () => {
    expect(workerSource).toMatch(/awaitSchema\s*\(/);
  });

  it("gates before opening the database for real work", () => {
    // Anything that reads a table before the gate is exactly what the gate is
    // for, and would fail on the old schema it is meant to wait out.
    const gate = workerSource.search(/awaitSchema\s*\(/);
    const sync = workerSource.search(/syncVoiceCorpus\s*\(\s*db\b/);
    expect(gate).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(sync);
  });

  // The whole point of option 2 over "log and continue": the worker has to exit
  // non-zero so Railway's restart policy retries it. A gate that reports and
  // carries on is the behaviour that already failed.
  it("exits non-zero when the gate fails rather than starting anyway", () => {
    const block = workerSource.match(/if\s*\(\s*!schema\.ok\s*\)\s*\{[\s\S]{0,400}?\n  \}/);
    expect(block, "no `if (!schema.ok)` block found in the worker").not.toBeNull();
    expect(block![0]).toMatch(/process\.exit\(\s*[^0]\s*\)/);
  });
});
