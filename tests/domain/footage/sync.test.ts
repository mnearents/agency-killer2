import { describe, it, expect, vi } from "vitest";
import { syncFootage } from "@/domain/footage/sync";
import { footageDocument, type StoredFootage } from "@/domain/footage/footage";
import { footage, kbDocuments } from "@/db/schema";
import { createMockDropboxClient } from "../../mocks/dropbox";
import type { DropboxFileEntry } from "@/integrations/dropbox";

const entry = (over: Partial<DropboxFileEntry> = {}): DropboxFileEntry => ({
  id: "id:clip", path: "/RAD/Footage/clip.mp4", name: "clip.mp4", rev: "r1", contentHash: "h1",
  size: 2_000_000, isFolder: false, ...over,
});

const stored = (over: Partial<StoredFootage> = {}): StoredFootage => ({
  dropboxId: "id:clip", path: "/rad/footage/clip.mp4", rev: "r1", contentHash: "h1",
  transcriptionStatus: "ok", transcriptionAttempts: 1, ...over,
});

interface KbRow { sourceFile: string; content: string }

/**
 * Just enough Drizzle to observe what the sync would write. It cannot evaluate
 * a WHERE clause, so it answers every read of a table with all of that table's
 * rows; which rows a write targets is `reconcileFootage`'s job, tested purely.
 */
function fakeDb(seed: { footage?: StoredFootage[]; kb?: KbRow[] } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const updates: { table: unknown; set: Record<string, unknown> }[] = [];
  const deletes: { table: unknown }[] = [];
  const rowsOf = (table: unknown) =>
    table === footage ? seed.footage ?? [] : table === kbDocuments ? seed.kb ?? [] : [];
  const read = (table: unknown) => {
    const rows = rowsOf(table);
    return { where: async () => rows, then: (ok: (r: unknown) => unknown) => Promise.resolve(rows).then(ok) };
  };
  const db = {
    select: () => ({ from: read }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { onConflictDoUpdate: async () => undefined, then: undefined };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => { updates.push({ table, set }); },
      }),
    }),
    delete: (table: unknown) => ({ where: async () => { deletes.push({ table }); } }),
  };
  return { db: db as never, inserted, updates, deletes };
}

