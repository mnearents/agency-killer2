/**
 * One-time backfill of Shopify customer IDs onto seal_subscriptions.
 *
 * The Seal list endpoint omits `customer_id` entirely; only the
 * single-subscription endpoint carries it. That makes this one request per
 * subscription — ~4,390 of them — which is why it is a script you run once
 * rather than part of the daily sync. After this runs, the daily sync only
 * looks up subscriptions it has never seen, which is a handful a day.
 *
 * Resumable: it only fetches rows where customer_id_checked_at is null, so a
 * run killed halfway can simply be run again.
 *
 *   DATABASE_URL=... SEAL_API_TOKEN=... pnpm tsx scripts/backfill-seal-customer-ids.ts
 *   ... --limit 100    fetch at most 100 (a dry-ish run to sanity check first)
 */

import { isNull, sql } from "drizzle-orm";
import { createDb } from "@/db/client";
import { sealSubscriptions } from "@/db/schema";
import { createSealApiClient } from "@/integrations/seal-api";

// Seal's documented ceiling is 10 concurrent requests. Eight leaves headroom
// for anything else talking to the API while this runs.
const CONCURRENCY = 8;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

function parseLimit(argv: string[]): number | null {
  const i = argv.indexOf("--limit");
  if (i === -1) return null;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--limit needs a positive integer, got "${argv[i + 1]}"`);
  }
  return n;
}

async function main() {
  const limit = parseLimit(process.argv);
  const db = createDb(requireEnv("DATABASE_URL"));
  const client = createSealApiClient({ apiToken: requireEnv("SEAL_API_TOKEN") });

  const pending = await db
    .select({ id: sealSubscriptions.id })
    .from(sealSubscriptions)
    .where(isNull(sealSubscriptions.customerIdCheckedAt));

  const todo = limit ? pending.slice(0, limit) : pending;
  console.log(
    `${pending.length} subscriptions have never been checked` +
      (limit ? `; fetching ${todo.length} (--limit ${limit})` : "")
  );
  if (todo.length === 0) return;

  let done = 0;
  let found = 0;
  let missing = 0;
  const failures: string[] = [];

  // A shared cursor rather than fixed slices, so one slow subscription does
  // not idle a worker for the rest of the run.
  let cursor = 0;
  async function worker() {
    while (cursor < todo.length) {
      const { id } = todo[cursor++];
      try {
        const customerId = await client.getSubscriptionCustomerId(id);
        await db
          .update(sealSubscriptions)
          .set({ customerId, customerIdCheckedAt: new Date() })
          .where(sql`${sealSubscriptions.id} = ${id}`);
        if (customerId) found++;
        else missing++;
      } catch (err) {
        // Left unchecked so a re-run picks it up rather than recording a
        // failed lookup as "this subscription has no customer".
        failures.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      done++;
      if (done % 250 === 0) console.log(`  ${done}/${todo.length}...`);
    }
  }

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\ndone in ${elapsed}s`);
  console.log(`  customer id found:   ${found}`);
  console.log(`  no customer on Seal: ${missing}`);
  console.log(`  failed (left unchecked, re-run to retry): ${failures.length}`);
  for (const f of failures.slice(0, 10)) console.log(`    ${f}`);

  // The number that decides whether any LTV work is possible. Reported from
  // the database rather than from what this run happened to touch.
  const [joined] = await db.execute<{
    total: string;
    with_customer: string;
    joined: string;
  }>(sql`
    SELECT
      COUNT(*)::text AS total,
      COUNT(s.customer_id)::text AS with_customer,
      COUNT(o.customer_id)::text AS joined
    FROM seal_subscriptions s
    LEFT JOIN LATERAL (
      SELECT DISTINCT split_part(o.customer_id, '/', 5) AS customer_id
      FROM shopify_orders o
      WHERE split_part(o.customer_id, '/', 5) = s.customer_id
      LIMIT 1
    ) o ON true
  `);

  const total = Number(joined.total);
  const withCustomer = Number(joined.with_customer);
  const hit = Number(joined.joined);
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

  console.log(`\n─── join against shopify_orders ───`);
  console.log(`  seal subscriptions:            ${total}`);
  console.log(`  with a Seal customer_id:       ${withCustomer} (${pct(withCustomer)})`);
  console.log(`  matching a Shopify customer:   ${hit} (${pct(hit)})`);

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
