import { describe, it, expect } from "vitest";
import {
  isTranscribableMedia, extensionOf, planFootage, parseTags, footageDocument,
  reconcileFootage, relocateFootageDocument, footageSourceFile,
  VIDEO_EXTENSIONS, TAGGING_INSTRUCTION, type StoredFootage,
} from "@/domain/footage/footage";
import { MAX_TRANSCRIPTION_ATTEMPTS } from "@/domain/social/transcription";
import type { DropboxFileEntry } from "@/integrations/dropbox";

const file = (over: Partial<DropboxFileEntry> = {}): DropboxFileEntry => ({
  id: "id:clip", path: "/rad/footage/clip.mp4", name: "clip.mp4", rev: "r1", contentHash: "h1",
  size: 1000, isFolder: false, ...over,
});

const stored = (over: Partial<StoredFootage> = {}): StoredFootage => ({
  dropboxId: "id:clip", path: "/rad/footage/clip.mp4", rev: "r1", contentHash: "h1",
  transcriptionStatus: "ok", transcriptionAttempts: 1, ...over,
});

describe("isTranscribableMedia", () => {
  it("accepts the common video formats", () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(isTranscribableMedia(file({ name: `a${ext}` })), ext).toBe(true);
    }
  });

  it("accepts audio, since a voice memo belongs with the footage", () => {
    expect(isTranscribableMedia(file({ name: "note.m4a" }))).toBe(true);
  });

  it("is case-insensitive about the extension", () => {
    expect(isTranscribableMedia(file({ name: "CLIP.MOV" }))).toBe(true);
  });

  // A list rather than "not a document", so an unanticipated file is skipped
  // and countable instead of handed to a transcriber that will fail on it.
  it("rejects anything not on the list", () => {
    for (const name of ["notes.md", "thumb.jpg", "project.prproj", "noextension"]) {
      expect(isTranscribableMedia(file({ name })), name).toBe(false);
    }
  });

  it("rejects folders", () => {
    expect(isTranscribableMedia(file({ name: "b-roll", isFolder: true }))).toBe(false);
  });
});

describe("extensionOf", () => {
  it("lowercases the extension", () => expect(extensionOf("A.MP4")).toBe(".mp4"));
  it("returns empty for a file with no extension", () => expect(extensionOf("clip")).toBe(""));
  it("takes the last dot, not the first", () => expect(extensionOf("a.b.mov")).toBe(".mov"));
});

describe("planFootage", () => {
  it("transcribes a file it has not seen", () => {
    expect(planFootage(file(), undefined)).toEqual({ action: "transcribe", reason: "new" });
  });

  it("skips a file already transcribed", () => {
    expect(planFootage(file(), {
      rev: "r1", contentHash: null, transcriptionStatus: "ok", transcriptionAttempts: 1,
    })).toEqual({ action: "skip", reason: "settled" });
  });

  // Silence is the ordinary case for b-roll, not a fault, and retrying it
  // spends an API call to learn what is already recorded.
  it("skips silent footage rather than retrying it", () => {
    expect(planFootage(file(), {
      rev: "r1", contentHash: null, transcriptionStatus: "no-audio", transcriptionAttempts: 1,
    }).action).toBe("skip");
  });

  it("retries a file that errored", () => {
    expect(planFootage(file(), {
      rev: "r1", contentHash: null, transcriptionStatus: "error", transcriptionAttempts: 1,
    })).toEqual({ action: "transcribe", reason: "retry" });
  });

  it("gives up after the attempt limit", () => {
    expect(planFootage(file(), {
      rev: "r1", contentHash: null, transcriptionStatus: "error", transcriptionAttempts: MAX_TRANSCRIPTION_ATTEMPTS,
    })).toEqual({ action: "skip", reason: "attempts-exhausted" });
  });

  // A changed rev means different bytes, so the previous outcome described a
  // different file. Without this, re-uploading a fixed export is ignored.
  it("transcribes again when the file was replaced, even if it was settled", () => {
    expect(planFootage(file({ rev: "r2" }), {
      rev: "r1", contentHash: null, transcriptionStatus: "no-audio", transcriptionAttempts: 1,
    })).toEqual({ action: "transcribe", reason: "replaced" });
  });

  it("re-tries a replaced file even once attempts were exhausted", () => {
    expect(planFootage(file({ rev: "r2" }), {
      rev: "r1", contentHash: null, transcriptionStatus: "error", transcriptionAttempts: 9,
    }).action).toBe("transcribe");
  });

  // The rev is not evidence of new bytes once the content hash is known: a
  // move can change it, and a move must not buy a second transcription.
  it("does not treat a changed rev as a replacement when the content is the same", () => {
    expect(planFootage(file({ rev: "r2", contentHash: "h1" }), {
      rev: "r1", contentHash: "h1", transcriptionStatus: "ok", transcriptionAttempts: 1,
    })).toEqual({ action: "skip", reason: "settled" });
  });

  it("treats changed content as a replacement even when the rev is unchanged", () => {
    expect(planFootage(file({ rev: "r1", contentHash: "h2" }), {
      rev: "r1", contentHash: "h1", transcriptionStatus: "ok", transcriptionAttempts: 1,
    })).toEqual({ action: "transcribe", reason: "replaced" });
  });
});

