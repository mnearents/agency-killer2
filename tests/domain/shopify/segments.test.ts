import { describe, it, expect, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  SEED_SEGMENTS,
  assertSafePredicate,
  evaluateSegments,
  seedSegments,
  prepareAndEvaluateSegments,
} from "@/domain/shopify/segments";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@/db/client";

const NOW = new Date("2026-09-07T12:00:00Z");

describe("SEED_SEGMENTS", () => {
  const ids = SEED_SEGMENTS.map((s) => s.id);

  it("covers every segment the issue names", () => {
    expect(ids).toEqual(
      expect.arrayContaining([
        "teachers",
        "homeschoolers",
        "adult_self_use",
        "gift_buyers",
        "planner_buyers",
        "rad_subscribers_active",
        "rad_subscribers_lapsed",
        "grandfathered_spark",
        "studio_upgraders",
        "high_value",
      ])
    );
  });

  it("has no duplicate ids", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  // A segment IS its definition. One without notes is a number nobody can argue
  // with, which is the exact failure the table exists to prevent.
  it("gives every segment a readable definition and a reason for it", () => {
    for (const s of SEED_SEGMENTS) {
      expect(s.definition.trim(), s.id).not.toBe("");
      expect(s.notes?.trim(), s.id).toBeTruthy();
    }
  });

  it("ships every definition unevaluated rather than with a count of zero", () => {
    for (const s of SEED_SEGMENTS) {
      expect(s.memberCount ?? null, s.id).toBeNull();
      expect(s.lastEvaluatedAt ?? null, s.id).toBeNull();
    }
  });

  it("passes its own safety check", () => {
    for (const s of SEED_SEGMENTS) {
      expect(() => assertSafePredicate(s.definition), s.id).not.toThrow();
    }
  });

  // Seal holds only the survivors of the most recent of two app migrations, and
  // Shopify subscription apps do not migrate cancelled subscribers, so each
  // migration dropped its churned population. Defining lapsed from Seal returns
  // 71 against a real 15,364 — a 200x undercount that reads as a real number.
  it("defines the lapsed segment from customer tags, not from Seal", () => {
    const lapsed = SEED_SEGMENTS.find((s) => s.id === "rad_subscribers_lapsed")!;
    expect(lapsed.definition).toContain("customer_tags");
    expect(lapsed.definition).not.toContain("analytics.subscriptions");
  });

  // Both spellings are live in Shopify: inactive_subscriber (9,065) and
  // inactive-subscriber (7,847). Matching one drops roughly half the segment
  // and still returns a plausible-looking five-figure number.
  it("matches both spellings of the inactive-subscriber tag", () => {
    const lapsed = SEED_SEGMENTS.find((s) => s.id === "rad_subscribers_lapsed")!;
    expect(lapsed.definition).toContain("inactive_subscriber");
    expect(lapsed.definition).toContain("inactive-subscriber");
  });

  it("excludes anyone currently tagged active-subscriber", () => {
    const lapsed = SEED_SEGMENTS.find((s) => s.id === "rad_subscribers_lapsed")!;
    expect(lapsed.definition).toMatch(/NOT.*active-subscriber/s);
  });

  // 85.7% of the lapsed have no subscription order in our history at all, so a
  // recency band silently describes the 14.3% that do. Requiring the proxy date
  // to be non-null is what keeps the other 13,174 out of a band they cannot be
  // placed in, rather than defaulting them into the oldest one.
  const RECENCY_BANDS = ["lapsed_under_12m", "lapsed_12_to_24m", "lapsed_24m_plus"];

  it("bands the lapsed only where a proxy cancellation date exists", () => {
    for (const id of RECENCY_BANDS) {
      const s = SEED_SEGMENTS.find((seg) => seg.id === id);
      expect(s, id).toBeDefined();
      expect(s!.definition, id).toContain("last_subscription_order_at IS NOT NULL");
      // A band that forgot it is a subset of the lapsed would count everyone.
      expect(s!.definition, id).toContain("inactive_subscriber");
    }
  });

  // The bands must partition, not overlap: a customer counted in two of them
  // makes the three sizes sum to more than the population they describe.
  it("gives the recency bands non-overlapping bounds", () => {
    const bounds = RECENCY_BANDS.map(
      (id) => SEED_SEGMENTS.find((s) => s.id === id)!.definition
    );
    expect(bounds[0]).toMatch(/< interval '365 days'/);
    expect(bounds[1]).toMatch(/>= interval '365 days'/);
    expect(bounds[1]).toMatch(/< interval '730 days'/);
    expect(bounds[2]).toMatch(/>= interval '730 days'/);
    expect(bounds[2]).not.toMatch(/< interval/);
  });

  it("has a segment for the lapsed with no proxy date, so they are not lost", () => {
    const undated = SEED_SEGMENTS.find((s) => s.id === "lapsed_no_proxy_date")!;
    expect(undated).toBeDefined();
    expect(undated.definition).toContain("last_subscription_order_at IS NULL");
  });
});

describe("seedSegments", () => {
  function createSeedDb() {
    const conflictActions: string[] = [];
    const values: unknown[][] = [];
    const db = {
      _conflictActions: conflictActions,
      _values: values,
      insert: () => ({
        values: (rows: unknown[]) => {
          values.push(rows);
          return {
            onConflictDoNothing: () => {
              conflictActions.push("nothing");
              return Promise.resolve();
            },
            onConflictDoUpdate: () => {
              conflictActions.push("update");
              return Promise.resolve();
            },
          };
        },
      }),
    };
    return db as unknown as Db & { _conflictActions: string[]; _values: unknown[][] };
  }

  it("inserts every seed definition", async () => {
    const db = createSeedDb();
    const inserted = await seedSegments(db);
    expect(db._values[0]).toHaveLength(SEED_SEGMENTS.length);
    expect(inserted).toBe(SEED_SEGMENTS.length);
  });

  /**
   * This used to assert the opposite — that an existing definition is left
   * alone, protecting "a definition someone edited". Nothing can edit one, so
   * it protected nothing and prevented `high_value` from ever being corrected
   * in the database (#76). See "seedSegments keeps stored definitions in step
   * with the code" below for what replaced it.
   */
  it("refreshes an existing definition rather than leaving it stale", async () => {
    const db = createSeedDb();
    await seedSegments(db);
    expect(db._conflictActions).toEqual(["update"]);
  });
});

describe("assertSafePredicate", () => {
  it("accepts a plain predicate", () => {
    expect(() => assertSafePredicate("is_subscriber = 1")).not.toThrow();
  });

  it("rejects a statement terminator", () => {
    expect(() => assertSafePredicate("1=1; DROP TABLE shopify_customers")).toThrow();
  });

  it("rejects a comment marker that could truncate the wrapping query", () => {
    expect(() => assertSafePredicate("1=1 -- ")).toThrow();
    expect(() => assertSafePredicate("1=1 /* x */")).toThrow();
  });

  it("rejects writes", () => {
    for (const p of [
      "1=1 OR (DELETE FROM segments) IS NULL",
      "EXISTS (INSERT INTO segments VALUES ('x'))",
      "1=1 UNION SELECT 1",
      "(UPDATE segments SET name='x') IS NULL",
      "1=1 OR pg_sleep(10) IS NOT NULL",
    ]) {
      expect(() => assertSafePredicate(p), p).toThrow();
    }
  });

  it("rejects an empty predicate rather than treating it as match-everything", () => {
    expect(() => assertSafePredicate("")).toThrow();
    expect(() => assertSafePredicate("   ")).toThrow();
  });

  it("names what it rejected", () => {
    expect(() => assertSafePredicate("1=1; DROP TABLE x")).toThrow(/;/);
  });
});

/**
 * Rows are returned in the order given, and every segment produces exactly one
 * update, so `_updates[i]` is the update for the i-th segment. The where clause
 * is deliberately not inspected — it is a Drizzle SQL object with circular
 * references, and matching on position is enough to tell the updates apart.
 */
function createMockDb(counts: Record<string, number | Error>) {
  const rows = Object.keys(counts).map((id) => ({ id, definition: `id = '${id}'` }));
  const updates: Array<Record<string, unknown>> = [];
  const outcomes = [...Object.values(counts)];
  let call = 0;

  const db: Record<string, unknown> = {
    _updates: updates,
    _txConfigs: [] as unknown[],
    select: () => ({ from: () => Promise.resolve(rows) }),
    transaction: (cb: (tx: unknown) => unknown, config: unknown) => {
      (db._txConfigs as unknown[]).push(config);
      return cb(db);
    },
    execute: () => {
      const outcome = outcomes[call++];
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve([{ count: outcome }]);
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push({ ...values });
          return Promise.resolve();
        },
      }),
    }),
  };
  return db as unknown as Db & {
    _updates: Array<Record<string, unknown>>;
    _txConfigs: unknown[];
  };
}

