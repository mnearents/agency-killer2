import { describe, it, expect, vi } from "vitest";
import {
  categoryFromPath,
  isMarkdownFile,
  detectChanges,
  syncKnowledgeBase,
} from "@/domain/knowledge/sync";
import type { DropboxFileEntry } from "@/integrations/dropbox";
import { createMockDropboxClient } from "../../mocks/dropbox";

function makeFile(path: string, rev = "rev1"): DropboxFileEntry {
  return {
    path,
    name: path.split("/").pop() || "",
    rev,
    size: 1024,
    isFolder: false,
  };
}

function makeFolder(path: string): DropboxFileEntry {
  return { path, name: path.split("/").pop() || "", rev: "", size: 0, isFolder: true };
}

// ─── Category mapping ─────────────────────────────────────────────────

describe("categoryFromPath", () => {
  it("maps 00-brand folder to 'brand'", () => {
    expect(categoryFromPath("/RAD/Agency/00-brand/philosophy.md")).toBe("brand");
  });

  it("maps 01-strategy folder to 'strategy'", () => {
    expect(categoryFromPath("/RAD/Agency/01-strategy/goals.md")).toBe("strategy");
  });

  it("maps 02-creative folder to 'creative'", () => {
    expect(categoryFromPath("/RAD/Agency/02-creative/guidelines.md")).toBe("creative");
  });

  it("maps 03-channels folder to 'email-sms'", () => {
    expect(categoryFromPath("/RAD/Agency/03-channels/calendar.md")).toBe("email-sms");
  });

  it("defaults to 'strategy' for unknown folders", () => {
    expect(categoryFromPath("/RAD/Agency/99-archive/old.md")).toBe("strategy");
  });

  it("handles nested paths", () => {
    expect(categoryFromPath("/RAD/Agency/00-brand/sub/deep/file.md")).toBe("brand");
  });
});

// ─── Markdown detection ───────────────────────────────────────────────

describe("isMarkdownFile", () => {
  it("returns true for .md files", () => {
    expect(isMarkdownFile(makeFile("/path/to/file.md"))).toBe(true);
  });

  it("returns true for .txt files", () => {
    expect(isMarkdownFile(makeFile("/path/to/file.txt"))).toBe(true);
  });

  it("returns false for other extensions", () => {
    expect(isMarkdownFile(makeFile("/path/to/image.png"))).toBe(false);
    expect(isMarkdownFile(makeFile("/path/to/video.mp4"))).toBe(false);
  });

  it("returns false for folders", () => {
    expect(isMarkdownFile(makeFolder("/path/to/folder"))).toBe(false);
  });
});

// ─── Change detection ─────────────────────────────────────────────────

describe("detectChanges", () => {
  it("identifies new files (not in lastSynced)", () => {
    const files = [makeFile("/a.md", "rev1"), makeFile("/b.md", "rev2")];
    const lastSynced = new Map<string, string>();

    const result = detectChanges(files, lastSynced);
    expect(result.newFiles).toHaveLength(2);
    expect(result.changedFiles).toHaveLength(0);
    expect(result.unchangedPaths).toHaveLength(0);
  });

  it("identifies changed files (rev differs)", () => {
    const files = [makeFile("/a.md", "rev2")];
    const lastSynced = new Map([["/a.md", "rev1"]]); // old rev

    const result = detectChanges(files, lastSynced);
    expect(result.newFiles).toHaveLength(0);
    expect(result.changedFiles).toHaveLength(1);
    expect(result.changedFiles[0].path).toBe("/a.md");
  });

  it("identifies unchanged files (rev matches)", () => {
    const files = [makeFile("/a.md", "rev1")];
    const lastSynced = new Map([["/a.md", "rev1"]]); // same rev

    const result = detectChanges(files, lastSynced);
    expect(result.newFiles).toHaveLength(0);
    expect(result.changedFiles).toHaveLength(0);
    expect(result.unchangedPaths).toHaveLength(1);
  });

  it("handles mixed new, changed, and unchanged", () => {
    const files = [
      makeFile("/new.md", "rev1"),
      makeFile("/changed.md", "rev2"),
      makeFile("/same.md", "rev1"),
    ];
    const lastSynced = new Map([
      ["/changed.md", "rev1"],
      ["/same.md", "rev1"],
    ]);

    const result = detectChanges(files, lastSynced);
    expect(result.newFiles).toHaveLength(1);
    expect(result.changedFiles).toHaveLength(1);
    expect(result.unchangedPaths).toHaveLength(1);
  });
});

