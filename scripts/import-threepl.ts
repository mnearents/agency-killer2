/**
 * Imports 3PL data (#34). Detects which of the three file types it was given
 * rather than making the caller remember three commands:
 *
 *   pnpm threepl:import <charges.csv>     # the charge ledger
 *   pnpm threepl:import <shipments.csv>   # the shipping label export
 *   pnpm threepl:import <invoice.pdf>     # the invoice, reconciled against the ledger
 *   ... --write                           # actually write; dry run is the default
 *   pnpm threepl:import <directory>       # every file in it, in dependency order
 *
 * Dry run is the default because a charge import replaces a whole bill.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, extname } from "node:path";
import { inArray, eq } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import { shopifyOrders, threeplCharges } from "@/db/schema";
import { parseThreeplChargeCsv } from "@/domain/economics/parse-threepl-csv";
import { planThreeplImport, importThreeplCharges } from "@/domain/economics/threepl-import";
import { parseShipmentsCsv } from "@/domain/economics/parse-shipments-csv";
import { planShipmentImport, importShipments } from "@/domain/economics/shipments-import";
import { pdfToLines } from "@/domain/economics/pdf-text";
import { parseInvoiceLines, reconcileInvoice } from "@/domain/economics/parse-threepl-invoice";

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export type FileKind = "charges" | "shipments" | "invoice" | "unknown";

/**
 * What kind of file this is, from its own content rather than its name. The
 * exports are named by timestamp and hash, so the filename says nothing.
 */
export function detectFileKind(path: string, firstLine: string): FileKind {
  if (extname(path).toLowerCase() === ".pdf") return "invoice";
  if (firstLine.includes("Shipping Label ID")) return "shipments";
  if (firstLine.includes("Date (charge)")) return "charges";
  return "unknown";
}

/** Invoices last: reconciliation needs the ledger already loaded. */
export function importOrder(kinds: { path: string; kind: FileKind }[]): { path: string; kind: FileKind }[] {
  const rank: Record<FileKind, number> = { charges: 0, shipments: 1, invoice: 2, unknown: 3 };
  return [...kinds].sort((a, b) => rank[a.kind] - rank[b.kind] || a.path.localeCompare(b.path));
}

async function knownOrders(db: Db, referenced: string[]): Promise<string[]> {
  if (referenced.length === 0) return [];
  const found = await db
    .select({ orderNumber: shopifyOrders.orderNumber })
    .from(shopifyOrders)
    .where(inArray(shopifyOrders.orderNumber, referenced));
  return found.map((f) => f.orderNumber).filter((o): o is string => o !== null);
}

async function doCharges(db: Db, path: string, write: boolean) {
  const content = readFileSync(path, "utf8");
  if (write) return report(await importThreeplCharges(db, content, { sourceFile: basename(path) }), true);

  const parsed = parseThreeplChargeCsv(content);
  const referenced = [...new Set(parsed.rows.map((r) => r.orderNumber).filter((o): o is string => o !== null))];
  const planned = planThreeplImport({
    parsed,
    knownOrderNumbers: await knownOrders(db, referenced),
    existingRowCount: 0,
    sourceFile: basename(path),
  });
  if (!planned.ok) throw new Error(planned.error);
  report(planned.plan.result, false);
}

