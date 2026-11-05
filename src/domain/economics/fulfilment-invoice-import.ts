/**
 * Stores parsed 3PL and carrier invoices in `fulfilment_invoices`.
 *
 * Re-importing a file replaces that invoice's rows, so loading the same
 * folder twice cannot double a bill.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { fulfilmentInvoices, fulfilmentInvoiceFiles } from "@/db/schema";
import { isShippingOnlyInvoice, normaliseInvoiceDate, type ThreeplInvoice } from "./parse-threepl-invoice";
import { isCarrierInvoice, type CarrierInvoice } from "./parse-carrier-invoice";

export type NewInvoiceRow = typeof fulfilmentInvoices.$inferInsert;

export function evoboxInvoiceRows(inv: ThreeplInvoice, sourceFile: string): NewInvoiceRow[] {
  if (!inv.servicePeriod) {
    throw new Error(`Invoice ${inv.invoiceNumber} has no service period and no dated lines, so it cannot be placed against the orders it served.`);
  }
  const { start, end, inferred } = inv.servicePeriod;
  return inv.lines.map((l) => ({
    source: "evobox",
    invoiceNumber: inv.invoiceNumber,
    issued: inv.invoiceDate,
    periodStart: start,
    periodEnd: end,
    periodInferred: inferred ? 1 : 0,
    category: l.category,
    carrier: null,
    shipments: null,
    amountCents: l.amountCents,
    sourceFile,
  }));
}

export function carrierInvoiceRows(inv: CarrierInvoice, sourceFile: string): NewInvoiceRow[] {
  return inv.carriers.map((c) => ({
    source: "carrier",
    invoiceNumber: inv.invoiceNumber,
    issued: inv.issued,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    periodInferred: 0,
    category: "postage",
    carrier: c.carrier,
    shipments: c.shipments,
    amountCents: c.amountCents,
    sourceFile,
  }));
}

/** Replaces every stored row for the invoice with `rows`, in one transaction. */
export async function storeInvoiceRows(db: Db, rows: NewInvoiceRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { source, invoiceNumber } = rows[0];
  await db.transaction(async (tx) => {
    await tx.delete(fulfilmentInvoices).where(and(eq(fulfilmentInvoices.source, source), eq(fulfilmentInvoices.invoiceNumber, invoiceNumber)));
    await tx.insert(fulfilmentInvoices).values(rows);
  });
  return rows.length;
}

/**
 * Which of the three PDFs this is: the weekly carrier label invoice, Evobox's
 * weekly "Shipping" invoice (the same postage bill in one line), or a
 * fortnightly fulfilment bill.
 */
export function classifyInvoicePdf(lines: string[]): "carrier" | "shipping" | "evobox" {
  if (isCarrierInvoice(lines)) return "carrier";
  if (isShippingOnlyInvoice(lines)) return "shipping";
  return "evobox";
}

const DAY = 86_400_000;

/**
 * Evobox's weekly "Shipping" invoice as postage. It is the same bill as the
 * week's carrier invoice — 20621 and the Aug 31-Sep 6 carrier invoice are both
 * $178.63 — and it covers Monday to Sunday of the week before its date. It has
 * no carrier breakdown and no shipment count.
 */
export function shippingInvoiceRows(lines: string[], sourceFile: string): NewInvoiceRow[] {
  const joined = lines.join("\n");
  const number = joined.match(/Invoice\s*no\.?:?\s*(\S+)/i)?.[1];
  const issued = normaliseInvoiceDate(joined.match(/Invoice\s*date:?\s*([\d/]+)/i)?.[1] ?? null);
  if (!number || !issued) throw new Error("A Shipping invoice needs an invoice number and date.");
  const item = lines.map((l) => l.match(/^\s*\d+\.\s+Shipping\s+\$?([\d,]+\.\d{2})\s*$/i)).find(Boolean);
  const totalIdx = lines.findIndex((l) => /^\s*Total\s*$/i.test(l));
  const cents = (s: string | undefined) => (s === undefined ? null : Math.round(Number(s.replace(/[$,]/g, "")) * 100));
  const amount = cents(item?.[1]);
  const total = cents(lines[totalIdx + 1]?.match(/\$?([\d,]+\.\d{2})/)?.[1]);
  if (amount === null || amount !== total) {
    throw new Error(`Shipping invoice ${number} does not add up: line ${amount} against total ${total}.`);
  }
  // The week ending the Sunday before the invoice date.
  const issuedAt = Date.parse(`${issued}T00:00:00Z`);
  const daysSinceSunday = new Date(issuedAt).getUTCDay() || 7;
  const end = new Date(issuedAt - daysSinceSunday * DAY);
  const start = new Date(end.getTime() - 6 * DAY);
  return [{
    source: "evobox-shipping",
    invoiceNumber: number,
    issued,
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
    periodInferred: 1,
    category: "postage",
    carrier: null,
    shipments: null,
    amountCents: amount,
    sourceFile,
  }];
}

/** What the Drive folder sync has already read, by Drive file ID. */
export async function getKnownInvoiceFiles(db: Db): Promise<Map<string, { md5: string | null; modifiedTime: string; outcome: string }>> {
  const rows = await db.select().from(fulfilmentInvoiceFiles);
  return new Map(rows.map((r) => [r.driveFileId, { md5: r.md5, modifiedTime: r.modifiedTime, outcome: r.outcome }]));
}

export async function recordInvoiceFile(
  db: Db,
  file: { id: string; name: string; md5Checksum?: string; modifiedTime: string },
  outcome: "imported" | "failed",
  detail?: string,
  kind?: string,
  invoiceNumber?: string,
): Promise<void> {
  const row = {
    driveFileId: file.id, name: file.name, md5: file.md5Checksum ?? null, modifiedTime: file.modifiedTime,
    outcome, kind: kind ?? null, invoiceNumber: invoiceNumber ?? null, detail: detail ?? null, processedAt: new Date(),
  };
  await db.insert(fulfilmentInvoiceFiles).values(row).onConflictDoUpdate({ target: fulfilmentInvoiceFiles.driveFileId, set: row });
}
