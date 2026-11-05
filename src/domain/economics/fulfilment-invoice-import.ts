/**
 * Stores parsed 3PL and carrier invoices in `fulfilment_invoices`.
 *
 * Re-importing a file replaces that invoice's rows, so loading the same
 * folder twice cannot double a bill.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { fulfilmentInvoices } from "@/db/schema";
import { isShippingOnlyInvoice, type ThreeplInvoice } from "./parse-threepl-invoice";
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
 * Which of the three PDFs this is. Shipping-only Evobox invoices are excluded
 * from fulfilment: they are not fulfilment bills.
 */
export function classifyInvoicePdf(lines: string[]): "carrier" | "shipping-only" | "evobox" {
  if (isCarrierInvoice(lines)) return "carrier";
  if (isShippingOnlyInvoice(lines)) return "shipping-only";
  return "evobox";
}