describe("reconcileFootage", () => {
  // The point of keying on the Dropbox file ID: organising the folder is not
  // new footage, and must not be paid for twice.
  it("recognises a moved and renamed clip by its file ID", () => {
    const result = reconcileFootage(
      [file({ path: "/RAD/Footage/2026/Unboxing.mp4", name: "Unboxing.mp4" })],
      [stored()],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].known).toEqual(stored());
    expect(result.matches[0].moved).toBe(true);
    expect(result.matches[0].adopted).toBe(false);
    expect(result.remove).toEqual([]);
  });

  it("does not report a clip as moved when only the path's case differs", () => {
    const result = reconcileFootage([file({ path: "/RAD/Footage/clip.mp4" })], [stored()]);
    expect(result.matches[0].moved).toBe(false);
  });

  it("removes a clip whose file ID is no longer in the folder", () => {
    const gone = stored({ dropboxId: "id:gone", path: "/rad/footage/gone.mp4" });
    const result = reconcileFootage([file()], [stored(), gone]);
    expect(result.remove).toEqual([gone]);
  });

  it("removes everything when the folder holds no media", () => {
    expect(reconcileFootage([], [stored()]).remove).toEqual([stored()]);
  });

  it("treats an unknown file ID as new", () => {
    const result = reconcileFootage([file({ id: "id:new", path: "/rad/footage/new.mp4" })], [stored()]);
    expect(result.matches[0].known).toBeUndefined();
    expect(result.remove).toEqual([stored()]);
  });

  // Rows written before file IDs were recorded. Adopting them by path is what
  // stops the first run after this change re-transcribing every clip.
  it("adopts a row that predates file IDs when the path still matches", () => {
    const legacy = stored({ dropboxId: null, contentHash: null });
    const result = reconcileFootage([file({ path: "/RAD/Footage/clip.mp4" })], [legacy]);
    expect(result.matches[0]).toMatchObject({ known: legacy, adopted: true, moved: false });
    expect(result.remove).toEqual([]);
  });

  // A rev identifies one revision of one file, so a pre-ID row with the same
  // rev is the same clip, moved before IDs were recorded.
  it("adopts a pre-ID row by rev when the clip was already moved", () => {
    const legacy = stored({ dropboxId: null, contentHash: null, path: "/rad/footage/old-name.mp4" });
    const result = reconcileFootage([file({ path: "/rad/footage/new/clip.mp4" })], [legacy]);
    expect(result.matches[0]).toMatchObject({ known: legacy, adopted: true, moved: true });
    expect(result.remove).toEqual([]);
  });

  // Two candidates is a guess, and a wrong guess attaches one clip's
  // transcript to another. Re-transcribing is the safe cost.
  it("does not adopt by rev when the rev matches more than one pre-ID row", () => {
    const a = stored({ dropboxId: null, contentHash: null, path: "/rad/footage/a.mp4" });
    const b = stored({ dropboxId: null, contentHash: null, path: "/rad/footage/b.mp4" });
    const result = reconcileFootage([file({ path: "/rad/footage/c.mp4" })], [a, b]);
    expect(result.matches[0].known).toBeUndefined();
    expect(result.remove).toEqual([a, b]);
  });

  it("never adopts on an empty rev", () => {
    const legacy = stored({ dropboxId: null, contentHash: null, rev: "", path: "/rad/footage/a.mp4" });
    const result = reconcileFootage([file({ rev: "", path: "/rad/footage/b.mp4" })], [legacy]);
    expect(result.matches[0].known).toBeUndefined();
  });

  it("adopts a pre-ID row at most once", () => {
    const legacy = stored({ dropboxId: null, contentHash: null, path: "/rad/footage/old.mp4" });
    const result = reconcileFootage(
      [file({ id: "id:a", path: "/rad/footage/a.mp4" }), file({ id: "id:b", path: "/rad/footage/b.mp4" })],
      [legacy],
    );
    expect(result.matches.filter((m) => m.known !== undefined)).toHaveLength(1);
  });

  it("removes a pre-ID row that nothing in the folder matches", () => {
    const legacy = stored({ dropboxId: null, contentHash: null, rev: "r9", path: "/rad/footage/gone.mp4" });
    expect(reconcileFootage([file()], [legacy]).remove).toEqual([legacy]);
  });
});

