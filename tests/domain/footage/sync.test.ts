import { describe, it, expect, vi } from "vitest";
import { syncFootage } from "@/domain/footage/sync";
import { footageDocument, type StoredFootage } from "@/domain/footage/footage";
import { footage, kbDocuments } from "@/db/schema";
import { MAX_TRANSCRIPTION_ATTEMPTS } from "@/domain/social/transcription";
import { AD_ANALYSIS_INSTRUCTION, finishedAdDocument } from "@/domain/footage/finished-ads";
import { createMockDropboxClient } from "../../mocks/dropbox";
import type { DropboxFileEntry } from "@/integrations/dropbox";

const entry = (over: Partial<DropboxFileEntry> = {}): DropboxFileEntry => ({
  id: "id:clip", path: "/RAD/Footage/clip.mp4", name: "clip.mp4", rev: "r1", contentHash: "h1",
  size: 2_000_000, isFolder: false, ...over,
});

const stored = (over: Partial<StoredFootage> = {}): StoredFootage => ({
  dropboxId: "id:clip", path: "/rad/footage/clip.mp4", rev: "r1", contentHash: "h1",
  transcriptionStatus: "ok", transcriptionAttempts: 1, transcriptionDetail: null, hasWords: true, kind: "raw", ...over,
});

interface KbRow { id?: number; sourceFile: string; content: string; embedding?: number[] | null }

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

  describe("clips that have used up their attempts", () => {
    const givenUp = () => stored({
      transcriptionStatus: "error", transcriptionAttempts: MAX_TRANSCRIPTION_ATTEMPTS,
      transcriptionDetail: "status: error",
    });

    // These were reported as `unchanged`, so a run that skipped 64 failed
    // clips read as "0 failed" and nobody knew to retry them.
    it("counts them apart from unchanged clips", async () => {
      const { db } = fakeDb({ footage: [givenUp()] });
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage", transcriber: { transcribe: vi.fn() } as never,
      });
      expect(result).toMatchObject({ exhausted: 1, unchanged: 0, failed: 0 });
    });

    it("tries them again when asked, with a fresh count of attempts", async () => {
      const { db, inserted } = fakeDb({ footage: [givenUp()] });
      const transcribe = vi.fn().mockResolvedValue({ status: "completed", text: "hello" });
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage", transcriber: { transcribe } as never,
        retryExhausted: true,
      });
      expect(transcribe).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ exhausted: 0, transcribed: 1 });
      expect(inserted.find((v) => "transcriptionAttempts" in v)).toMatchObject({ transcriptionAttempts: 1 });
    });
  });

  describe("word timings", () => {
    const words = [{ text: "Hello", start: 120, end: 480, confidence: 0.98 }];
    const clipDoc = footageDocument({
      name: "clip.mp4", path: "/rad/footage/clip.mp4", summary: null, tags: null, transcript: "Hello.",
    });

    it("keeps the transcript ID, words and duration of a new transcription", async () => {
      const { db, inserted } = fakeDb();
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage",
        transcriber: {
          transcribe: vi.fn().mockResolvedValue({ id: "t1", status: "completed", text: "Hello.", words, durationMs: 54000 }),
        } as never,
      });
      expect(inserted.find((v) => "transcriptionAttempts" in v))
        .toMatchObject({ transcriptId: "t1", words, durationMs: 54000 });
    });

    // Transcripts made before words were kept. AssemblyAI still holds them, so
    // the words are fetched rather than paid for twice.
    it("recovers a clip's words from AssemblyAI without transcribing it again", async () => {
      const { db, updates } = fakeDb({
        footage: [stored({ hasWords: false })],
        kb: [{ sourceFile: "footage:id:clip", content: clipDoc.content, embedding: [0.1] }],
      });
      const transcribe = vi.fn();
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage",
        transcriber: {
          transcribe,
          listCompletedTranscriptIds: vi.fn().mockResolvedValue(["other", "t1"]),
          getTranscript: vi.fn(async (id: string) => id === "t1"
            ? { id, status: "completed", text: "Hello.", words, durationMs: 54000 }
            : { id, status: "completed", text: "Something else.", words, durationMs: 9000 }),
        } as never,
      });
      expect(transcribe).not.toHaveBeenCalled();
      expect(result).toMatchObject({ timingsRecovered: 1, timingsRetranscribed: 0 });
      expect(updates.find((u) => u.table === footage && "words" in u.set)?.set)
        .toMatchObject({ transcriptId: "t1", words, durationMs: 54000 });
    });

    it("transcribes again a clip whose transcript AssemblyAI no longer holds", async () => {
      const { db } = fakeDb({
        footage: [stored({ hasWords: false })],
        kb: [{ sourceFile: "footage:id:clip", content: clipDoc.content, embedding: [0.1] }],
      });
      const transcribe = vi.fn().mockResolvedValue({ id: "t2", status: "completed", text: "Hello.", words, durationMs: 54000 });
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage",
        transcriber: {
          transcribe,
          listCompletedTranscriptIds: vi.fn().mockResolvedValue([]),
          getTranscript: vi.fn(),
        } as never,
      });
      expect(transcribe).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ timingsRecovered: 0, timingsRetranscribed: 1, transcribed: 1 });
    });

    it("does not look for transcripts when every clip has its words", async () => {
      const { db } = fakeDb({ footage: [stored()] });
      const listCompletedTranscriptIds = vi.fn();
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage",
        transcriber: { transcribe: vi.fn(), listCompletedTranscriptIds } as never,
      });
      expect(listCompletedTranscriptIds).not.toHaveBeenCalled();
    });

    // An incomplete search finds fewer matches, and every clip it missed would
    // be paid for again. So nothing is re-transcribed unless all was read.
    it("transcribes nothing again when AssemblyAI cannot be listed", async () => {
      const { db } = fakeDb({
        footage: [stored({ hasWords: false })],
        kb: [{ sourceFile: "footage:id:clip", content: clipDoc.content, embedding: [0.1] }],
      });
      const transcribe = vi.fn();
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage",
        transcriber: {
          transcribe,
          listCompletedTranscriptIds: vi.fn().mockRejectedValue(new Error("AssemblyAI transcript list error (500)")),
          getTranscript: vi.fn(),
        } as never,
      });
      expect(transcribe).not.toHaveBeenCalled();
      expect(result.timingsRetranscribed).toBe(0);
      expect(result.errors.join(" ")).toMatch(/transcript list error \(500\)/);
    });

    it("transcribes nothing again when one transcript could not be read", async () => {
      const { db } = fakeDb({
        footage: [stored({ hasWords: false })],
        kb: [{ sourceFile: "footage:id:clip", content: clipDoc.content, embedding: [0.1] }],
      });
      const transcribe = vi.fn();
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage",
        transcriber: {
          transcribe,
          listCompletedTranscriptIds: vi.fn().mockResolvedValue(["t1"]),
          getTranscript: vi.fn().mockRejectedValue(new Error("AssemblyAI transcript fetch error (503)")),
        } as never,
      });
      expect(transcribe).not.toHaveBeenCalled();
      expect(result.errors.join(" ")).toMatch(/fetch error \(503\)/);
    });
  });

  describe("documents stored without an embedding", () => {
    it("embeds them on the next run", async () => {
      const { db, updates } = fakeDb({
        footage: [stored()],
        kb: [{ id: 7, sourceFile: "footage:id:clip", content: "x", embedding: null }],
      });
      const embed = vi.fn().mockResolvedValue({ embedding: [0.5], tokenCount: 1 });
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage", transcriber: { transcribe: vi.fn() } as never,
        embeddingClient: { embed, embedBatch: vi.fn() },
      });
      expect(embed).toHaveBeenCalledWith("x");
      expect(result).toMatchObject({ embedded: 1, unembedded: 0 });
      expect(updates.find((u) => u.table === kbDocuments)?.set).toEqual({ embedding: [0.5] });
    });

    // Previously a failed embedding was logged once and the document stayed
    // unsearchable for good. Now it is counted and tried again next run.
    it("counts what still could not be embedded and says it will retry", async () => {
      const { db } = fakeDb({
        footage: [stored()],
        kb: [{ id: 7, sourceFile: "footage:id:clip", content: "x", embedding: null }],
      });
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage", transcriber: { transcribe: vi.fn() } as never,
        embeddingClient: { embed: vi.fn().mockRejectedValue(new Error("401 Incorrect API key")), embedBatch: vi.fn() },
      });
      expect(result).toMatchObject({ embedded: 0, unembedded: 1 });
      expect(result.errors.join(" ")).toMatch(/1 footage document\(s\) still have no embedding.*401.*next run/);
    });

    it("counts them as unembedded when no embedding client is configured", async () => {
      const { db } = fakeDb({
        footage: [stored()],
        kb: [{ id: 7, sourceFile: "footage:id:clip", content: "x", embedding: null }],
      });
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage", transcriber: { transcribe: vi.fn() } as never,
      });
      expect(result).toMatchObject({ embedded: 0, unembedded: 1 });
    });
  });

  describe("finished ads", () => {
    const ad = (over: Partial<DropboxFileEntry> = {}) => entry({
      id: "id:ad", path: "/RAD/Footage/Finished Ads/Sunday.mp4", name: "Sunday.mp4", ...over,
    });
    const analysis = JSON.stringify({
      summary: "A teacher's Sunday", tags: ["teacher"], hook: "Sunday nights used to take me three hours.",
      angle: "time saving", product: "Teacher Planner", callToAction: "Shop now", format: "testimonial",
    });
    const transcriber = () => ({
      transcribe: vi.fn().mockResolvedValue({ id: "t", status: "completed", text: "Sunday nights used to take me three hours.", words: [] }),
    });

    it("analyses a finished ad for its hook and angle and files it apart from footage", async () => {
      const { db, inserted } = fakeDb();
      const generate = vi.fn().mockResolvedValue({ text: analysis });
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([ad()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage", transcriber: transcriber() as never, anthropic: { generate } as never,
      });

      expect(generate.mock.calls[0][0]).toContain(AD_ANALYSIS_INSTRUCTION);
      expect(result).toMatchObject({ finishedAds: 1, tagged: 1 });
      expect(inserted.find((v) => "transcriptionAttempts" in v)).toMatchObject({
        kind: "finished-ad", adHook: "Sunday nights used to take me three hours.", adAngle: "time saving",
        adProduct: "Teacher Planner", adCallToAction: "Shop now", adFormat: "testimonial",
        tags: ["teacher"], summary: "A teacher's Sunday",
      });
      const doc = inserted.find((v) => "category" in v)!;
      expect(doc.category).toBe("finished-ad");
      expect(doc.title).toBe("Finished ad: Sunday.mp4");
    });

    it("tags raw footage as it always has, with no ad fields", async () => {
      const { db, inserted } = fakeDb();
      const generate = vi.fn().mockResolvedValue({ text: '{"summary":"s","tags":["planner"]}' });
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage", transcriber: transcriber() as never, anthropic: { generate } as never,
      });

      expect(generate.mock.calls[0][0]).not.toContain(AD_ANALYSIS_INSTRUCTION);
      expect(result.finishedAds).toBe(0);
      expect(inserted.find((v) => "transcriptionAttempts" in v)).toMatchObject({ kind: "raw", adHook: null, adAngle: null });
      expect(inserted.find((v) => "category" in v)!.category).toBe("footage");
    });

    // A clip moved into Finished Ads was raw footage when it was analysed, so
    // it has topic tags and no hook. A relocation would keep it that way.
    it("analyses a clip again when it moves into Finished Ads", async () => {
      const { db, inserted } = fakeDb({ footage: [stored({ dropboxId: "id:ad", path: "/rad/footage/sunday.mp4" })] });
      const t = transcriber();
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([ad()]) });
      const result = await syncFootage({
        dropbox, db, rootPath: "/RAD/Footage", transcriber: t as never,
        anthropic: { generate: vi.fn().mockResolvedValue({ text: analysis }) } as never,
      });

      expect(t.transcribe).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ reclassified: 1, moved: 0 });
      expect(inserted.find((v) => "category" in v)!.category).toBe("finished-ad");
    });

    it("analyses a clip again as footage when it moves out of Finished Ads", async () => {
      const { db, inserted } = fakeDb({
        footage: [stored({ dropboxId: "id:clip", path: "/rad/footage/finished ads/clip.mp4", kind: "finished-ad" })],
      });
      const t = transcriber();
      const dropbox = createMockDropboxClient({ listFolder: vi.fn().mockResolvedValue([entry()]) });
      const result = await syncFootage({ dropbox, db, rootPath: "/RAD/Footage", transcriber: t as never });

      expect(t.transcribe).toHaveBeenCalledOnce();
      expect(result.reclassified).toBe(1);
      expect(inserted.find((v) => "transcriptionAttempts" in v)).toMatchObject({ kind: "raw" });
    });

    it("relocates a finished ad moved within Finished Ads without analysing it again", async () => {
      const doc = finishedAdDocument({
        name: "Sunday.mp4", path: "/rad/footage/finished ads/sunday.mp4", analysis: null, transcript: "Hi.",
      });
      const { db, updates } = fakeDb({
        footage: [stored({ dropboxId: "id:ad", path: "/rad/footage/finished ads/sunday.mp4", kind: "finished-ad" })],
        kb: [{ sourceFile: "footage:id:ad", content: doc.content, embedding: [0.1] }],
      });
      const t = transcriber();
      const dropbox = createMockDropboxClient({
        listFolder: vi.fn().mockResolvedValue([ad({ path: "/RAD/Footage/Finished Ads/2026/Sunday.mp4" })]),
      });
      const result = await syncFootage({ dropbox, db, rootPath: "/RAD/Footage", transcriber: t as never });

      expect(t.transcribe).not.toHaveBeenCalled();
      expect(result).toMatchObject({ moved: 1, reclassified: 0 });
      expect(String(updates.find((u) => u.table === kbDocuments)?.set.content))
        .toContain("[Finished ad /rad/footage/finished ads/2026/sunday.mp4]");
    });
  });
});