function report(r: Awaited<ReturnType<typeof importThreeplCharges>>, wrote: boolean) {
  console.log(`  bill ${r.billNumber}   ${r.periodStart} .. ${r.periodEnd}`);
  console.log(`  ${r.rowsParsed} charge rows   ${money(r.totalCents)}`);
  for (const c of r.byCategory) {
    console.log(`    ${c.category.padEnd(12)} ${String(c.rows).padStart(4)} rows ${money(c.cents).padStart(10)}`);
  }
  console.log(`  orders: ${r.orders.matched}/${r.orders.referenced} matched`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
  if (wrote) console.log(`  written: ${r.inserted} rows${r.replaced > 0 ? `, ${r.replaced} replaced` : ""}.`);
}

async function doShipments(db: Db, path: string, write: boolean) {
  const content = readFileSync(path, "utf8");
  const parsed = parseShipmentsCsv(content);
  const referenced = [...new Set(parsed.rows.map((r) => r.orderNumber).filter((o): o is string => o !== null))];
  const known = await knownOrders(db, referenced);

  const r = write
    ? await importShipments(db, content, { sourceFile: basename(path) })
    : (() => {
        const p = planShipmentImport({ parsed, knownOrderNumbers: known, sourceFile: basename(path) });
        if (!p.ok) throw new Error(p.error);
        return p.plan.result;
      })();

  console.log(`  ${r.shipments} shipments   ${r.dateRange.from} .. ${r.dateRange.to}`);
  console.log(
    `  postage known on ${r.coverage.billed}/${r.coverage.shipments} ` +
      `(${(r.coverage.coverage * 100).toFixed(1)}%)   ${money(r.coverage.knownCents)}`,
  );
  console.log(`  orders: ${r.orders.matched}/${r.orders.referenced} matched`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
  if (write) console.log(`  written.`);
}

async function doInvoice(db: Db, path: string) {
  const invoice = parseInvoiceLines(await pdfToLines(new Uint8Array(readFileSync(path))));
  console.log(`  invoice ${invoice.invoiceNumber}   ${invoice.invoiceDate}   ${money(invoice.totalCents)}`);

  const ledger = await db
    .select({ category: threeplCharges.category, totalCents: threeplCharges.totalCents })
    .from(threeplCharges)
    .where(eq(threeplCharges.billNumber, invoice.invoiceNumber));

  if (ledger.length === 0) {
    console.log(`  ! no charge rows stored for bill ${invoice.invoiceNumber} — import its CSV to reconcile.`);
    return;
  }

  const byCategory = new Map<string, number>();
  for (const row of ledger) {
    const k = row.category ?? "(none)";
    byCategory.set(k, (byCategory.get(k) ?? 0) + (row.totalCents ?? 0));
  }
  const rec = reconcileInvoice(invoice, [...byCategory.entries()].map(([category, cents]) => ({ category, cents })));
  for (const c of rec.byCategory) {
    console.log(
      `    ${c.category.padEnd(12)} invoice ${money(c.invoiceCents).padStart(10)}  ` +
        `ledger ${money(c.ledgerCents).padStart(10)}  gap ${money(c.gapCents).padStart(9)}`,
    );
  }
  for (const n of rec.notes) console.log(`  ! ${n}`);
}

async function main() {
  const target = process.argv[2];
  const write = process.argv.includes("--write");
  if (!target) {
    console.error("usage: pnpm threepl:import <file.csv|file.pdf|directory> [--write]");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const db = createDb(process.env.DATABASE_URL);

  const paths = statSync(target).isDirectory()
    ? readdirSync(target)
        .filter((f) => [".csv", ".pdf"].includes(extname(f).toLowerCase()))
        .map((f) => join(target, f))
    : [target];

  const classified = paths.map((path) => ({
    path,
    kind: detectFileKind(path, extname(path).toLowerCase() === ".pdf" ? "" : readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? ""),
  }));

  for (const { path, kind } of importOrder(classified)) {
    console.log(`\n${basename(path)}  [${kind}]`);
    try {
      if (kind === "charges") await doCharges(db, path, write);
      else if (kind === "shipments") await doShipments(db, path, write);
      else if (kind === "invoice") await doInvoice(db, path);
      else console.log(`  ! not a recognised 3PL export — skipped.`);
    } catch (err) {
      console.error(`  REFUSED: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }

  console.log(write ? `\ndone.` : `\ndry run — nothing written. Re-run with --write.`);
}

// The Drizzle client holds an open pool, so the process would otherwise hang.
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
