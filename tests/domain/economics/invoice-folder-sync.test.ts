import { describe, it, expect, vi } from "vitest";
import { syncInvoiceFolder, type InvoiceFolderDeps, type KnownFile } from "@/domain/economics/invoice-folder-sync";

const file = (id: string, name: string, md5 = `m-${id}`, mimeType = "application/pdf") =>
  ({ id, name, mimeType, md5Checksum: md5, modifiedTime: "2026-11-03T00:00:00Z" });

const TEXT: Record<string, string[]> = {
  ship: ["Invoice no.: 20980", "Invoice date: 11/02/2026", "1. Shipping $81.47", "Total", "$81.47"],
  bill: ["Invoice no.: 762890", "Invoice date: 11/03/2026", "1. Sales Order charges 1 $127.82 $127.82", "Total", "$127.82", "Ful fi llment 10/17-10/30"],
  carrier: ["Rad and Happy 10/26/2026 S2R9HH6VMZSN $326.39", "Upon receipt 10/19/2026 - 10/25/2026", "SUMMARY OF CHARGES BY CARRIER", "CARRIER SHIPMENTS CHARGE", "Cirro 21 $182.91", "USPS 20 $143.48", "TOTAL 41 $326.39"],
  broken: ["Invoice no.: 999", "nothing here"],
};

function deps(files: ReturnType<typeof file>[], known = new Map<string, KnownFile>()) {
  const stored: unknown[][] = [];
  const recorded: { id: string; outcome: string; detail: string | null }[] = [];
  const d: InvoiceFolderDeps = {
    listFolder: vi.fn(async () => files),
    download: vi.fn(async (id: string) => new TextEncoder().encode(id)),
    toLines: vi.fn(async (bytes: Uint8Array) => TEXT[new TextDecoder().decode(bytes)] ?? []),
    known: vi.fn(async () => known),
    store: vi.fn(async (rows) => { stored.push(rows); return rows.length; }),
    record: vi.fn(async (f, outcome, detail) => { recorded.push({ id: f.id, outcome, detail: detail ?? null }); }),
  };
  return { d, stored, recorded };
}

describe("syncInvoiceFolder", () => {
  it("imports each kind of invoice from the folder", async () => {
    const { d, stored } = deps([file("ship", "Invoice_20980_from_Evobox.pdf"), file("bill", "Invoice_762890_from_Evobox.pdf"), file("carrier", "Rad and Happy invoice Oct 19th.pdf")]);
    const r = await syncInvoiceFolder(d);
    expect(r).toMatchObject({ pdfs: 3, imported: 3, unchanged: 0, failed: 0 });
    expect(r.byKind).toEqual({ shipping: 1, evobox: 1, carrier: 1 });
    expect(stored.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "evobox-shipping", invoiceNumber: "20980" }),
      expect.objectContaining({ source: "evobox", invoiceNumber: "762890" }),
      expect.objectContaining({ source: "carrier", carrier: "Cirro" }),
    ]));
  });

  // The folder only grows; reading 35 PDFs every day to change nothing is waste.
  it("skips a file already imported with the same content", async () => {
    const known = new Map([["ship", { md5: "m-ship", modifiedTime: "2026-11-03T00:00:00Z", outcome: "imported" }]]);
    const { d } = deps([file("ship", "x.pdf")], known);
    expect(await syncInvoiceFolder(d)).toMatchObject({ imported: 0, unchanged: 1 });
    expect(d.download).not.toHaveBeenCalled();
  });

  it("re-imports a file whose content changed", async () => {
    const known = new Map([["ship", { md5: "old", modifiedTime: "2026-11-01T00:00:00Z", outcome: "imported" }]]);
    const { d } = deps([file("ship", "x.pdf")], known);
    expect(await syncInvoiceFolder(d)).toMatchObject({ imported: 1 });
  });

  // A file that failed must not be marked done: it is retried every run, and named.
  it("records a file it cannot read as failed, carries on, and retries it next time", async () => {
    const { d, recorded } = deps([file("broken", "mystery.pdf"), file("ship", "ok.pdf")]);
    const r = await syncInvoiceFolder(d);
    expect(r).toMatchObject({ imported: 1, failed: 1 });
    expect(r.errors[0]).toMatch(/mystery\.pdf/);
    expect(recorded.find((x) => x.id === "broken")).toMatchObject({ outcome: "failed" });

    const known = new Map([["broken", { md5: "m-broken", modifiedTime: "2026-11-03T00:00:00Z", outcome: "failed" }]]);
    const again = deps([file("broken", "mystery.pdf")], known);
    await syncInvoiceFolder(again.d);
    expect(again.d.download).toHaveBeenCalledWith("broken");
  });

  it("ignores files that are not PDFs, and says how many", async () => {
    const { d } = deps([file("doc", "notes", "m", "application/vnd.google-apps.document")]);
    expect(await syncInvoiceFolder(d)).toMatchObject({ listed: 1, pdfs: 0, notPdf: 1 });
  });
});
