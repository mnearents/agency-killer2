/**
 * One-time historical backfill of Meta insights.
 *
 * The daily sync only looks back 7 days and first shipped months after this
 * account stopped spending, so it could never have captured the Nov 2024 –
 * Mar 2026 history. This pulls it once, month by month.
 *
 * Structure (campaigns, ad sets, ads, creatives) is synced first because the
 * insight rows are useless without names and images to hang off them.
 *
 * Resumable: every month writes a `sync_runs` row, and a re-run skips months
 * already recorded as ok or no-data. If a throttle stops it, run it again.
 *
 *   DATABASE_URL=... META_ACCESS_TOKEN=... META_AD_ACCOUNT_ID=... \
 *     pnpm tsx scripts/backfill-meta-insights.ts
 *   ... --start 2025-01-01 --end 2025-03-31   narrow the window
 *   ... --insights-only                       skip the structure sync
 */

import { createDb } from "@/db/client";
import { createMetaApiClient } from "@/integrations/meta-api";
import { backfillInsights } from "@/domain/meta/backfill";
import { syncStructure } from "@/domain/meta/sync";

// The full lifetime of this ad account: first spend Nov 2024, last Mar 2026.
const DEFAULT_START = "2024-11-01";
const DEFAULT_END = "2026-03-31";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

function parseDate(argv: string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) {
    throw new Error(`${flag} needs a YYYY-MM-DD date, got "${value}"`);
  }
  return value;
}

async function main() {
  const argv = process.argv;
  const startDate = parseDate(argv, "--start", DEFAULT_START);
  const endDate = parseDate(argv, "--end", DEFAULT_END);
  const insightsOnly = argv.includes("--insights-only");

  const db = createDb(requireEnv("DATABASE_URL"));
  const client = createMetaApiClient(requireEnv("META_ACCESS_TOKEN"));
  const accountId = requireEnv("META_AD_ACCOUNT_ID");

  if (!insightsOnly) {
    console.log("syncing structure (campaigns, ad sets, ads, creatives)...");
    const s = await syncStructure({ client, db, accountId });
    console.log(
      `  ${s.campaigns} campaigns, ${s.adSets} ad sets, ${s.ads} ads, ${s.creatives} creatives`
    );
    for (const e of s.errors) console.error(`  ! ${e}`);
    // Structure errors are reported but not fatal: insights are the point of
    // this run, and a missing creative does not invalidate a spend number.
  }

  console.log(`\nbackfilling insights ${startDate} → ${endDate}`);
  const result = await backfillInsights({ client, db, accountId, startDate, endDate });

  for (const c of result.chunks) {
    console.log(`  ${c.start} → ${c.end}  ${c.outcome.padEnd(13)} ${c.rows} rows`);
  }

  console.log(`\nmonths completed: ${result.chunksCompleted}`);
  console.log(`months skipped (already done): ${result.chunksSkipped}`);
  console.log(`rows written: ${result.rowsWritten}`);
  console.log(`attribution window: ${result.attributionWindow}`);

  if (result.stoppedEarly) {
    console.error(
      `\nSTOPPED EARLY — ${result.outcome}. Remaining months were not attempted.` +
        `\nFix the cause and re-run; completed months will be skipped.`
    );
    process.exit(1);
  }

  console.log("\ncomplete.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
