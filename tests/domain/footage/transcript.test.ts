import { describe, it, expect } from "vitest";
import {
  segmentTranscript,
  footageTranscriptResult,
  PAUSE_SPLIT_MS,
  type StoredWord,
  type TranscriptClip,
} from "@/domain/footage/transcript";

/** Words spoken back to back, 300ms each, from `startMs`. */
function spoken(text: string, startMs = 0, gapMs = 0): StoredWord[] {
  return text.split(" ").map((t, i) => ({
    text: t,
    start: startMs + i * (300 + gapMs),
    end: startMs + i * (300 + gapMs) + 300,
    confidence: 0.9,
  }));
}

describe("segmentTranscript", () => {
  it("splits at the end of each sentence and times each from its words", () => {
    const words = [...spoken("Hi there. How are you?"), ...spoken("Good.", 2000)];
    expect(segmentTranscript(words).map(({ startMs, endMs, text }) => ({ startMs, endMs, text }))).toEqual([
      { startMs: 0, endMs: 600, text: "Hi there." },
      { startMs: 600, endMs: 1500, text: "How are you?" },
      { startMs: 2000, endMs: 2300, text: "Good." },
    ]);
  });

  it("treats closing quotes and brackets after the stop as the end of a sentence", () => {
    const words = spoken('She said "stop." Then (we left.) Done!');
    expect(segmentTranscript(words).map((s) => s.text)).toEqual(['She said "stop."', "Then (we left.)", "Done!"]);
  });

  // "Mr." is not the end of anything, and a cut there splits a name in half.
  it("does not end a sentence at a common abbreviation", () => {
    expect(segmentTranscript(spoken("Ask Dr. Smith vs. Mr. Jones today.")).map((s) => s.text))
      .toEqual(["Ask Dr. Smith vs. Mr. Jones today."]);
  });

  // A long pause mid-sentence is a restart or a fumble — exactly where an
  // editor wants a cut point, and invisible if the sentence is one segment.
  it("starts a new segment at a long pause even mid-sentence", () => {
    const words = [...spoken("So the planner"), ...spoken("the planner is great.", 900 + PAUSE_SPLIT_MS)];
    const segments = segmentTranscript(words);
    expect(segments.map((s) => s.text)).toEqual(["So the planner", "the planner is great."]);
    expect(segments[1].gapBeforeMs).toBe(PAUSE_SPLIT_MS);
  });

  it("keeps a pause just under the threshold inside the segment", () => {
    const words = [...spoken("So the"), ...spoken("planner is great.", 600 + PAUSE_SPLIT_MS - 1)];
    expect(segmentTranscript(words)).toHaveLength(1);
  });

  it("measures the first segment's gap from the start of the clip", () => {
    expect(segmentTranscript(spoken("Hello.", 1200))[0].gapBeforeMs).toBe(1200);
  });

  it("closes a final sentence that has no stop", () => {
    expect(segmentTranscript(spoken("Hello. and then")).map((s) => s.text)).toEqual(["Hello.", "and then"]);
  });

  it("reports the least confident word, so a mumble can be found", () => {
    const words = spoken("one two three.");
    words[1].confidence = 0.41;
    expect(segmentTranscript(words)[0].minConfidence).toBe(0.41);
  });

  it("leaves words out unless asked, and renames their times when included", () => {
    const words = spoken("Hi there.");
    expect(segmentTranscript(words)[0]).not.toHaveProperty("words");
    expect(segmentTranscript(words, { withWords: true })[0].words).toEqual([
      { text: "Hi", startMs: 0, endMs: 300, confidence: 0.9 },
      { text: "there.", startMs: 300, endMs: 600, confidence: 0.9 },
    ]);
  });

  it("returns no segments for no words", () => {
    expect(segmentTranscript([])).toEqual([]);
  });
});

const clip = (over: Partial<TranscriptClip> = {}): TranscriptClip => ({
  id: "id:abc",
  path: "/rad/footage/oct ad shoot/a001.mov",
  name: "A001.mov",
  kind: "raw",
  transcriptionStatus: "ok",
  transcriptionDetail: null,
  durationMs: 4000,
  words: spoken("Hi there. How are you?"),
  ...over,
});

describe("footageTranscriptResult", () => {
  it("returns the clip, its length and its segments", () => {
    const r = footageTranscriptResult([clip()], { withWords: false }) as Record<string, any>;
    expect(r.clip).toEqual({
      id: "id:abc", path: "/rad/footage/oct ad shoot/a001.mov", name: "A001.mov", kind: "raw",
      transcriptionStatus: "ok", durationMs: 4000, durationSeconds: 4,
    });
    expect(r.timed).toBe(true);
    expect(r.wordCount).toBe(5);
    expect(r.segments).toHaveLength(2);
    // What follows the last word is room to cut into, so it is stated.
    expect(r.trailingSilenceMs).toBe(2500);
  });

  // An agent told "clip not found" with no next step guesses another path.
  it("returns an error naming where paths come from when nothing matched", () => {
    expect(footageTranscriptResult([], { withWords: false })).toEqual({
      error: expect.stringMatching(/No clip matched.*footage.*finished_ads/),
    });
  });

  // Paths are not unique: two clips can pass through the same name mid-move.
  it("refuses to choose between two clips at one path and lists their ids", () => {
    const r = footageTranscriptResult([clip(), clip({ id: "id:def" })], { withWords: false }) as Record<string, any>;
    expect(r.error).toMatch(/2 clips.*id/);
    expect(r.candidates.map((c: { id: string }) => c.id)).toEqual(["id:abc", "id:def"]);
    expect(r).not.toHaveProperty("segments");
  });

  it("says a silent clip is silent, with no segments rather than none found", () => {
    const r = footageTranscriptResult([clip({ transcriptionStatus: "no-audio", words: [] })], { withWords: false }) as Record<string, any>;
    expect(r.timed).toBe(false);
    expect(r.segments).toEqual([]);
    expect(r.note).toMatch(/no speech/i);
  });

  it("says a failed clip failed, and why", () => {
    const r = footageTranscriptResult(
      [clip({ transcriptionStatus: "error", transcriptionDetail: "status: error — Transcoding failed", words: null, durationMs: null })],
      { withWords: false },
    ) as Record<string, any>;
    expect(r.segments).toBeNull();
    expect(r.note).toMatch(/could not be transcribed.*Transcoding failed/);
  });

  it("says a clip not yet transcribed is waiting for the sync", () => {
    const r = footageTranscriptResult([clip({ transcriptionStatus: null, words: null, durationMs: null })], { withWords: false }) as Record<string, any>;
    expect(r.segments).toBeNull();
    expect(r.note).toMatch(/not been transcribed yet/);
  });

  // A transcript with no timings must not look like a clip with no speech.
  it("distinguishes a transcribed clip whose timings are missing from a silent one", () => {
    const r = footageTranscriptResult([clip({ words: null })], { withWords: false }) as Record<string, any>;
    expect(r.timed).toBe(false);
    expect(r.segments).toBeNull();
    expect(r.note).toMatch(/timings/);
  });

  it("treats an empty word list on a transcribed clip as missing timings, not as no speech", () => {
    const r = footageTranscriptResult([clip({ words: [] })], { withWords: false }) as Record<string, any>;
    expect(r.segments).toBeNull();
    expect(r.note).toMatch(/timings/);
  });

  it("includes each word when asked", () => {
    const r = footageTranscriptResult([clip()], { withWords: true }) as Record<string, any>;
    expect(r.segments[0].words).toHaveLength(2);
  });
});
