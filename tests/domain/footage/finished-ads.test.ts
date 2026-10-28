import { describe, it, expect } from "vitest";
import {
  footageKind, parseAdAnalysis, finishedAdDocument, footageCategory,
  AD_ANALYSIS_INSTRUCTION, FOOTAGE_CATEGORIES,
} from "@/domain/footage/finished-ads";
import { footageTranscript, relocateFootageDocument } from "@/domain/footage/footage";

describe("footageKind", () => {
  it("marks a clip in Finished Ads as a finished ad", () => {
    expect(footageKind("/rad/footage/finished ads/spring-launch.mp4", "/RAD/Footage")).toBe("finished-ad");
  });

  it("includes clips in folders inside Finished Ads", () => {
    expect(footageKind("/RAD/Footage/Finished Ads/2026/Oct/hook-3.mp4", "/RAD/Footage")).toBe("finished-ad");
  });

  it("treats everything else under the root as raw footage", () => {
    expect(footageKind("/rad/footage/planners/oct ad shoot/take-1.mov", "/RAD/Footage")).toBe("raw");
  });

  // A prefix match on the folder name would sweep these in too.
  it("does not mistake a similarly named folder or file for it", () => {
    expect(footageKind("/rad/footage/finished ads old/a.mp4", "/RAD/Footage")).toBe("raw");
    expect(footageKind("/rad/footage/finished ads.mp4", "/RAD/Footage")).toBe("raw");
  });

  it("only counts Finished Ads directly under the root", () => {
    expect(footageKind("/rad/footage/planners/finished ads/a.mp4", "/RAD/Footage")).toBe("raw");
  });

  it("accepts a root with a trailing slash", () => {
    expect(footageKind("/rad/footage/finished ads/a.mp4", "/RAD/Footage/")).toBe("finished-ad");
  });
});

describe("footageCategory", () => {
  // Separate categories are what keep a kb_search for raw clips from
  // returning finished ads, and the reverse.
  it("files finished ads apart from raw footage", () => {
    expect(footageCategory("raw")).toBe("footage");
    expect(footageCategory("finished-ad")).toBe("finished-ad");
    expect([...FOOTAGE_CATEGORIES].sort()).toEqual(["finished-ad", "footage"]);
  });
});

describe("AD_ANALYSIS_INSTRUCTION", () => {
  it("asks for the hook, angle, product, call to action and format", () => {
    for (const field of ["hook", "angle", "product", "callToAction", "format"]) {
      expect(AD_ANALYSIS_INSTRUCTION).toContain(`\`${field}\``);
    }
  });

  // It reads a transcript. A hook that is only on-screen text is invisible
  // to it, and it must not invent one.
  it("says it cannot see the picture", () => {
    expect(AD_ANALYSIS_INSTRUCTION).toMatch(/cannot see/i);
  });
});

describe("parseAdAnalysis", () => {
  it("reads every field", () => {
    expect(parseAdAnalysis(JSON.stringify({
      summary: "A teacher shows how the planner saves her Sunday.",
      tags: ["Teacher", "planner"],
      hook: "Sunday nights used to take me three hours.",
      angle: "Time saving",
      product: "Teacher Planner",
      callToAction: "Shop the planner",
      format: "Testimonial",
    }))).toEqual({
      summary: "A teacher shows how the planner saves her Sunday.",
      tags: ["teacher", "planner"],
      hook: "Sunday nights used to take me three hours.",
      angle: "time saving",
      product: "Teacher Planner",
      callToAction: "Shop the planner",
      format: "testimonial",
    });
  });

  it("finds the JSON inside surrounding prose", () => {
    expect(parseAdAnalysis('Here you go:\n{"summary":"s","hook":"h"}')?.hook).toBe("h");
  });

  // A missing field is unknown, not blank.
  it("records a field it was not given as null", () => {
    expect(parseAdAnalysis('{"summary":"s","angle":"  "}')).toMatchObject({
      hook: null, angle: null, product: null, callToAction: null, format: null,
    });
  });

  it("is null for something that is not JSON", () => {
    expect(parseAdAnalysis("I cannot help with that.")).toBeNull();
  });

  it("is null when nothing at all was found", () => {
    expect(parseAdAnalysis('{"summary":"","tags":[]}')).toBeNull();
  });
});

describe("finishedAdDocument", () => {
  const analysis = {
    summary: "A teacher's Sunday.", tags: ["teacher"], hook: "Sunday nights used to take me three hours.",
    angle: "time saving", product: "Teacher Planner", callToAction: "Shop the planner", format: "testimonial",
  };
  const doc = finishedAdDocument({
    name: "sunday.mp4", path: "/rad/footage/finished ads/sunday.mp4", analysis, transcript: "Sunday nights used to take me three hours.",
  });

  it("says it is a finished ad, not raw footage", () => {
    expect(doc.title).toBe("Finished ad: sunday.mp4");
    expect(doc.contextPrefix).toBe("Finished ad sunday.mp4");
    expect(doc.content.split("\n")[0]).toBe("[Finished ad /rad/footage/finished ads/sunday.mp4]");
    expect(doc.content).not.toMatch(/raw footage/i);
  });

  it("puts the hook and angle where a search will find them", () => {
    expect(doc.content).toContain("Hook: Sunday nights used to take me three hours.");
    expect(doc.content).toContain("Angle: time saving");
  });

  it("keeps the transcript recoverable", () => {
    expect(footageTranscript(doc.content)).toBe("Sunday nights used to take me three hours.");
  });

  it("can be relocated without becoming a footage document", () => {
    const moved = relocateFootageDocument(doc.content, { name: "s2.mp4", path: "/rad/footage/finished ads/2026/s2.mp4" }, "finished-ad");
    expect(moved).toMatchObject({ title: "Finished ad: s2.mp4", contextPrefix: "Finished ad s2.mp4" });
    expect(moved!.content.split("\n")[0]).toBe("[Finished ad /rad/footage/finished ads/2026/s2.mp4]");
  });

  it("is written without an analysis for an ad nothing could be read from", () => {
    const bare = finishedAdDocument({ name: "a.mp4", path: "/p/a.mp4", analysis: null, transcript: "Hi." });
    expect(bare.content).not.toContain("Hook:");
    expect(footageTranscript(bare.content)).toBe("Hi.");
  });
});
