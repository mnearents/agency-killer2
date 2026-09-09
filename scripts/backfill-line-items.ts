/**
 * One-time historical re-crawl of Shopify orders, for the line-item fields.
 *
 * `shopify_line_items` holds 58,544 rows across 54,213 orders back to
 * 2025-07-22, but every one of them predates the four columns added for
 * per-product net revenue: total_discount_cents, requires_shipping, vendor,
 * variant_title. Shopify has no patch endpoint and the stored raw_json never
 * contained those fields, so the only way to fill them is to ask for the
 * orders again. This does that once, month by month.
 *
 * Resumable: every month writes a `sync_runs` row, and a re-run skips months
 * already recorded as ok or no-data. If a throttle stops it, run it again.
 *
 * The current month is deliberately left out: the daily `sync:shopify` task
 * re-upserts a rolling 30 days and now writes the new columns itself, so
 * crawling it here would only duplicate work — and recording a partial month
 * as complete would stop the next run finishing it.
 *
 *   DATABASE_URL=... SHOPIFY_STORE_DOMAIN=... SHOPIFY_ACCESS_TOKEN=... \
 *     pnpm tsx scripts/backfill-line-items.ts
 *   ... --start 2025-09-01 --end 2025-11-01   narrow the window (end exclusive)
 */

import { createDb } from "@/db/client";
import { createShopifyApiClient } from "@/integrations/shopify-api";
import { backfillOrders } from "@/domain/shopify/backfill";

/** The earliest order in the table. */
const DEFAULT_START = "2025-07-22";

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

/** First day of the current month — the exclusive upper bound. */
function currentMonthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .split("T")[0];
}

async function main() {
  const argv = process.argv;
  const startDate = parseDate(argv, "--start", DEFAULT_START);
  const endDate = parseDate(argv, "--end", currentMonthStart());

  const db = createDb(requireEnv("DATABASE_URL"));
  const client = createShopifyApiClient(
    requireEnv("SHOPIFY_STORE_DOMAIN"),
    requireEnv("SHOPIFY_ACCESS_TOKEN")
  );

  console.log(`re-crawling orders ${startDate} → ${endDate} (end exclusive)`);
  const result = await backfillOrders({ client, db, startDate, endDate });

  for (const w of result.windows) {
    console.log(
      `  ${w.since} → ${w.until}  ${w.outcome.padEnd(13)} ${w.orders} orders`
    );
  }

  console.log(`\nmonths completed: ${result.windowsCompleted}`);
  console.log(`months skipped (already done): ${result.windowsSkipped}`);
  console.log(`orders: ${result.orders}, line items: ${result.lineItems}`);

  if (result.stoppedEarly) {
    console.error(
      `\nSTOPPED EARLY — ${result.outcome}. Remaining months were not attempted.` +
        `\nRe-run to resume; completed months will be skipped.`
    );
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
