import { describe, it, expect } from "vitest";
import {
  buildVisualPrompt,
  parseVisualAnalysis,
  classifyAudio,
  shouldAnalyseVisual,
  MAX_VISUAL_ATTEMPTS,
} from "@/domain/social/visual-analysis";

const answer = {
  summary: "Tara colours a doodle page while text asks a question.",
  visualType: "illustration",
  handDrawn: true,
  onScreenText: [{ at: "0s", text: "Do you colour to calm down?" }, { at: "6s", text: "Link in bio" }],
  firstFrame: "A half-coloured doodle page on a desk, a hand holding a marker.",
  visualHook: "Do you colour to calm down?",
  faceInFirst2s: false,
  productVisible: true,
  productFirstSeen: "0s",
  setting: "desk at home",
  emotion: "calm, relatable",
  branding: false,
};

describe("buildVisualPrompt", () => {
  it("labels each frame with its time, so on-screen text can be placed", () => {
    const p = buildVisualPrompt({ kind: "frames", account: "own", caption: "c", frameTimesMs: [0, 1000, 3000] });
    expect(p.labels).toEqual(["Frame at 0s", "Frame at 1s", "Frame at 3s"]);
    expect(p.prompt).toMatch(/faceInFirst2s/);
  });

  // A cover is chosen, not the opening: nothing about the first seconds can
  // be read from it, and the prompt must not ask.
  it("asks a cover nothing about the video's opening", () => {
    const p = buildVisualPrompt({ kind: "cover", account: "own", caption: "c" });
    expect(p.labels).toEqual(["Cover image"]);
    expect(p.prompt).toMatch(/cannot see the video/i);
  });

  it("labels carousel slides by number", () => {
    expect(buildVisualPrompt({ kind: "slides", account: "peer", caption: null, slideCount: 3 }).labels).toEqual(["Slide 1", "Slide 2", "Slide 3"]);
  });

  // Her style is hand-drawn illustration; a peer's hand-drawn art is not hers.
  it("asks about Tara's own illustration only on her posts", () => {
    expect(buildVisualPrompt({ kind: "image", account: "own", caption: "c" }).prompt).toMatch(/Tara/);
    expect(buildVisualPrompt({ kind: "image", account: "peer", caption: "c" }).prompt).not.toMatch(/Tara's own/);
  });
});

describe("parseVisualAnalysis", () => {
  it("reads every field from frames", () => {
    expect(parseVisualAnalysis(JSON.stringify(answer), "frames")).toEqual({
      summary: answer.summary,
      visualType: "illustration",
      handDrawn: true,
      onScreenText: answer.onScreenText,
      firstFrame: answer.firstFrame,
      visualHook: "Do you colour to calm down?",
      faceInFirst2s: false,
      productVisible: true,
      productFirstSeen: "0s",
      setting: "desk at home",
      emotion: "calm, relatable",
      branding: false,
    });
  });

  // From a cover the model may still volunteer an opening; it cannot know one.
  it("drops answers about the opening seconds when it only saw a cover", () => {
    const r = parseVisualAnalysis(JSON.stringify(answer), "cover")!;
    expect(r).toMatchObject({ firstFrame: null, faceInFirst2s: null, visualHook: null });
    expect(r.onScreenText).toEqual([{ at: "cover", text: "Do you colour to calm down?" }, { at: "cover", text: "Link in bio" }]);
  });

  it("files an unknown visual type as other", () => {
    expect(parseVisualAnalysis(JSON.stringify({ ...answer, visualType: "collage" }), "image")?.visualType).toBe("other");
  });

  // "not stated" is not false: an answer that is not a boolean is unknown.
  it("keeps a non-boolean yes/no as unknown", () => {
    expect(parseVisualAnalysis(JSON.stringify({ ...answer, productVisible: "maybe" }), "image")?.productVisible).toBeNull();
  });

  it("drops on-screen text entries with no text", () => {
    const r = parseVisualAnalysis(JSON.stringify({ ...answer, onScreenText: [{ at: "0s", text: "" }, "junk", { at: "3s", text: "Real" }] }), "frames");
    expect(r?.onScreenText).toEqual([{ at: "3s", text: "Real" }]);
  });

  it.each([["prose", "Here's what I see"], ["empty object", "{}"], ["broken JSON", "{ visualType: "]])("returns null for %s", (_l, raw) => {
    expect(parseVisualAnalysis(raw, "image")).toBeNull();
  });
});

describe("classifyAudio", () => {
  // Instagram withholds the video of reels carrying licensed music.
  it("calls a reel whose video Instagram withheld likely licensed music", () => {
    expect(classifyAudio({ videoAvailable: false, facts: null, transcriptionStatus: null })).toBe("licensed-music-likely");
  });

  it("calls a reel with words her voice or speech", () => {
    expect(classifyAudio({ videoAvailable: true, facts: { hasAudio: true, meanVolumeDb: -20 }, transcriptionStatus: "ok" })).toBe("speech");
  });

  it("calls sound without words music or sound", () => {
    expect(classifyAudio({ videoAvailable: true, facts: { hasAudio: true, meanVolumeDb: -18 }, transcriptionStatus: "no-audio" })).toBe("music-or-sound");
  });

  it("calls no audio stream, or near-silence, silent", () => {
    expect(classifyAudio({ videoAvailable: true, facts: { hasAudio: false, meanVolumeDb: null }, transcriptionStatus: null })).toBe("silent");
    expect(classifyAudio({ videoAvailable: true, facts: { hasAudio: true, meanVolumeDb: -75 }, transcriptionStatus: "no-audio" })).toBe("silent");
  });

  // Not transcribed yet: sound, but whether it is speech is unknown.
  it("does not guess speech before the transcript is in", () => {
    expect(classifyAudio({ videoAvailable: true, facts: { hasAudio: true, meanVolumeDb: -20 }, transcriptionStatus: null })).toBe("sound-unclassified");
  });
});

describe("shouldAnalyseVisual", () => {
  it("analyses new posts, retries errors until attempts run out, and leaves the rest", () => {
    expect(shouldAnalyseVisual(null)).toBe(true);
    expect(shouldAnalyseVisual({ status: "error", attempts: MAX_VISUAL_ATTEMPTS - 1 })).toBe(true);
    expect(shouldAnalyseVisual({ status: "error", attempts: MAX_VISUAL_ATTEMPTS })).toBe(false);
    expect(shouldAnalyseVisual({ status: "ok", attempts: 1 })).toBe(false);
    expect(shouldAnalyseVisual({ status: "unavailable", attempts: 1 })).toBe(false);
  });
});
