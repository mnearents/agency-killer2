import { describe, it, expect, vi } from "vitest";
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

  // ~329 Color Happy rows carry the bulk-import date as order_placed, so tenure
  // and time-since-cancellation computed over them is fiction.
  it("excludes bulk-imported subscriptions from the lapsed segment", () => {
    const lapsed = SEED_SEGMENTS.find((s) => s.id === "rad_subscribers_lapsed")!;
    expect(lapsed.definition).toContain("manual_origin");
    expect(lapsed.notes).toMatch(/manual|import/i);
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

  const db = {
    _updates: updates,
    select: () => ({ from: () => Promise.resolve(rows) }),
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
  return db as unknown as Db & { _updates: Array<Record<string, unknown>> };
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