describe("syncFootage", () => {
  // Absent is a supported state and must not read as "the folder is empty".
  it("reports itself unconfigured when there is no transcriber", async () => {
    const { db } = fakeDb();
    const result = await syncFootage({
      dropbox: createMockDropboxClient(), db, rootPath: "/RAD/Footage",
    });
    expect(result.configured).toBe(false);
    expect(result.errors[0]).toMatch(/ASSEMBLYAI_API_KEY/);
  });

  it("ignores files that are not video or audio", async () => {
    const { db } = fakeDb();
    const dropbox = createMockDropboxClient({
      listFolder: vi.fn().mockResolvedValue([
        entry({ name: "notes.md", path: "/RAD/Footage/notes.md" }),
        entry({ name: "thumb.jpg", path: "/RAD/Footage/thumb.jpg" }),
        entry({ name: "b-roll", path: "/RAD/Footage/b-roll", isFolder: true }),
      ]),
    });
    const result = await syncFootage({
      dropbox, db, rootPath: "/RAD/Footage",
      transcriber: { transcribe: vi.fn() } as never,
    });
    expect(result.mediaFiles).toBe(0);
  });

  // The whole reason for the temporary link: a 2GB camera file must not pass
  // through this process.
  it("hands the transcriber a link rather than downloading the video", async () => {
    const { db } = fakeDb();
    const getTemporaryLink = vi.fn().mockResolvedValue("https://dl.dropbox/clip.mp4");
    const downloadText = vi.fn();
    const transcribe = vi.fn().mockResolvedValue({ status: "completed", text: "hello" });
    const dropbox = createMockDropboxClient({
      listFolder: vi.fn().mockResolvedValue([entry()]), getTemporaryLink, downloadText,
    });

    await syncFootage({
      dropbox, db, rootPath: "/RAD/Footage", transcriber: { transcribe } as never,
    });

    expect(getTemporaryLink).toHaveBeenCalledWith("/RAD/Footage/clip.mp4");
    expect(transcribe).toHaveBeenCalledWith("https://dl.dropbox/clip.mp4");
    expect(downloadText).not.toHaveBeenCalled();
  });

  // B-roll is silent by nature. Counting it as a failure would make an
  // ordinary folder look broken.
  it("counts a silent clip as silent, not failed", async () => {
    const { db } = fakeDb();
    const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
    const result = await syncFootage({
      dropbox, db, rootPath: "/RAD/Footage",
      transcriber: { transcribe: vi.fn().mockResolvedValue({ status: "completed", text: "" }) } as never,
    });
    expect(result).toMatchObject({ silent: 1, failed: 0, transcribed: 0 });
  });

  it("counts a thrown transcription as failed", async () => {
    const { db } = fakeDb();
    const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
    const result = await syncFootage({
      dropbox, db, rootPath: "/RAD/Footage",
      transcriber: { transcribe: vi.fn().mockRejectedValue(new Error("429 rate limited")) } as never,
    });
    expect(result).toMatchObject({ silent: 0, failed: 1 });
    expect(result.errors.join(" ")).toMatch(/429/);
  });

  // A silent clip in the knowledge base would be a document that says nothing,
  // returned by searches and helping none of them.
  it("writes no knowledge base document for a silent clip", async () => {
    const { db, inserted } = fakeDb();
    const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
    await syncFootage({
      dropbox, db, rootPath: "/RAD/Footage",
      transcriber: { transcribe: vi.fn().mockResolvedValue({ status: "completed", text: "" }) } as never,
    });
    expect(inserted.some((r) => r.category === "footage")).toBe(false);
  });

  it("writes a knowledge base document when there is a transcript", async () => {
    const { db, inserted } = fakeDb();
    const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
    await syncFootage({
      dropbox, db, rootPath: "/RAD/Footage",
      transcriber: { transcribe: vi.fn().mockResolvedValue({ status: "completed", text: "the planner arrived" }) } as never,
    });
    const doc = inserted.find((r) => r.category === "footage");
    expect(doc).toBeDefined();
    expect(String(doc!.content)).toContain("the planner arrived");
    expect(doc!.sourceFile).toBe("footage:id:clip");
  });

  it("tags a transcribed clip when Anthropic is available", async () => {
    const { db, inserted } = fakeDb();
    const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
    const result = await syncFootage({
      dropbox, db, rootPath: "/RAD/Footage",
      transcriber: { transcribe: vi.fn().mockResolvedValue({ status: "completed", text: "unboxing the planner" }) } as never,
      anthropic: {
        generate: vi.fn().mockResolvedValue({
          text: '{"summary":"Unboxing the 2026 planner","tags":["planner","unboxing"]}',
        }),
      } as never,
    });
    expect(result.tagged).toBe(1);
    expect(String(inserted.find((r) => r.category === "footage")!.content)).toContain("unboxing");
  });

  // Tagging is a nicety; losing it must not lose the transcript.
  it("still stores the transcript when tagging fails", async () => {
    const { db, inserted } = fakeDb();
    const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
    const result = await syncFootage({
      dropbox, db, rootPath: "/RAD/Footage",
      transcriber: { transcribe: vi.fn().mockResolvedValue({ status: "completed", text: "words" }) } as never,
      anthropic: { generate: vi.fn().mockRejectedValue(new Error("overloaded")) } as never,
    });
    expect(result.transcribed).toBe(1);
    expect(result.tagged).toBe(0);
    expect(inserted.some((r) => r.category === "footage")).toBe(true);
    expect(result.errors.join(" ")).toMatch(/Tagging failed/);
  });

  it("records the Dropbox file ID and content hash on a transcribed clip", async () => {
    const { db, inserted } = fakeDb();
    const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
    await syncFootage({
      dropbox, db, rootPath: "/RAD/Footage",
      transcriber: { transcribe: vi.fn().mockResolvedValue({ status: "completed", text: "words" }) } as never,
    });
    expect(inserted.find((r) => r.category === undefined)).toMatchObject({
      dropboxId: "id:clip", contentHash: "h1", path: "/rad/footage/clip.mp4",
    });
  });

  describe("keeping the database in step with the folder", () => {
    const oldDoc = footageDocument({
      name: "clip.mp4", path: "/rad/footage/clip.mp4", summary: "Unboxing", tags: ["unboxing"], transcript: "it arrived",
    });

    it("moves a renamed clip without transcribing it again", async () => {
      const { db, updates } = fakeDb({
        footage: [stored()],
        kb: [{ sourceFile: "footage:id:clip", content: oldDoc.content }],
      });
      const transcribe = vi.fn();
      const dropbox = createMockDropboxClient({
        listFolder: vi.fn().mockResolvedValue([entry({ path: "/RAD/Footage/2026/Unboxing.mp4", name: "Unboxing.mp4" })]),
      });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage", transcriber: { transcribe } as never,
      });

      expect(transcribe).not.toHaveBeenCalled();
      expect(result).toMatchObject({ moved: 1, transcribed: 0, removed: 0 });
      expect(updates.find((u) => u.table === footage)?.set).toMatchObject({
        path: "/rad/footage/2026/unboxing.mp4", name: "Unboxing.mp4",
      });
      expect(String(updates.find((u) => u.table === kbDocuments)?.set.content))
        .toContain("[Footage /rad/footage/2026/unboxing.mp4]");
    });

    it("re-embeds a moved clip's document so search reflects the new name", async () => {
      const { db, updates } = fakeDb({
        footage: [stored()],
        kb: [{ sourceFile: "footage:id:clip", content: oldDoc.content }],
      });
      const embed = vi.fn().mockResolvedValue({ embedding: [0.5] });
      const dropbox = createMockDropboxClient({
        listFolder: vi.fn().mockResolvedValue([entry({ path: "/RAD/Footage/b.mp4", name: "b.mp4" })]),
      });
      await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage",
        transcriber: { transcribe: vi.fn() } as never, embeddingClient: { embed } as never,
      });
      expect(embed).toHaveBeenCalledWith(expect.stringContaining("/rad/footage/b.mp4"));
      expect(updates.find((u) => u.table === kbDocuments)?.set.embedding).toEqual([0.5]);
    });

    it("deletes a clip that left the folder, with its transcript and tags", async () => {
      const { db, deletes } = fakeDb({ footage: [stored({ dropboxId: "id:gone" })] });
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage",
        transcriber: { transcribe: vi.fn().mockResolvedValue({ status: "completed", text: "" }) } as never,
      });
      expect(result.removed).toBe(1);
      expect(deletes.some((d) => d.table === footage)).toBe(true);
      expect(deletes.some((d) => d.table === kbDocuments)).toBe(true);
    });

    // A partial listing would read as "everything else was deleted". A listing
    // that fails must therefore delete nothing at all.
    it("deletes nothing when the folder cannot be listed", async () => {
      const { db, deletes } = fakeDb({ footage: [stored()] });
      const dropbox = createMockDropboxClient({
        listFolder: vi.fn().mockRejectedValue(new Error("Dropbox list_folder/continue failed: 500")),
      });
      await expect(syncFootage({
        dropbox, db, rootPath: "/RAD/Footage", transcriber: { transcribe: vi.fn() } as never,
      })).rejects.toThrow("Dropbox list_folder/continue failed: 500");
      expect(deletes).toEqual([]);
    });

    // The first run after this change meets 663 rows with no file ID. Adopting
    // them is what keeps that run from re-transcribing the whole folder.
    it("adopts a clip recorded before file IDs without transcribing it again", async () => {
      const { db, updates } = fakeDb({
        footage: [stored({ dropboxId: null, contentHash: null })],
        kb: [{ sourceFile: "footage:/rad/footage/clip.mp4", content: oldDoc.content }],
      });
      const transcribe = vi.fn();
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage", transcriber: { transcribe } as never,
      });

      expect(transcribe).not.toHaveBeenCalled();
      expect(result).toMatchObject({ adopted: 1, removed: 0 });
      expect(updates.find((u) => u.table === footage)?.set).toMatchObject({ dropboxId: "id:clip", contentHash: "h1" });
      expect(updates.find((u) => u.table === kbDocuments)?.set).toMatchObject({ sourceFile: "footage:id:clip" });
    });
  });
});