// ─── Full sync orchestration ──────────────────────────────────────────

describe("syncKnowledgeBase", () => {
  it("lists folder, downloads new/changed files, ingests them", async () => {
    const client = createMockDropboxClient({
      listFolder: vi.fn().mockResolvedValue([
        makeFile("/RAD/Agency/00-brand/philosophy.md", "rev1"),
        makeFile("/RAD/Agency/01-strategy/goals.md", "rev1"),
        makeFolder("/RAD/Agency/02-creative"),
        makeFile("/RAD/Agency/00-brand/logo.png", "rev1"), // not markdown
      ]),
      downloadText: vi.fn()
        .mockResolvedValueOnce("## Values\n\nQuality over quantity.")
        .mockResolvedValueOnce("## Revenue Goals\n\nHit $500k this year."),
    });

    const result = await syncKnowledgeBase(
      client,
      "/RAD/Agency",
      new Map(), // nothing synced before
      new Set()
    );

    expect(result.totalFiles).toBe(2); // only markdown files
    expect(result.newFiles).toBe(2);
    expect(result.unchangedFiles).toBe(0);
    expect(result.ingestionResults).toHaveLength(2);

    // Verify download was called for each markdown file
    expect(client.downloadText).toHaveBeenCalledTimes(2);
  });

  it("skips unchanged files (matching rev)", async () => {
    const client = createMockDropboxClient({
      listFolder: vi.fn().mockResolvedValue([
        makeFile("/RAD/Agency/00-brand/philosophy.md", "rev1"),
      ]),
      downloadText: vi.fn(),
    });

    const lastSynced = new Map([["/RAD/Agency/00-brand/philosophy.md", "rev1"]]);

    const result = await syncKnowledgeBase(
      client,
      "/RAD/Agency",
      lastSynced,
      new Set()
    );

    expect(result.unchangedFiles).toBe(1);
    expect(result.newFiles).toBe(0);
    // Should NOT download unchanged files
    expect(client.downloadText).not.toHaveBeenCalled();
  });

  it("re-downloads changed files (different rev)", async () => {
    const client = createMockDropboxClient({
      listFolder: vi.fn().mockResolvedValue([
        makeFile("/RAD/Agency/00-brand/philosophy.md", "rev2"), // new rev
      ]),
      downloadText: vi.fn().mockResolvedValue("Updated brand philosophy."),
    });

    const lastSynced = new Map([["/RAD/Agency/00-brand/philosophy.md", "rev1"]]);

    const result = await syncKnowledgeBase(
      client,
      "/RAD/Agency",
      lastSynced,
      new Set()
    );

    expect(result.changedFiles).toBe(1);
    expect(client.downloadText).toHaveBeenCalledTimes(1);
  });

  it("assigns correct categories from folder paths", async () => {
    const client = createMockDropboxClient({
      listFolder: vi.fn().mockResolvedValue([
        makeFile("/RAD/Agency/00-brand/values.md", "rev1"),
      ]),
      downloadText: vi.fn().mockResolvedValue("Brand values content."),
    });

    const result = await syncKnowledgeBase(client, "/RAD/Agency", new Map(), new Set());

    // The ingested chunks should have category "brand"
    const firstChunk = result.ingestionResults[0]?.rows[0];
    expect(firstChunk?.row.category).toBe("brand");
  });
});
