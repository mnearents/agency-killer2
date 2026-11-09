import { describe, it, expect } from "vitest";
import {
  parsePostAnalysis,
  buildPostAnalysisPrompt,
  shouldAnalysePost,
  MAX_ANALYSIS_ATTEMPTS,
  readyForAnalysis,
} from "@/domain/social/post-analysis";

const good = JSON.stringify({
  summary: "Tara shows how she plans a homeschool week in ten minutes.",
  hook: "I plan our whole homeschool week in ten minutes.",
  hookType: "bold-claim",
  topic: "homeschool planning",
  approach: "teach",
  audience: "homeschool parents",
  product: "Homeschool Planner",
  callToAction: "Link in bio",
});

describe("parsePostAnalysis", () => {
  it("reads every field", () => {
    expect(parsePostAnalysis(good, "transcript")).toEqual({
      summary: "Tara shows how she plans a homeschool week in ten minutes.",
      hook: "I plan our whole homeschool week in ten minutes.",
      hookSource: "speech",
      hookType: "bold-claim",
      topic: "homeschool planning",
      approach: "teach",
      audience: "homeschool parents",
      product: "Homeschool Planner",
      callToAction: "Link in bio",
    });
  });

  // From the caption alone the hook is the caption's opening, and saying it
  // came from speech would credit a reel's first second with words nobody said.
  it("records a hook read from the caption as a caption hook", () => {
    expect(parsePostAnalysis(good, "caption")?.hookSource).toBe("caption");
  });

  // Patterns are counted by hook type, so a free-text label would split one
  // kind across spellings and every group would look too small to read.
  it("files a hook type outside the list as other", () => {
    const r = parsePostAnalysis(JSON.stringify({ ...JSON.parse(good), hookType: "Curiosity Gap!" }), "transcript");
    expect(r?.hookType).toBe("other");
  });

  it("files an approach outside the list as other", () => {
    const r = parsePostAnalysis(JSON.stringify({ ...JSON.parse(good), approach: "vlog" }), "transcript");
    expect(r?.approach).toBe("other");
  });

  it("keeps a field the model left out as null, and no hook as no hook source", () => {
    const r = parsePostAnalysis(JSON.stringify({ summary: "A product photo.", topic: "planners", hookType: "none" }), "caption");
    expect(r).toMatchObject({ hook: null, hookSource: null, product: null, callToAction: null, hookType: "none" });
  });

  // Fail closed: a response that cannot be read is not an analysis that found
  // nothing, and must be retried rather than stored as empty.
  it.each([
    ["not JSON", "I'd be happy to help!"],
    ["malformed JSON", "{ summary: nope"],
    ["an empty object", "{}"],
    ["an array", "[1,2]"],
  ])("returns null for %s", (_label, raw) => {
    expect(parsePostAnalysis(raw, "transcript")).toBeNull();
  });
});

describe("buildPostAnalysisPrompt", () => {
  it("gives the transcript when there is one and says the video is unseen", () => {
    const p = buildPostAnalysisPrompt({ format: "Reel", caption: "New planner!", transcript: "Hey friends, today..." })!;
    expect(p.basis).toBe("transcript");
    expect(p.prompt).toContain("Hey friends, today...");
    expect(p.prompt).toMatch(/cannot see/i);
  });

  it("works from the caption alone when there is no transcript", () => {
    const p = buildPostAnalysisPrompt({ format: "Carousel", caption: "5 ways to use stickers", transcript: null })!;
    expect(p.basis).toBe("caption");
    expect(p.prompt).toContain("5 ways to use stickers");
    expect(p.prompt).not.toContain("Transcript:");
  });

  // Nothing to read is not a post to analyse: the model would invent one.
  it("refuses a post with neither caption nor transcript", () => {
    expect(buildPostAnalysisPrompt({ format: "Image", caption: "  ", transcript: null })).toBeNull();
  });
});

describe("shouldAnalysePost", () => {
  it("analyses a post never analysed", () => {
    expect(shouldAnalysePost(null)).toBe(true);
  });

  it("retries a failed analysis until the attempts run out", () => {
    expect(shouldAnalysePost({ status: "error", attempts: MAX_ANALYSIS_ATTEMPTS - 1 })).toBe(true);
    expect(shouldAnalysePost({ status: "error", attempts: MAX_ANALYSIS_ATTEMPTS })).toBe(false);
  });

  it("does not repeat a finished analysis", () => {
    expect(shouldAnalysePost({ status: "ok", attempts: 1 })).toBe(false);
  });
});

describe("readyForAnalysis", () => {
  const reel = { mediaType: "VIDEO", mediaProductType: "REELS", transcriptionStatus: null as string | null, transcriptionAttempts: 0 };

  it("analyses a carousel at once", () => {
    expect(readyForAnalysis({ ...reel, mediaType: "CAROUSEL_ALBUM", mediaProductType: "FEED" }, 3)).toBe(true);
  });

  it("waits for a reel not yet transcribed, or whose transcription will be retried", () => {
    expect(readyForAnalysis(reel, 3)).toBe(false);
    expect(readyForAnalysis({ ...reel, transcriptionStatus: "error", transcriptionAttempts: 1 }, 3)).toBe(false);
  });

  it("analyses a reel once its transcription is settled", () => {
    expect(readyForAnalysis({ ...reel, transcriptionStatus: "ok", transcriptionAttempts: 1 }, 3)).toBe(true);
    expect(readyForAnalysis({ ...reel, transcriptionStatus: "no-audio", transcriptionAttempts: 1 }, 3)).toBe(true);
    expect(readyForAnalysis({ ...reel, transcriptionStatus: "error", transcriptionAttempts: 3 }, 3)).toBe(true);
  });
});
