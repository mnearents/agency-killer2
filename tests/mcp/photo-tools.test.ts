import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import sharp from "sharp";
import { ALL_TOOLS, dispatchTool, ToolContent, type McpToolContext } from "@/mcp/tools";
import { runToolCall } from "@/mcp/server";
import { syncPhotos } from "@/domain/photos/sync";
import { loadPhotoRecords } from "@/domain/photos/queries";
import { shopifyProducts } from "@/db/schema";
import { drawLabel, readLabel, sheetLayout, sheetCell, SHEET_CELL, SHEET_LABEL_SCALE } from "@/integrations/images";
import type { DropboxClient, DropboxFileEntry } from "@/integrations/dropbox";
import type { Db } from "@/db/client";
import { createTestDb } from "../helpers/test-db";

const ROOT = "/RAD/Footage";
const NOW = new Date("2026-11-16T16:00:00Z");

const jpeg = (width: number, height: number, shade = 120) =>
  sharp({ create: { width, height, channels: 3, background: { r: shade, g: 160, b: 90 } } }).jpeg().toBuffer();

interface FakeFile { path: string; hash: string; width: number; height: number }

const FILES: FakeFile[] = [
  { path: `${ROOT}/Planners/2027 planner pictures/8x10 dated/37FEB8CC-1A81-4DA0-836D-343B630672D4 Large.jpeg`, hash: "large", width: 72, height: 128 },
  { path: `${ROOT}/Planners/2027 planner pictures/8x10 dated/too big/37FEB8CC-1A81-4DA0-836D-343B630672D4.jpg`, hash: "toobig", width: 3024, height: 4032 },
  { path: `${ROOT}/Planners/2027 planner pictures/5x8 dated/Screenshot 2026-09-26 at 11.04.57 AM.png`, hash: "shot", width: 160, height: 100 },
  { path: `${ROOT}/Old ad stuff to organize/ADS MASTER/img.png`, hash: "old", width: 100, height: 100 },
  ...Array.from({ length: 24 }, (_, i) => ({ path: `${ROOT}/Planners/Oct ad shoot/Photo ${i + 1}.jpg`, hash: `oct${i}`, width: 400, height: 300 })),
];

async function fakeDropbox(files: FakeFile[]) {
  const bytes = new Map(await Promise.all(files.map(async (f, i) => [f.path.toLowerCase(), await jpeg(f.width, f.height, (i * 9) % 255)] as const)));
  const entry = (f: FakeFile): DropboxFileEntry => ({
    id: `id:${f.hash}`, path: f.path.toLowerCase(), displayPath: f.path, name: f.path.split("/").pop()!, rev: f.hash,
    contentHash: f.hash, size: f.width * f.height, modified: null, isFolder: false,
  });
  return {
    listFolder: vi.fn(async () => files.map(entry)),
    downloadFile: vi.fn(async (path: string) => bytes.get(path.toLowerCase())!),
    downloadText: vi.fn(),
    getTemporaryLink: vi.fn(),
  } satisfies DropboxClient;
}

const DESCRIPTION = JSON.stringify({
  description: "A planner on a desk.", products: [], shotType: "flat lay", people: ["none"], background: "light",
  visibleText: null, subjectPosition: "centered", headlineSpace: null, qualityFlags: ["sharp"], suggestedUses: [],
});

let db: Db;
let dropbox: Awaited<ReturnType<typeof fakeDropbox>>;
let reset: () => Promise<unknown>;
beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  reset = () => created.truncate("photos", "kb_documents", "shopify_products");
  dropbox = await fakeDropbox(FILES);
});

const sync = () =>
  syncPhotos({
    dropbox, db, rootPath: ROOT, now: () => NOW, describe: { enabled: true },
    anthropic: { generate: vi.fn(async () => ({ text: DESCRIPTION, inputTokens: 1000, outputTokens: 100, stopReason: "end_turn" })) },
  });

beforeEach(async () => {
  await reset();
  await db.insert(shopifyProducts).values([{ id: "p1", title: "2027 Planner - 8x10 Dated", handle: "planner-8x10", status: "active" }]);
  await sync();
});

const ctx = (over: Partial<McpToolContext> = {}): McpToolContext => ({ db, now: () => NOW, photoFiles: dropbox, actor: "Matt", ...over });
const call = (name: string, args: Record<string, unknown> = {}, c = ctx()) => dispatchTool(c, name, args) as Promise<any>;
/** The id of the file with this name (without extension) — any version, not only a master. */
const idOf = async (name: string) => (await loadPhotoRecords(db)).find((r) => r.name.replace(/\.[^.]+$/, "") === name)!.id;

