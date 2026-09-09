import { describe, it, expect, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  SEED_SEGMENTS,
  assertSafePredicate,
  evaluateSegments,
  seedSegments,
} from "@/domain/shopify/segments";
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

  // A definition someone edited is the one they want. Overwriting it on every
  // deploy would silently revert an argued-over predicate to the shipped guess.
  it("does not overwrite a definition that already exists", async () => {
    const db = createSeedDb();
    await seedSegments(db);
    expect(db._conflictActions).toEqual(["nothing"]);
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