describe("relocateFootageDocument", () => {
  it("points the document at the new path and keeps the transcript", () => {
    const before = footageDocument({
      name: "clip.mp4", path: "/rad/footage/clip.mp4",
      summary: "Tara unboxes the planner", tags: ["unboxing"], transcript: "so this just arrived",
    });
    const after = relocateFootageDocument(before.content, { name: "Unboxing.mp4", path: "/rad/footage/2026/unboxing.mp4" });
    expect(after).toEqual(footageDocument({
      name: "Unboxing.mp4", path: "/rad/footage/2026/unboxing.mp4",
      summary: "Tara unboxes the planner", tags: ["unboxing"], transcript: "so this just arrived",
    }));
  });

  // A body this code did not write cannot be safely rewritten; the caller
  // retranscribes instead of storing a guess.
  it("returns null for a body without the footage header", () => {
    expect(relocateFootageDocument("Transcript:\nhello", { name: "a.mp4", path: "/a.mp4" })).toBeNull();
  });
});

describe("footageSourceFile", () => {
  it("keys the knowledge base document on the file ID, not the path", () => {
    expect(footageSourceFile("id:abc")).toBe("footage:id:abc");
  });
});

describe("parseTags", () => {
  it("parses a clean response", () => {
    expect(parseTags('{"summary":"Tara unboxes the 2026 planner","tags":["planner","unboxing"]}'))
      .toEqual({ summary: "Tara unboxes the 2026 planner", tags: ["planner", "unboxing"] });
  });

  it("finds the JSON inside surrounding prose", () => {
    expect(parseTags('Sure!\n```json\n{"summary":"A","tags":["b"]}\n```')?.summary).toBe("A");
  });

  it("lowercases and de-duplicates tags", () => {
    expect(parseTags('{"summary":"x","tags":["Planner","planner","  PLANNER "]}')?.tags)
      .toEqual(["planner"]);
  });

  it("drops non-string tags rather than stringifying them", () => {
    expect(parseTags('{"summary":"x","tags":["a",1,null,"b"]}')?.tags).toEqual(["a", "b"]);
  });

  // A clip with no tags because the model returned nonsense and one with no
  // tags because it is silent must not look the same in the table.
  it("returns null for unparseable output rather than an empty tag set", () => {
    expect(parseTags("I could not read that video")).toBeNull();
    expect(parseTags('{"broken": ')).toBeNull();
  });

  it("returns null when the response has neither a summary nor tags", () => {
    expect(parseTags('{"summary":"","tags":[]}')).toBeNull();
  });

  it("accepts a summary with no tags", () => {
    expect(parseTags('{"summary":"A quiet shot","tags":[]}')).toEqual({
      summary: "A quiet shot", tags: [],
    });
  });

  // The model cannot see the video, and a tag asserting what is on screen
  // would be invented.
  it("instructs the model not to guess at visuals", () => {
    expect(TAGGING_INSTRUCTION).toMatch(/cannot see/i);
  });
});

describe("footageDocument", () => {
  // A search for "unboxing" should find a clip tagged unboxing even when the
  // speaker never says the word, so tags go in the embedded text.
  it("puts the tags and summary in the searchable body", () => {
    const doc = footageDocument({
      name: "clip.mp4", path: "/rad/footage/clip.mp4",
      summary: "Tara unboxes the planner", tags: ["planner", "unboxing"],
      transcript: "so this just arrived",
    });
    expect(doc.content).toContain("unboxing");
    expect(doc.content).toContain("Tara unboxes the planner");
    expect(doc.content).toContain("so this just arrived");
  });

  it("names the file in the title so a search result points at something", () => {
    expect(footageDocument({
      name: "clip.mp4", path: "/p", summary: null, tags: null, transcript: "t",
    }).title).toBe("Footage: clip.mp4");
  });

  it("omits the tag line entirely when there are no tags", () => {
    expect(footageDocument({
      name: "c.mp4", path: "/p", summary: null, tags: [], transcript: "t",
    }).content).not.toContain("Tags:");
  });
});
