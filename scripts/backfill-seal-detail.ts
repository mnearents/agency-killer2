/**
 * One-time backfill of the fields that exist only on Seal's single-subscription
 * endpoint: customer_id, log and tags.
 *
 * Supersedes backfill-seal-customer-ids.ts. That script crawled all ~4,390
 * records for customer_id alone and discarded the rest of the payload; the log
 * it threw away is the only surviving record of tier changes that predate our
 * daily snapshots (which start 2026-09-02). Since an upgrade edits the
 * subscription in place, nothing else in the data distinguishes a subscriber
 * who moved Spark→Studio from one who signed up as Studio.
 *
 * Resumable: only fetches rows where detail_checked_at is null, so a run killed
 * halfway can simply be run again. That column is deliberately separate from
 * customer_id_checked_at, which is already set on every row by the earlier
 * backfill and would make this crawl a no-op.
 *
 *   DATABASE_URL=... SEAL_API_TOKEN=... pnpm tsx scripts/backfill-seal-detail.ts
 *   ... --limit 100    fetch at most 100 (a sanity check before the full run)
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
    .where(isNull(sealSubscriptions.detailCheckedAt));

  const todo = limit ? pending.slice(0, limit) : pending;
  console.log(
    `${pending.length} subscriptions have no detail captured` +
      (limit ? `; fetching ${todo.length} (--limit ${limit})` : "")
  );
  if (todo.length === 0) return;

  let done = 0;
  let withLog = 0;
  let emptyLog = 0;
  let nullLog = 0;
  const failures: string[] = [];

  // A shared cursor rather than fixed slices, so one slow subscription does
  // not idle a worker for the rest of the run.
  let cursor = 0;
  async function worker() {
    while (cursor < todo.length) {
      const { id } = todo[cursor++];
      try {
        const detail = await client.getSubscriptionDetail(id);
        await db
          .update(sealSubscriptions)
          .set({
            customerId: detail.customerId,
            customerIdCheckedAt: new Date(),
            log: detail.log,
            tags: detail.tags,
            detailCheckedAt: new Date(),
          })
          .where(sql`${sealSubscriptions.id} = ${id}`);

        if (detail.log === null) nullLog++;
        else if (detail.log.length === 0) emptyLog++;
        else withLog++;
      } catch (err) {
        // Left unchecked so a re-run picks it up, rather than recording a
        // failed lookup as "this subscription has no log".
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
  console.log(`  with log entries:      ${withLog}`);
  console.log(`  empty log (untouched): ${emptyLog}`);
  console.log(`  log field absent:      ${nullLog}`);
  console.log(`  failed (left unchecked, re-run to retry): ${failures.length}`);
  for (const f of failures.slice(0, 10)) console.log(`    ${f}`);

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
