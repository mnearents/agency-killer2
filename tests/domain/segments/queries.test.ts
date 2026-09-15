/**
 * `getSegmentMembers` joins the analytics view back to the base table to get an
 * address the view deliberately does not carry.
 *
 * The join key is the bug this file exists for. `shopify_customers.id` is a
 * Shopify GID — `gid://shopify/Customer/5026484650136` — while
 * `analytics.customers.customer_id` is the bare numeric id. Joining on the
 * wrong one matches nothing, and the tool reported
 *
 *     "The segment matched nobody, so there is nothing to push."
 *
 * for a segment holding 15,383 people. That is indistinguishable from a
 * correct empty result, and no unit test could have caught it: every one of
 * them mocks this function. It was found by running against production.
 *
 * So the guard is in the function itself. It counts the predicate separately
 * from the join, and a predicate that matched people while the join yielded
 * nobody is reported as a fault rather than as an empty segment — those need
 * opposite responses.
 */

import { describe, it, expect, vi } from "vitest";
import { getSegmentMembers } from "@/domain/segments/queries";
import type { Db } from "@/db/client";

/**
 * `execute` is called twice: once to count the predicate, once for the join.
 * Returning different results for each is how the mismatch is simulated.
 */
function createDb(results: Array<unknown>) {
  const queries: string[] = [];
  let call = 0;
  const db = {
    _queries: queries,
    transaction: async (cb: (tx: unknown) => unknown) =>
      cb({
        execute: async (q: unknown) => {
          queries.push(JSON.stringify(q));
          return results[Math.min(call++, results.length - 1)];
        },
      }),
  };
  return db as unknown as Db & { _queries: string[] };
}

const PREDICATE = "c.is_subscriber = 1";

describe("getSegmentMembers", () => {
  it("returns the addresses the segment covers", async () => {
    const db = createDb([[{ count: 2 }], [{ email: "B@X.com" }, { email: "a@x.com" }]]);
    const r = await getSegmentMembers(db, PREDICATE);
    expect(r.error).toBeNull();
    expect(r.emails).toEqual(["a@x.com", "b@x.com"]);
  });

  it("normalises and deduplicates addresses", async () => {
    const db = createDb([[{ count: 3 }], [{ email: " A@X.com " }, { email: "a@x.com" }, { email: "b@x.com" }]]);
    expect((await getSegmentMembers(db, PREDICATE)).emails).toEqual(["a@x.com", "b@x.com"]);
  });

  /**
   * The regression. A predicate that matched 15,383 people and a join that
   * produced none is a broken join, and saying "the segment matched nobody"
   * sends someone looking at the data instead of the query.
   */
  it("reports a fault when the predicate matched people but the join produced none", async () => {
    const db = createDb([[{ count: 15383 }], []]);
    const r = await getSegmentMembers(db, PREDICATE);
    expect(r.emails).toEqual([]);
    expect(r.error).toBeTruthy();
    expect(r.error).toMatch(/15383/);
    expect(r.error).toMatch(/join/i);
  });

  // A genuinely empty segment is not a fault, and must not be reported as one.
  it("reports a genuinely empty segment as empty, with no error", async () => {
    const db = createDb([[{ count: 0 }], []]);
    const r = await getSegmentMembers(db, PREDICATE);
    expect(r.emails).toEqual([]);
    expect(r.matched).toBe(0);
    expect(r.error).toBeNull();
  });

  // Consent filtering legitimately drops people, so a partial drop is fine.
  it("does not treat a partial drop as a fault", async () => {
    const db = createDb([[{ count: 10 }], [{ email: "a@x.com" }]]);
    const r = await getSegmentMembers(db, PREDICATE);
    expect(r.error).toBeNull();
    expect(r.matched).toBe(10);
    expect(r.emails).toHaveLength(1);
  });

  it("joins on the GID column, because that is what the base table keys on", async () => {
    const db = createDb([[{ count: 1 }], [{ email: "a@x.com" }]]);
    await getSegmentMembers(db, PREDICATE);
    const joinQuery = db._queries[1];
    expect(joinQuery).toContain("customer_gid");
    expect(joinQuery).not.toMatch(/sc\.id = c\.customer_id/);
  });

  it("refuses an unsafe predicate rather than interpolating it", async () => {
    const db = createDb([[{ count: 0 }], []]);
    const r = await getSegmentMembers(db, "1=1; DROP TABLE shopify_customers");
    expect(r.error).toMatch(/unsafe/i);
    expect(db._queries).toHaveLength(0);
  });

  it("returns a read failure rather than an empty list that looks like a result", async () => {
    const db = {
      transaction: vi.fn().mockRejectedValue(new Error("connection reset")),
    } as unknown as Db;
    const r = await getSegmentMembers(db, PREDICATE);
    expect(r.emails).toEqual([]);
    expect(r.error).toMatch(/connection reset/);
  });
});
