import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { syncPhotos } from "@/domain/photos/sync";
import { loadPhotoRecords, saveCorrection } from "@/domain/photos/queries";
import { buildLibrary } from "@/domain/photos/photos";
import { PHOTO_VISION_MODEL } from "@/domain/photos/vision";
import { kbDocuments, photos, shopifyProducts } from "@/db/schema";
import type { DropboxClient, DropboxFileEntry } from "@/integrations/dropbox";
import type { AnthropicClient } from "@/integrations/anthropic";
import type { Db } from "@/db/client";
import { createPhotoDb } from "../../helpers/photo-db";

const ROOT = "/RAD/Footage";
const NOW = new Date("2026-11-16T14:10:00Z");

const jpeg = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 200 } } }).jpeg().toBuffer();

interface FakeFile { path: string; hash: string; width: number; height: number; id?: string }

/** A Dropbox folder that can only be listed and downloaded — which is all the client can do. */
async function fakeDropbox(initial: FakeFile[]) {
  let files = initial;
  const bytes = new Map<string, Buffer>();
  const entry = (f: FakeFile): DropboxFileEntry => ({
    id: f.id ?? `id:${f.hash}`,
    path: f.path.toLowerCase(),
    displayPath: f.path,
    name: f.path.split("/").pop()!,
    rev: `rev-${f.hash}`,
    contentHash: f.hash,
    size: f.width * f.height,
    modified: "2026-10-09T21:36:32Z",
    isFolder: false,
  });
  const ensure = async () => {
    for (const f of files) if (!bytes.has(f.hash)) bytes.set(f.hash, await jpeg(f.width, f.height));
  };
  await ensure();
  const client = {
    listFolder: vi.fn(async () => [
      ...files.map(entry),
      { ...entry({ path: `${ROOT}/Planners`, hash: "folder", width: 0, height: 0 }), isFolder: true, contentHash: null },
      entry({ path: `${ROOT}/Planners/.DS_Store`, hash: "ds", width: 1, height: 1 }),
      entry({ path: `${ROOT}/Planners/clip.mov`, hash: "mov", width: 1, height: 1 }),
    ]),
    downloadFile: vi.fn(async (path: string) => {
      const f = files.find((x) => x.path.toLowerCase() === path.toLowerCase());
      if (!f) throw new Error(`Dropbox download failed for ${path}: 409`);
      return bytes.get(f.hash)!;
    }),
    downloadText: vi.fn(),
    getTemporaryLink: vi.fn(),
  } satisfies DropboxClient;
  return {
    client,
    set: async (next: FakeFile[]) => {
      files = next;
      await ensure();
    },
    downloaded: () => client.downloadFile.mock.calls.map((c) => (c[0] as string).toLowerCase()),
  };
}

const DESCRIPTION = JSON.stringify({
  description: "A dated planner open on a desk.",
  products: ["2027 Planner - 8x10 Dated"],
  shotType: "inside pages",
  people: ["none"],
  background: "light",
  visibleText: null,
  subjectPosition: "centered",
  headlineSpace: "top",
  qualityFlags: ["sharp"],
  suggestedUses: ["email hero"],
});

const vision = (text = DESCRIPTION) => {
  const generate = vi.fn(async () => ({ text, inputTokens: 1500, outputTokens: 200, stopReason: "end_turn" }));
  return { client: { generate } as AnthropicClient, generate };
};

const embeddings = { embed: vi.fn(async () => ({ embedding: Array.from({ length: 1536 }, () => 0.01), tokenCount: 10 })), embedBatch: vi.fn() };

const PAIR: FakeFile[] = [
  { path: `${ROOT}/Planners/2027 planner pictures/8x10 dated/37FEB8CC-1A81-4DA0-836D-343B630672D4 Large.jpeg`, hash: "large", width: 72, height: 128 },
  { path: `${ROOT}/Planners/2027 planner pictures/8x10 dated/too big/37FEB8CC-1A81-4DA0-836D-343B630672D4.jpg`, hash: "toobig", width: 302, height: 403 },
];
const LIBRARY: FakeFile[] = [
  ...PAIR,
  { path: `${ROOT}/Planners/Oct ad shoot/Photo Oct 09.jpg`, hash: "oct", width: 400, height: 300 },
  { path: `${ROOT}/Planners/2027 planner pictures/5x8 dated/Screenshot 2026-09-26 at 11.04.57 AM.png`, hash: "shot", width: 160, height: 100 },
  { path: `${ROOT}/Old ad stuff to organize/ADS MASTER/Baby Quilt/img.png`, hash: "old", width: 100, height: 100 },
];