describe("photos", () => {
  it("is read-only", () => {
    expect(ALL_TOOLS.find((t) => t.name === "photos")!.readOnly).toBe(true);
    expect(ALL_TOOLS.find((t) => t.name === "photo_view")!.readOnly).toBe(true);
  });

  it("with no arguments, totals every file in the folder by kind, folder and product", async () => {
    const r = await call("photos");
    expect(r.totals).toMatchObject({
      files: FILES.length,
      groups: FILES.length - 1,
      filesByKind: { source: 26, screenshot: 1, "old-graphic": 1 },
      sourceDescriptions: { described: 25, awaiting: 0, failed: 0 },
    });
    expect(r.totals.byFolder).toContainEqual({ folder: "Planners/Oct ad shoot", files: 24, groups: 24 });
    expect(r.totals.byProduct).toEqual([{ product: "(none visible)", groups: 25 }]);
    expect(r.photos).toBeUndefined();
  });

  it("lists the 37FEB8CC picture once, as its 'too big' master, with both versions", async () => {
    const r = await call("photos", { folder: "8x10 dated" });
    expect(r.matched).toBe(1);
    expect(r.photos[0]).toMatchObject({ name: "37FEB8CC-1A81-4DA0-836D-343B630672D4.jpg", width: 3024, height: 4032, orientation: "portrait", kind: "source" });
    expect(r.photos[0].versions.map((v: { name: string }) => v.name)).toEqual([
      "37FEB8CC-1A81-4DA0-836D-343B630672D4.jpg",
      "37FEB8CC-1A81-4DA0-836D-343B630672D4 Large.jpeg",
    ]);
  });

  it("pages, reporting what matched and where the next page starts", async () => {
    const r = await call("photos", { kind: "source", limit: 10 });
    expect(r).toMatchObject({ matched: 25, returned: 10, offset: 0, nextOffset: 10 });
  });

  it("refuses an argument it does not take", async () => {
    await expect(call("photos", { colour: "blue" })).rejects.toThrow(/Unknown argument "colour"/);
  });
});

describe("photo_view", () => {
  it("shows one photo as a JPEG image whose longest side is maxDimension, from the master", async () => {
    const largeId = await idOf("37FEB8CC-1A81-4DA0-836D-343B630672D4 Large");
    const result = await runToolCall(ctx(), "photo_view", { id: largeId, maxDimension: 2000 });
    expect(result.isError).toBeUndefined();
    const [image, text] = result.content;
    expect(image).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    const meta = await sharp(Buffer.from((image as { data: string }).data, "base64")).metadata();
    expect([meta.format, Math.max(meta.width!, meta.height!)]).toEqual(["jpeg", 2000]);
    const info = JSON.parse((text as { text: string }).text);
    expect(info).toMatchObject({ askedFor: largeId, servedHeight: 2000, originalWidth: 3024, originalHeight: 4032 });
    expect(info.path).toContain("/too big/");
  });

  it("shows the exact file when asked, and never enlarges it", async () => {
    const largeId = await idOf("37FEB8CC-1A81-4DA0-836D-343B630672D4 Large");
    const result = (await call("photo_view", { id: largeId, maxDimension: 2000, version: "exact" })) as ToolContent;
    const info = JSON.parse((result.blocks[1] as { text: string }).text);
    expect(info).toMatchObject({ id: largeId, servedWidth: 72, servedHeight: 128 });
    expect(info.note).toMatch(/smaller than 2000px/);
  });

  it("makes one labelled contact sheet of 24 photos", async () => {
    const listed = await call("photos", { folder: "Oct ad shoot", limit: 24 });
    const ids = listed.photos.map((p: { id: number }) => p.id);
    expect(ids).toHaveLength(24);
    const result = await runToolCall(ctx(), "photo_view", { ids });
    const images = result.content.filter((b) => b.type === "image");
    expect(images).toHaveLength(1);

    const sheet = Buffer.from((images[0] as { data: string }).data, "base64");
    const layout = sheetLayout(24);
    for (const index of [0, 23]) {
      const cell = sheetCell(index, layout.columns);
      const label = drawLabel(`#${ids[index]}`, SHEET_LABEL_SCALE);
      const crop = await sharp(sheet)
        .extract({ left: cell.left + Math.floor((SHEET_CELL - label.width) / 2), top: cell.labelTop, width: label.width, height: label.height })
        .removeAlpha().raw().toBuffer();
      expect(readLabel({ data: crop, width: label.width, height: label.height }, SHEET_LABEL_SCALE)).toBe(`#${ids[index]}`);
    }
    // Contact sheets come from stored thumbnails, not 24 downloads.
    dropbox.downloadFile.mockClear();
    await runToolCall(ctx(), "photo_view", { ids });
    expect(dropbox.downloadFile).not.toHaveBeenCalled();
  });

  it("refuses more than 24, unknown ids, and both or neither of id and ids", async () => {
    await expect(call("photo_view", { ids: Array.from({ length: 25 }, (_, i) => i + 1) })).rejects.toThrow(/at most 24/);
    await expect(call("photo_view", { id: 999 })).rejects.toThrow(/No photo with id 999/);
    await expect(call("photo_view", { id: 1, ids: [2] })).rejects.toThrow(/exactly one/);
    await expect(call("photo_view", {})).rejects.toThrow(/exactly one/);
    await expect(call("photo_view", { id: 1, maxDimension: 2401 })).rejects.toThrow(/at most 2400/);
  });

  it("without Dropbox, says single photos are unavailable but still makes sheets", async () => {
    const noDropbox = ctx({ photoFiles: undefined });
    expect((await call("photo_view", { id: 1 }, noDropbox)).error).toMatch(/no Dropbox credentials/);
    expect(await call("photo_view", { ids: [1, 2] }, noDropbox)).toBeInstanceOf(ToolContent);
  });
});