describe("evaluateSegments", () => {
  it("writes the count and the time it was taken", async () => {
    const db = createMockDb({ teachers: 412 });
    const result = await evaluateSegments(db, NOW);

    expect(result.evaluated).toBe(1);
    expect(result.failed).toBe(0);
    expect(db._updates[0].memberCount).toBe(412);
    expect(db._updates[0].lastEvaluatedAt).toEqual(NOW);
    expect(db._updates[0].lastEvaluationError).toBeNull();
  });

  it("returns a size per segment", async () => {
    const db = createMockDb({ teachers: 412, high_value: 900 });
    const result = await evaluateSegments(db, NOW);
    expect(result.sizes).toEqual({ teachers: 412, high_value: 900 });
  });

  // A failed evaluation that leaves last_evaluated_at moved forward is the
  // worst outcome: a stale count wearing a fresh timestamp.
  it("does not advance lastEvaluatedAt when the evaluation failed", async () => {
    const db = createMockDb({ teachers: new Error("column does not exist") });
    const result = await evaluateSegments(db, NOW);

    expect(result.failed).toBe(1);
    expect(result.evaluated).toBe(0);
    expect(db._updates[0].lastEvaluatedAt).toBeUndefined();
    expect(db._updates[0].memberCount).toBeUndefined();
    expect(db._updates[0].lastEvaluationError).toContain("column does not exist");
  });

  it("omits a failed segment from the reported sizes rather than reporting zero", async () => {
    const db = createMockDb({ teachers: new Error("boom"), high_value: 900 });
    const result = await evaluateSegments(db, NOW);
    expect(result.sizes).toEqual({ high_value: 900 });
  });

  it("keeps going after one segment fails", async () => {
    const db = createMockDb({ teachers: new Error("boom"), high_value: 900 });
    const result = await evaluateSegments(db, NOW);
    expect(result.evaluated).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("opens the counting transaction with an explicit read-only access mode", async () => {
    const db = createMockDb({ teachers: 412 });
    await evaluateSegments(db, NOW);
    // Not `toHaveBeenCalled` on the wrapper: a transaction opened with no
    // config is still a transaction, and it is read-write.
    expect(db._txConfigs).toEqual([{ accessMode: "read only" }]);
  });

  it("records an unsafe predicate as a failure without running it", async () => {
    const db = createMockDb({ teachers: 1 });
    const execute = vi.spyOn(db as unknown as { execute: () => unknown }, "execute");
    (db as unknown as { select: () => unknown }).select = () => ({
      from: () => Promise.resolve([{ id: "teachers", definition: "1=1; DROP TABLE x" }]),
    });

    const result = await evaluateSegments(db, NOW);

    expect(execute).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(db._updates[0].lastEvaluationError).toMatch(/;/);
  });
});

/**
 * The read-only transaction, asserted on the SQL rather than on the wrapper.
 *
 * `segments.definition` is a Claude-writable column interpolated through
 * `sql.raw()`. The documented defense is two layers: `assertSafePredicate`'s
 * blocklist, and a read-only transaction underneath it so that anything the
 * blocklist misses still cannot write. A blocklist over raw SQL is precisely
 * the kind of guard that needs a second layer.
 *
 * The subtlety is that `db.transaction(cb)` with no config is a perfectly real
 * transaction — and read-write. It emits no `set transaction` at all. So a test
 * that asserts a transaction was opened passes on an implementation with no
 * protection whatsoever. The only honest assertion is on the statement the
 * server receives.
 *
 * These drive the real evaluator through a real Drizzle instance over a fake
 * postgres-js client that records every query string. Drizzle turns
 * `{ accessMode: "read only" }` into `set transaction read only` issued inside
 * the transaction (postgres-js/session.js:117-119 → pg-core/session.js:148-163),
 * so recording the queries proves the mode reached Postgres.
 */
function createRecordingDb() {
  const queries: string[] = [];

  const client: Record<string, unknown> = {
    // Fields are mapped positionally from `.values()`, so the select returns
    // an array-of-arrays matching { id, definition }.
    unsafe: (query: string) => {
      queries.push(query);
      const rows: unknown = /^\s*select "id"/i.test(query)
        ? [["teachers", "is_teacher = 1"]]
        : /count\(\*\)/i.test(query)
          ? [{ count: 7 }]
          : [];
      const p = Promise.resolve(rows) as Promise<unknown> & { values: () => Promise<unknown> };
      p.values = () => Promise.resolve(rows);
      return p;
    },
    begin: async (cb: (c: unknown) => Promise<unknown>) => {
      queries.push("-- begin");
      const out = await cb(client);
      queries.push("-- commit");
      return out;
    },
    options: { parsers: {}, serializers: {} },
  };

  return { db: drizzle(client as never) as unknown as Db, queries };
}

describe("evaluateSegments transaction SQL", () => {
  it("issues `set transaction read only` before the count", async () => {
    const { db, queries } = createRecordingDb();
    await evaluateSegments(db, NOW);

    const setMode = queries.findIndex((q) => /^set transaction read only$/i.test(q));
    const count = queries.findIndex((q) => /count\(\*\)/i.test(q));

    expect(setMode, `no read-only access mode was set; queries were:\n${queries.join("\n")}`)
      .toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(setMode);
  });

  it("runs the count inside that transaction rather than beside it", async () => {
    const { db, queries } = createRecordingDb();
    await evaluateSegments(db, NOW);

    const begin = queries.indexOf("-- begin");
    const commit = queries.indexOf("-- commit");
    const count = queries.findIndex((q) => /count\(\*\)/i.test(q));

    expect(begin).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(begin);
    expect(count).toBeLessThan(commit);
  });

  // The counterpart failure: putting the whole loop inside the read-only
  // transaction would make every write fail, and the evaluator would report
  // every segment as errored. The update has to stay outside.
  it("writes the result outside the read-only transaction", async () => {
    const { db, queries } = createRecordingDb();
    const result = await evaluateSegments(db, NOW);

    const commit = queries.indexOf("-- commit");
    const update = queries.findIndex((q) => /^update "segments"/i.test(q));

    // Without this, `commit` is -1 and the ordering assertion below holds of an
    // implementation that opens no transaction at all.
    expect(commit).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(commit);
    expect(result.failed).toBe(0);
    expect(result.sizes).toEqual({ teachers: 7 });
  });
});

/**
 * ─── #50: seedSegments was never called ───────────────────────────────
 *
 * `seedSegments` was defined, fully tested, and had no caller anywhere in
 * `src/`. The table has been empty in production since it shipped, so
 * `evaluateSegments` looped over nothing and the worker logged
 *
 *     [sync:customers] Segments: 0 evaluated, 0 failed
 *
 * every day. That is also exactly what a healthy run prints on a day when
 * nothing went wrong, which is why it survived for weeks — there is no
 * threshold, alert or non-zero exit separating them.
 *
 * Two things are needed and neither is sufficient alone: the seed has to
 * actually run, and an empty table has to stop being indistinguishable from a
 * clean one. `prepareAndEvaluateSegments` does both in one call, so the worker
 * has a single call site and the seed-then-evaluate ordering is a property a
 * unit test can assert rather than an order two lines happen to be written in.
 */
describe("prepareAndEvaluateSegments", () => {
  function createDb(definitionsAfterSeed: Array<{ id: string; definition: string }>) {
    const calls: string[] = [];
    const db = {
      _calls: calls,
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => {
            calls.push("seed");
            return Promise.resolve();
          },
          onConflictDoUpdate: () => {
            calls.push("seed");
            return Promise.resolve();
          },
        }),
      }),
      select: () => ({
        from: () => {
          calls.push("read-definitions");
          return Promise.resolve(definitionsAfterSeed);
        },
      }),
      transaction: async (cb: (tx: unknown) => unknown) => {
        calls.push("count");
        return cb({ execute: async () => [{ count: 7 }] });
      },
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    };
    return db as unknown as Db & { _calls: string[] };
  }

  /**
   * Both halves, and the first one matters more.
   *
   * Mutation testing caught this: replacing the seed with
   * `false ? await seedSegments(db) : SEED_SEGMENTS.length` left the ordering
   * assertion green, because `indexOf` returns -1 when the call never
   * happened and -1 is less than every real index. The test for "seeds before
   * it evaluates" passed on a version that never seeded at all — which is
   * precisely the bug #50 is about, surviving its own regression test.
   */
  it("actually seeds", async () => {
    const db = createDb([{ id: "teachers", definition: "is_subscriber = 1" }]);
    await prepareAndEvaluateSegments(db, NOW);
    expect(db._calls).toContain("seed");
  });

  it("seeds before it reads the definitions, not after", async () => {
    const db = createDb([{ id: "teachers", definition: "is_subscriber = 1" }]);
    await prepareAndEvaluateSegments(db, NOW);
    const seedAt = db._calls.indexOf("seed");
    const readAt = db._calls.indexOf("read-definitions");
    // -1 is less than every index, so the ordering check is meaningless until
    // both calls are known to have happened.
    expect(seedAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(seedAt).toBeLessThan(readAt);
  });

  it("evaluates what it seeded and reports both", async () => {
    const db = createDb([
      { id: "teachers", definition: "is_subscriber = 1" },
      { id: "high_value", definition: "lifetime_orders > 3" },
    ]);
    const r = await prepareAndEvaluateSegments(db, NOW);
    expect(r.seeded).toBe(SEED_SEGMENTS.length);
    expect(r.defined).toBe(2);
    expect(r.evaluated).toBe(2);
    expect(r.problem).toBeNull();
  });

  /**
   * The assertion this issue exists for. A count of nothing over a table that
   * should hold rows is an unrun check, not a clean one — so it comes back as a
   * value the caller has to handle, not a zero it can read past.
   */
  it("reports an empty table as a problem, not as a clean run", async () => {
    const db = createDb([]);
    const r = await prepareAndEvaluateSegments(db, NOW);
    expect(r.defined).toBe(0);
    expect(r.evaluated).toBe(0);
    expect(r.problem).toBeTruthy();
    expect(r.problem).toMatch(/no segment/i);
  });

  it("distinguishes an empty table from one whose evaluations all failed", async () => {
    const empty = await prepareAndEvaluateSegments(createDb([]), NOW);
    const broken = await prepareAndEvaluateSegments(
      createDb([{ id: "bad", definition: "1=1; DROP TABLE shopify_customers" }]),
      NOW
    );
    expect(broken.defined).toBe(1);
    expect(broken.failed).toBe(1);
    expect(broken.problem).toBeTruthy();
    // Both are problems. They are not the same problem and call for different fixes.
    expect(broken.problem).not.toBe(empty.problem);
  });
});