let db: Db;
let reset: () => Promise<unknown>;
beforeAll(async () => {
  const created = await createPhotoDb();
  db = created.db;
  reset = () => created.client.exec(`TRUNCATE photos, kb_documents, shopify_products RESTART IDENTITY`);
});
beforeEach(async () => {
  await reset();
  await db.insert(shopifyProducts).values([
    { id: "p1", title: "2027 Planner - 8x10 Dated", handle: "planner-8x10", status: "active" },
    { id: "p2", title: "Retired Thing", handle: "retired", status: "archived" },
  ]);
  embeddings.embed.mockClear();
});

const run = (dropbox: DropboxClient, over: Partial<Parameters<typeof syncPhotos>[0]> = {}) =>
  syncPhotos({ dropbox, db, rootPath: ROOT, embeddingClient: embeddings, now: () => NOW, describe: { enabled: false }, ...over });

describe("syncPhotos — indexing", () => {
  it("indexes every image file by kind and nothing else, with totals that match the folder", async () => {
    const dropbox = await fakeDropbox(LIBRARY);
    const result = await run(dropbox.client);
    expect(result.files).toBe(5);
    expect(result.filesByKind).toEqual({ source: 3, screenshot: 1, "old-graphic": 1 });
    expect(result.groups).toBe(4);
    expect(result.inspected).toBe(5);
    expect(result.errors).toEqual([]);
    expect((await loadPhotoRecords(db)).map((r) => r.name).sort()).toEqual(LIBRARY.map((f) => f.path.split("/").pop()).sort());
  });

  it("stores size, orientation, folder and a thumbnail for each file", async () => {
    const dropbox = await fakeDropbox(LIBRARY);
    await run(dropbox.client);
    const [oct] = await db.select().from(photos).where(eq(photos.name, "Photo Oct 09.jpg"));
    expect(oct).toMatchObject({ width: 400, height: 300, megapixels: 0.1, orientation: "landscape", folder: "Planners/Oct ad shoot", kind: "source", used: false, inspectStatus: "ok" });
    const thumb = await sharp(Buffer.from(oct.thumbnail!)).metadata();
    expect([thumb.format, Math.max(thumb.width!, thumb.height!)]).toEqual(["jpeg", 384]);
  });

  it("makes the 37FEB8CC pair one picture whose master is the 'too big' file", async () => {
    const dropbox = await fakeDropbox(LIBRARY);
    await run(dropbox.client);
    const pair = buildLibrary(await loadPhotoRecords(db)).filter((g) => g.versions.some((v) => v.name.startsWith("37FEB8CC")));
    expect(pair).toHaveLength(1);
    expect(pair[0].master.path).toContain("/too big/");
    expect(pair[0].versions).toHaveLength(2);
  });

  it("reads nothing again on a second run when nothing changed", async () => {
    const dropbox = await fakeDropbox(LIBRARY);
    await run(dropbox.client);
    dropbox.client.downloadFile.mockClear();
    const result = await run(dropbox.client);
    expect(dropbox.client.downloadFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ inspected: 0, unchanged: 5, moved: 0, removed: 0 });
  });

  it("follows a moved file without downloading it, and forgets one that left the folder", async () => {
    const dropbox = await fakeDropbox(LIBRARY);
    await run(dropbox.client);
    dropbox.client.downloadFile.mockClear();
    await dropbox.set([
      ...LIBRARY.slice(0, 3).map((f) => (f.hash === "oct" ? { ...f, path: `${ROOT}/Planners/Oct ad shoot/used/Photo Oct 09.jpg` } : f)),
      LIBRARY[3],
    ]);
    const result = await run(dropbox.client);
    expect(dropbox.client.downloadFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ moved: 1, removed: 1 });
    const [oct] = await db.select().from(photos).where(eq(photos.contentHash, "oct"));
    expect(oct).toMatchObject({ folder: "Planners/Oct ad shoot/used", used: true, groupUsed: true });
  });

  it("records an unreadable file, retries it three times, then stops", async () => {
    const dropbox = await fakeDropbox([LIBRARY[2]]);
    dropbox.client.downloadFile.mockRejectedValue(new Error("Dropbox download failed: 500"));
    for (let i = 0; i < 4; i++) await run(dropbox.client);
    expect(dropbox.client.downloadFile).toHaveBeenCalledTimes(3);
    const [row] = await db.select().from(photos);
    expect(row).toMatchObject({ inspectStatus: "error", inspectAttempts: 3 });
    expect((await run(dropbox.client)).inspectExhausted).toBe(1);
  });

  it("only ever lists and downloads: Dropbox is read-only", async () => {
    const dropbox = await fakeDropbox(LIBRARY);
    const { client: anthropic } = vision();
    await run(dropbox.client, { anthropic, describe: { enabled: true } });
    expect(dropbox.client.downloadText).not.toHaveBeenCalled();
    expect(dropbox.client.getTemporaryLink).not.toHaveBeenCalled();
  });
});

