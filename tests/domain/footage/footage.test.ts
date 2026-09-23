import { describe, it, expect } from "vitest";
import {
  isTranscribableMedia, extensionOf, planFootage, parseTags, footageDocument,
  VIDEO_EXTENSIONS, TAGGING_INSTRUCTION,
} from "@/domain/footage/footage";
import { MAX_TRANSCRIPTION_ATTEMPTS } from "@/domain/social/transcription";
import type { DropboxFileEntry } from "@/integrations/dropbox";

const file = (over: Partial<DropboxFileEntry> = {}): DropboxFileEntry => ({
  path: "/rad/footage/clip.mp4", name: "clip.mp4", rev: "r1", size: 1000, isFolder: false, ...over,
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
      rev: "r1", transcriptionStatus: "ok", transcriptionAttempts: 1,
    })).toEqual({ action: "skip", reason: "settled" });
  });

  // Silence is the ordinary case for b-roll, not a fault, and retrying it
  // spends an API call to learn what is already recorded.
  it("skips silent footage rather than retrying it", () => {
    expect(planFootage(file(), {
      rev: "r1", transcriptionStatus: "no-audio", transcriptionAttempts: 1,
    }).action).toBe("skip");
  });

  it("retries a file that errored", () => {
    expect(planFootage(file(), {
      rev: "r1", transcriptionStatus: "error", transcriptionAttempts: 1,
    })).toEqual({ action: "transcribe", reason: "retry" });
  });

  it("gives up after the attempt limit", () => {
    expect(planFootage(file(), {
      rev: "r1", transcriptionStatus: "error", transcriptionAttempts: MAX_TRANSCRIPTION_ATTEMPTS,
    })).toEqual({ action: "skip", reason: "attempts-exhausted" });
  });

  // A changed rev means different bytes, so the previous outcome described a
  // different file. Without this, re-uploading a fixed export is ignored.
  it("transcribes again when the file was replaced, even if it was settled", () => {
    expect(planFootage(file({ rev: "r2" }), {
      rev: "r1", transcriptionStatus: "no-audio", transcriptionAttempts: 1,
    })).toEqual({ action: "transcribe", reason: "replaced" });
  });

  it("re-tries a replaced file even once attempts were exhausted", () => {
    expect(planFootage(file({ rev: "r2" }), {
      rev: "r1", transcriptionStatus: "error", transcriptionAttempts: 9,
    }).action).toBe("transcribe");
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
