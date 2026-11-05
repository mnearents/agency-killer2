/**
 * Imports invoices from the Google Drive folder Matt's email automation fills
 * ("Evobox Invoices"), so fulfilment and postage stay current with nobody
 * downloading anything.
 *
 * Each file is remembered by its Drive ID with the checksum it had when it
 * was read: an unchanged file is skipped, a changed one re-imported (which
 * replaces that invoice's rows rather than adding to them), and a file that
 * failed is retried every run until it reads — and named in the errors until
 * then, never marked done.
 */

import type { DriveFile } from "@/integrations/google-drive";
import { parseInvoiceLines } from "./parse-threepl-invoice";
import { parseCarrierInvoice } from "./parse-carrier-invoice";
import {
  classifyInvoicePdf,
  evoboxInvoiceRows,
  carrierInvoiceRows,
  shippingInvoiceRows,
  type NewInvoiceRow,
} from "./fulfilment-invoice-import";

export interface KnownFile {
  md5: string | null;
  modifiedTime: string;
  /** imported | superseded | failed */
  outcome: string;
  invoiceNumber?: string | null;
}

export interface InvoiceFolderDeps {
  listFolder: () => Promise<DriveFile[]>;
  download: (fileId: string) => Promise<Uint8Array>;
  toLines: (bytes: Uint8Array) => Promise<string[]>;
  known: () => Promise<Map<string, KnownFile>>;
  store: (rows: NewInvoiceRow[]) => Promise<number>;
  record: (file: DriveFile, outcome: "imported" | "superseded" | "failed", detail?: string, kind?: string, invoiceNumber?: string) => Promise<void>;
}

export interface InvoiceFolderResult {
  listed: number;
  pdfs: number;
  notPdf: number;
  unchanged: number;
  imported: number;
  /** Older copies of an invoice a newer file replaced (Evobox reissues). */
  superseded: number;
  failed: number;
  byKind: Record<string, number>;
  rowsWritten: number;
  errors: string[];
}

export async function syncInvoiceFolder(deps: InvoiceFolderDeps): Promise<InvoiceFolderResult> {
  const files = await deps.listFolder();
  const known = await deps.known();
  const pdfs = files.filter((f) => f.mimeType === "application/pdf" || /\.pdf$/i.test(f.name));
  const result: InvoiceFolderResult = {
    listed: files.length, pdfs: pdfs.length, notPdf: files.length - pdfs.length,
    unchanged: 0, imported: 0, superseded: 0, failed: 0, byKind: {}, rowsWritten: 0, errors: [],
  };

  // The newest file already standing for each invoice number. A file older
  // than that is a superseded copy and must not replace it.
  const newest = new Map<string, string>();
  for (const k of known.values()) {
    if (k.outcome === "imported" && k.invoiceNumber && (newest.get(k.invoiceNumber) ?? "") < k.modifiedTime) newest.set(k.invoiceNumber, k.modifiedTime);
  }

  // Read every new or changed file first, so that which copy wins does not
  // depend on the order Drive lists them in.
  const parsed: { file: DriveFile; kind: string; rows: NewInvoiceRow[] }[] = [];
  for (const file of pdfs) {
    const prior = known.get(file.id);
    const same = prior && prior.outcome !== "failed" && (prior.md5 ?? null) === (file.md5Checksum ?? null) && prior.modifiedTime === file.modifiedTime;
    if (same) {
      result.unchanged++;
      continue;
    }
    try {
      const lines = await deps.toLines(await deps.download(file.id));
      const kind = classifyInvoicePdf(lines);
      const rows =
        kind === "carrier" ? carrierInvoiceRows(parseCarrierInvoice(lines), file.name)
        : kind === "shipping" ? shippingInvoiceRows(lines, file.name)
        : evoboxInvoiceRows(parseInvoiceLines(lines), file.name);
      parsed.push({ file, kind, rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await deps.record(file, "failed", message);
      result.failed++;
      result.errors.push(`${file.name}: ${message}`);
    }
  }

  for (const p of parsed) {
    const number = p.rows[0]?.invoiceNumber ?? "";
    if (p.file.modifiedTime > (newest.get(number) ?? "")) newest.set(number, p.file.modifiedTime);
  }

  for (const { file, kind, rows } of parsed.sort((a, b) => a.file.modifiedTime.localeCompare(b.file.modifiedTime))) {
    const number = rows[0]?.invoiceNumber;
    if (number && (newest.get(number) ?? "") > file.modifiedTime) {
      await deps.record(file, "superseded", `A newer file replaces invoice ${number}.`, kind, number);
      result.superseded++;
      continue;
    }
    result.rowsWritten += await deps.store(rows);
    await deps.record(file, "imported", undefined, kind, number);
    result.imported++;
    result.byKind[kind] = (result.byKind[kind] ?? 0) + 1;
  }
  return result;
}
