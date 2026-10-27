import { describe, it, expect } from "vitest";
import { listFootage } from "@/domain/footage/queries";

/**
 * A query chain that answers the count with `matched` and the page with
 * however many rows remain after `offset`, and records the offset asked for.
 */
function fakeDb(matched: number) {
  const seen: { offset?: number; limit?: number } = {};
  const page = {
    where: () => page,
    orderBy: () => page,
    limit: (n: number) => { seen.limit = n; return page; },
    offset: (n: number) => { seen.offset = n; return page; },
    then: (ok: (r: unknown) => unknown) =>
      Promise.resolve(
        Array.from({ length: Math.max(0, Math.min(seen.limit ?? 0, matched - (seen.offset ?? 0))) }, () => ({})),
      ).then(ok),
  };
  let calls = 0;
  const db = {
    select: () => ({
      from: () => (calls++ === 0
        ? { where: async () => [{ matched }] }
        : page),
    }),
  };
  return { db: db as never, seen };
}

// The tool returned at most 100 of 677 clips and could not ask for the rest,
// so a whole-library question was answered from a sample.
describe("listFootage paging", () => {
  it("reads from the offset it is given", async () => {
    const { db, seen } = fakeDb(250);
    await listFootage(db, { limit: 100, offset: 200 });
    expect(seen).toEqual({ limit: 100, offset: 200 });
  });

  it("says where the next page starts while clips remain", async () => {
    const { db } = fakeDb(250);
    expect((await listFootage(db, { limit: 100, offset: 100 })).nextOffset).toBe(200);
  });

  it("says there is no next page on the last one", async () => {
    const { db } = fakeDb(250);
    expect((await listFootage(db, { limit: 100, offset: 200 })).nextOffset).toBeNull();
  });
});