/**
 * The call site. A function defined and tested with no caller passes forever —
 * that is the whole of #50, and asserting `seedSegments` in isolation is what
 * let it happen.
 */
describe("worker segment wiring", () => {
  const workerSource = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");

  it("calls prepareAndEvaluateSegments", () => {
    expect(workerSource).toMatch(/prepareAndEvaluateSegments\s*\(\s*db\b/);
  });

  // Calling the bare evaluator again would reintroduce the unseeded path.
  it("no longer calls the evaluator without seeding first", () => {
    expect(workerSource).not.toMatch(/\bevaluateSegments\s*\(/);
  });

  // A problem logged through the same channel as the success reads as routine.
  it("routes the empty-table case through console.error", () => {
    // Anchored on the call, not the import — the import line matches the name
    // too, and a test that passes by matching an import proves nothing.
    const block = workerSource.match(/prepareAndEvaluateSegments\s*\(\s*db\b[\s\S]{0,700}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\.problem/);
    expect(block![0]).toMatch(/console\.error/);
  });
});

/**
 * ─── Lifetime spend is a different column (#76) ───────────────────────
 *
 * `high_value` ranked on `subscription_revenue_cents + one_off_revenue_cents`,
 * which the customer rollup derives from `shopify_orders` — and that table
 * begins 2025-07-22. So it ranked fourteen months of a three-year history.
 *
 * The consequences, measured against production:
 *
 *   buyers with a figure      8,483  vs  41,937 in shopify_total_spent_cents
 *   total revenue          $512,551  vs  $3,699,920
 *   largest customer           $463  vs  $6,885
 *
 * On top of that the percentile was computed over all 99,292 rows, 91% of
 * which have never bought — so the 90th percentile was £0 and the segment
 * matched every customer in the database. It was a valid `segmentId` for
 * `segment_push`, which made it a loaded gun next to a live send channel.
 *
 * Shopify's own lifetime total was synced and sitting unused the whole time.
 */
describe("high_value ranks on real lifetime spend", () => {
  const highValue = SEED_SEGMENTS.find((s) => s.id === "high_value")!;

  it("uses Shopify's lifetime total, not the order-window rollup", () => {
    expect(highValue.definition).toContain("shopify_total_spent_cents");
    expect(highValue.definition).not.toContain("subscription_revenue_cents");
    expect(highValue.definition).not.toContain("one_off_revenue_cents");
  });

  /**
   * A level, not a rank. Matt's call: "3,726 customers over $250, up from
   * 3,400" is a fact you can act on; "4,195 customers, being 10%" is 10% every
   * year by construction and says nothing.
   */
  it("is a fixed spending level rather than a percentile", () => {
    expect(highValue.definition).toContain("25000");
    expect(highValue.definition).not.toMatch(/percentile_cont/);
  });

  // The old name promised a decile and delivered the whole database.
  it("does not describe itself as a decile", () => {
    expect(highValue.name.toLowerCase()).not.toContain("decile");
  });

  it("says what the threshold is, so the number is arguable rather than magic", () => {
    expect(highValue.notes).toMatch(/250/);
  });

  /**
   * The guard for the rest of the sweep. The derived revenue columns are the
   * right ones for the subscription/one-off split — that is what they exist
   * for — but they are not lifetime totals, and a segment is exactly where
   * that gets forgotten.
   */
  it("uses no order-window revenue column in any segment definition", () => {
    for (const s of SEED_SEGMENTS) {
      expect(s.definition, `${s.id} ranks on a column that only covers orders since 2025-07-22`)
        .not.toMatch(/subscription_revenue_cents|one_off_revenue_cents/);
    }
  });
});

/**
 * ─── The seed has to be able to correct itself ────────────────────────
 *
 * `seedSegments` used `onConflictDoNothing`, justified as "a definition someone
 * has edited is the one they meant". Nothing can edit one. The only writes to
 * this table anywhere are `member_count`, `last_evaluated_at` and
 * `last_evaluation_error` — the definition column has exactly one author, this
 * file.
 *
 * So the protection guarded nothing and cost everything: fixing `high_value`
 * in code left the database evaluating the old definition forever. The
 * evaluator read 99,292 from the stored row while `segment_push_dry_run` read
 * 3,552 from `SEED_SEGMENTS` — the same segment, two answers, and the pushable
 * one silently correct while the reported one stayed wrong.
 *
 * A docstring claiming a capability that does not exist is the thing CLAUDE.md
 * warns about; this is what it costs.
 */
describe("seedSegments keeps stored definitions in step with the code", () => {
  function createSeedDb() {
    const conflictActions: string[] = [];
    const updated: unknown[] = [];
    const db = {
      _conflictActions: conflictActions,
      _updated: updated,
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => {
            conflictActions.push("nothing");
            return Promise.resolve();
          },
          onConflictDoUpdate: (arg: unknown) => {
            conflictActions.push("update");
            updated.push(arg);
            return Promise.resolve();
          },
        }),
      }),
    };
    return db as unknown as Db & { _conflictActions: string[]; _updated: unknown[] };
  }

  it("updates an existing row rather than leaving it stale", async () => {
    const db = createSeedDb();
    await seedSegments(db);
    expect(db._conflictActions).toEqual(["update"]);
  });

  // Inspecting the keys rather than serialising: drizzle column objects hold a
  // circular table reference and JSON.stringify throws on them.
  const updatedFields = (db: { _updated: unknown[] }) =>
    Object.keys((db._updated[0] as { set: Record<string, unknown> }).set);

  it("refreshes the definition, which is the field that was going stale", async () => {
    const db = createSeedDb();
    await seedSegments(db);
    expect(updatedFields(db)).toContain("definition");
  });

  /**
   * Evaluation results are NOT part of the seed, so re-seeding must not wipe
   * them — that would make every deploy look like the evaluator had never run.
   */
  it("does not overwrite evaluation results", async () => {
    const db = createSeedDb();
    await seedSegments(db);
    const fields = updatedFields(db);
    expect(fields).not.toContain("memberCount");
    expect(fields).not.toContain("lastEvaluatedAt");
    expect(fields).not.toContain("lastEvaluationError");
  });
});
