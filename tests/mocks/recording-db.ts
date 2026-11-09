import { getTableName } from "drizzle-orm";

/**
 * A database that records writes by table and answers every read with the
 * rows seeded for the table it reads FROM — joins and filters are not
 * applied, so seed only what the read under test should see.
 */
export type Write = { table: string; values: Record<string, unknown>; set?: Record<string, unknown> };

export function fakeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const inserts: Write[] = [];
  const updates: Write[] = [];
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["where", "limit", "orderBy", "leftJoin", "innerJoin"]) c[m] = () => c;
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(rows()).then(res, rej);
    return c;
  };
  const db = {
    select: () => ({
      from: (t: Parameters<typeof getTableName>[0]) => chain(() => seed[getTableName(t)] ?? []),
    }),
    insert: (t: Parameters<typeof getTableName>[0]) => ({
      values: (values: Record<string, unknown>) => {
        const w: Write = { table: getTableName(t), values };
        inserts.push(w);
        const done = Promise.resolve();
        return {
          onConflictDoUpdate: async (o: { set: Record<string, unknown> }) => { w.set = o.set; },
          then: done.then.bind(done),
        };
      },
    }),
    update: (t: Parameters<typeof getTableName>[0]) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { updates.push({ table: getTableName(t), values }); },
      }),
    }),
  };
  return { db: db as never, inserts, updates };
}

