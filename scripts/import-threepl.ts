/**
 * Imports a 3PL charge export (#34).
 *
 *   pnpm threepl:import <file.csv>              # dry run, writes nothing
 *   pnpm threepl:import <file.csv> --write      # import
 *
 * Dry run is the default because the import replaces a bill by its number,
 * and seeing the plan before replacing 201 rows is cheap.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { inArray } from "drizzle-orm";
import { createDb } from "@/db/client";
import { shopifyOrders } from "@/db/schema";
import { parseThreeplChargeCsv } from "@/domain/economics/parse-threepl-csv";
import { planThreeplImport, importThreeplCharges } from "@/domain/economics/threepl-import";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function main() {
  const file = process.argv[2];
  const write = process.argv.includes("--write");
  if (!file) {
    console.error("usage: pnpm threepl:import <file.csv> [--write]");
    process.exit(1);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const db = createDb(databaseUrl);
  const content = readFileSync(file, "utf8");

  if (write) {
    const result = await importThreeplCharges(db, content, { sourceFile: basename(file) });
    report(result, true);
    return;
  }

  const parsed = parseThreeplChargeCsv(content);
  const referenced = [
    ...new Set(parsed.rows.map((r) => r.orderNumber).filter((o): o is string => o !== null)),
  ];
  const known =
    referenced.length === 0
      ? []
      : (
          await db
            .select({ orderNumber: shopifyOrders.orderNumber })
            .from(shopifyOrders)
            .where(inArray(shopifyOrders.orderNumber, referenced))
        )
          .map((f) => f.orderNumber)
          .filter((o): o is string => o !== null);

  const planned = planThreeplImport({
    parsed,
    knownOrderNumbers: known,
    existingRowCount: 0,
    sourceFile: basename(file),
  });
  if (!planned.ok) {
    console.error(`REFUSED: ${planned.error}`);
    process.exit(1);
  }
  report(planned.plan.result, false);
}

function report(r: Awaited<ReturnType<typeof importThreeplCharges>>, wrote: boolean) {
  console.log(`\nBill ${r.billNumber}   ${r.periodStart} .. ${r.periodEnd}`);
  console.log(`${r.rowsParsed} charge rows   ${money(r.totalCents)}\n`);
  for (const c of r.byCategory) {
    console.log(`  ${c.category.padEnd(14)} ${String(c.rows).padStart(4)} rows  ${money(c.cents).padStart(10)}`);
  }
  console.log(
    `\norders: ${r.orders.matched}/${r.orders.referenced} matched in shopify_orders` +
      `   (reference column: ${r.orderColumn.chosen ?? "none"})`,
  );
  if (r.recurringFound.length > 0) {
    console.log(`recurring charges found: ${r.recurringFound.map((x) => `${x.fee} ${money(x.cents)}`).join(", ")}`);
  }
  for (const w of r.warnings) console.log(`\n  ! ${w}`);
  console.log(
    wrote
      ? `\nwritten: ${r.inserted} rows inserted${r.replaced > 0 ? `, ${r.replaced} replaced` : ""}.`
      : `\ndry run — nothing written. Re-run with --write to import.`,
  );
}

// The Drizzle client holds an open pool, so the process would otherwise sit
// there after printing. Exiting explicitly keeps this usable from a terminal.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