describe("photo_tag_set", () => {
  it("is declared a writer", () => {
    expect(ALL_TOOLS.find((t) => t.name === "photo_tag_set")!.readOnly).toBe(false);
  });

  it("corrects every version of a picture, records who asked, and keeps it through the next sync", async () => {
    const largeId = await idOf("37FEB8CC-1A81-4DA0-836D-343B630672D4 Large");
    const r = await call("photo_tag_set", { id: largeId, products: ["2027 planner - 8x10 dated"], shotType: "in hand", note: "Tara's hand" });
    expect(r).toMatchObject({ saved: true, versionsUpdated: 2 });
    expect(r.photo).toMatchObject({ products: ["2027 Planner - 8x10 Dated"], shotType: "in hand", corrected: { by: "claude for Matt", note: "Tara's hand" } });

    await sync();
    const after = await call("photos", { product: "8x10" });
    expect(after.matched).toBe(1);
    expect(after.photos[0]).toMatchObject({ shotType: "in hand", products: ["2027 Planner - 8x10 Dated"] });
  });

  it("keeps earlier corrections when a later one changes another field", async () => {
    const id = await idOf("Photo 3");
    await call("photo_tag_set", { id, description: "Planner pages in morning light." });
    const r = await call("photo_tag_set", { id, shotType: "close-up detail" });
    expect(r.photo).toMatchObject({ description: "Planner pages in morning light.", shotType: "close-up detail" });
    expect(r.photo.corrected.fields).toEqual(["description", "shotType"]);
  });

  it("hides a do-not-use picture from photos until it is allowed again, and revert drops every correction", async () => {
    const id = await idOf("Photo 4");
    await call("photo_tag_set", { id, doNotUse: true, note: "blurry" });
    expect((await call("photos", { folder: "Oct ad shoot", limit: 100 })).matched).toBe(23);
    expect((await call("photos", { folder: "Oct ad shoot", includeDoNotUse: true, limit: 100 })).matched).toBe(24);
    const reverted = await call("photo_tag_set", { id, revert: true });
    expect(reverted.photo).toMatchObject({ doNotUse: false, corrected: null, description: "A planner on a desk." });
  });

  it("refuses a product that is not a Shopify title, suggesting real ones", async () => {
    const id = await idOf("Photo 5");
    await expect(call("photo_tag_set", { id, products: ["8x10 planner"] })).rejects.toThrow(/Not a Shopify product title: "8x10 planner".*"2027 Planner - 8x10 Dated"/);
  });

  it("refuses nothing to change, and revert with new values", async () => {
    await expect(call("photo_tag_set", { id: 1 })).rejects.toThrow(/Nothing to correct/);
    await expect(call("photo_tag_set", { id: 1, revert: true, shotType: "cover" })).rejects.toThrow(/cannot be combined/);
  });
});
