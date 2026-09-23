import { describe, it, expect, vi } from "vitest";
import { syncFootage } from "@/domain/footage/sync";
import { createMockDropboxClient } from "../../mocks/dropbox";
import type { DropboxFileEntry } from "@/integrations/dropbox";

const entry = (over: Partial<DropboxFileEntry> = {}): DropboxFileEntry => ({
  path: "/RAD/Footage/clip.mp4", name: "clip.mp4", rev: "r1", size: 2_000_000, isFolder: false, ...over,
});

/** Just enough Drizzle to observe what the sync would write. */
function fakeDb() {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { onConflictDoUpdate: async () => undefined, then: undefined };
      },
    }),
    delete: () => ({ where: async () => undefined }),
  };
  return { db: db as never, inserted };
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
    expect(doc!.sourceFile).toBe("footage:/rad/footage/clip.mp4");
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
});