describe("syncPhotos — descriptions", () => {
  it("describes nothing while describing is off, and says how many wait", async () => {
    const dropbox = await fakeDropbox(LIBRARY);
    const { client: anthropic, generate } = vision();
    const result = await run(dropbox.client, { anthropic });
    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ described: 0, awaitingDescription: 2, describeHeldBack: "off" });
  });

  it("describes each source picture once, from its master, never screenshots or old graphics", async () => {
    const dropbox = await fakeDropbox(LIBRARY);
    const { client: anthropic, generate } = vision();
    dropbox.client.downloadFile.mockClear();
    await run(dropbox.client, { anthropic, describe: { enabled: false } });
    dropbox.client.downloadFile.mockClear();
    const result = await run(dropbox.client, { anthropic, describe: { enabled: true } });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(dropbox.downloaded().sort()).toEqual([PAIR[1].path.toLowerCase(), LIBRARY[2].path.toLowerCase()].sort());
    expect(result).toMatchObject({ described: 2, awaitingDescription: 0, visionInputTokens: 3000, visionOutputTokens: 400, visionCost: 0.02 });

    const [master] = await db.select().from(photos).where(eq(photos.contentHash, "toobig"));
    expect(master).toMatchObject({
      description: "A dated planner open on a desk.",
      products: ["2027 Planner - 8x10 Dated"],
      shotType: "inside pages",
      visionModel: PHOTO_VISION_MODEL,
      describedAt: NOW,
      describedHash: "toobig",
    });
    // The model is shown a copy no larger than 1024 on its longest side, and only active products.
    const call = generate.mock.calls[0] as unknown as [string, { images: { data: Buffer }[] }];
    const shown = await sharp(call[1].images[0].data).metadata();
    expect(Math.max(shown.width!, shown.height!)).toBeLessThanOrEqual(1024);
    expect(call[0]).toContain("2027 Planner - 8x10 Dated");
    expect(call[0]).not.toContain("Retired Thing");
  });

  it("describes a newly added photo on the next run, and nothing else again", async () => {
    const dropbox = await fakeDropbox(LIBRARY);
    const { client: anthropic, generate } = vision();
    await run(dropbox.client, { anthropic, describe: { enabled: true } });
    generate.mockClear();
    dropbox.client.downloadFile.mockClear();

    const added = { path: `${ROOT}/Planners/Oct ad shoot/New shot.jpg`, hash: "new", width: 500, height: 500 };
    await dropbox.set([...LIBRARY, added]);
    const result = await run(dropbox.client, { anthropic, describe: { enabled: true } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(dropbox.downloaded()).toEqual([added.path.toLowerCase(), added.path.toLowerCase()]);
    expect(result).toMatchObject({ inspected: 1, unchanged: 5, described: 1 });
    const [row] = await db.select().from(photos).where(eq(photos.contentHash, "new"));
    expect(row.description).toBe("A dated planner open on a desk.");
  });

  it("copies the description to an identical file instead of looking again", async () => {
    const dropbox = await fakeDropbox([LIBRARY[2]]);
    const { client: anthropic, generate } = vision();
    await run(dropbox.client, { anthropic, describe: { enabled: true } });
    // Same bytes in another folder: the same picture, so one group, not a second description.
    await dropbox.set([LIBRARY[2], { ...LIBRARY[2], path: `${ROOT}/Planners/Statics/Photo Oct 09 (1).jpg`, id: "id:copy" }]);
    const result = await run(dropbox.client, { anthropic, describe: { enabled: true } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.groups).toBe(1);
  });

  it("stops at the limit asked for and says the rest wait", async () => {
    const dropbox = await fakeDropbox(LIBRARY);
    const { client: anthropic, generate } = vision();
    const result = await run(dropbox.client, { anthropic, describe: { enabled: true, limit: 1 } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ described: 1, awaitingDescription: 1, describeHeldBack: "limit" });
  });

  it("fails closed on an unreadable answer, and gives up on those bytes after three tries", async () => {
    const dropbox = await fakeDropbox([LIBRARY[2]]);
    const { client: anthropic, generate } = vision("I think it's a planner?");
    for (let i = 0; i < 4; i++) await run(dropbox.client, { anthropic, describe: { enabled: true } });
    expect(generate).toHaveBeenCalledTimes(3);
    const [row] = await db.select().from(photos);
    expect(row).toMatchObject({ description: null, visionStatus: "error", visionAttempts: 3 });
    expect(buildLibrary(await loadPhotoRecords(db))[0].state).toBe("failed");
  });

  it("names a product unknown rather than guess one it was not given", async () => {
    const dropbox = await fakeDropbox([LIBRARY[2]]);
    const { client: anthropic } = vision(DESCRIPTION.replace('"2027 Planner - 8x10 Dated"', '"2027 Planner"'));
    await run(dropbox.client, { anthropic, describe: { enabled: true } });
    const [row] = await db.select().from(photos);
    expect(row.products).toEqual(["unknown"]);
  });
});

describe("syncPhotos — corrections and search", () => {
  it("keeps a correction through later syncs, a re-description and a new version of the picture", async () => {
    const dropbox = await fakeDropbox(PAIR);
    const { client: anthropic, generate } = vision();
    await run(dropbox.client, { anthropic, describe: { enabled: true } });
    const records = await loadPhotoRecords(db);
    await saveCorrection(db, {
      ids: records.map((r) => r.id),
      current: null,
      correction: { products: ["2027 Planner - 8x10 Dated"], shotType: "in hand", description: "Tara's hand holding the 8x10 dated planner.", note: "checked" },
      by: "claude for Matt",
      at: new Date("2026-11-16T15:00:00Z"),
    });

    // The master is replaced with new bytes (re-described), and a bigger version arrives.
    await dropbox.set([
      PAIR[0],
      { ...PAIR[1], hash: "toobig-v2" , id: "id:toobig" },
      { path: `${ROOT}/Planners/2027 planner pictures/8x10 dated/used/37FEB8CC-1A81-4DA0-836D-343B630672D4.png`, hash: "used", width: 600, height: 800 },
    ]);
    generate.mockClear();
    await run(dropbox.client, { anthropic, describe: { enabled: true } });
    expect(generate).toHaveBeenCalledTimes(1);

    const [g] = buildLibrary(await loadPhotoRecords(db));
    expect(g.versions).toHaveLength(3);
    expect(g.master.contentHash).toBe("used");
    expect(g.description).toBe("Tara's hand holding the 8x10 dated planner.");
    expect(g.shotType).toBe("in hand");
    expect(g.used).toBe(true);
    expect(g.corrected).toMatchObject({ by: "claude for Matt", note: "checked", fields: ["description", "products", "shotType"] });
    const rows = await db.select().from(photos);
    expect(rows.every((r) => r.correctedShotType === "in hand")).toBe(true);
  });

  it("writes one photos document per described picture, embedded, and removes it when the picture is marked do-not-use", async () => {
    const dropbox = await fakeDropbox(LIBRARY);
    const { client: anthropic } = vision();
    const first = await run(dropbox.client, { anthropic, describe: { enabled: true } });
    expect(first.documents).toEqual({ written: 2, removed: 0, unembedded: 0 });
    const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.category, "photos"));
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.embedding !== null)).toBe(true);
    expect(docs.map((d) => d.content).join("\n")).toContain("Products: 2027 Planner - 8x10 Dated");

    const [oct] = await db.select().from(photos).where(eq(photos.contentHash, "oct"));
    await saveCorrection(db, { ids: [oct.id], current: null, correction: { doNotUse: true }, by: "claude", at: NOW });
    embeddings.embed.mockClear();
    const second = await run(dropbox.client, { anthropic, describe: { enabled: true } });
    expect(second.documents).toEqual({ written: 0, removed: 1, unembedded: 0 });
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it("says when documents could not be embedded rather than counting them searchable", async () => {
    const dropbox = await fakeDropbox([LIBRARY[2]]);
    const { client: anthropic } = vision();
    const result = await run(dropbox.client, { anthropic, describe: { enabled: true }, embeddingClient: undefined });
    expect(result.documents).toEqual({ written: 1, removed: 0, unembedded: 1 });
    expect(result.errors.join(" ")).toMatch(/no embedding/);
  });
});
