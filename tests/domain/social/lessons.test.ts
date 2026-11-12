import { describe, it, expect } from "vitest";
import {
  buildLessonPrompt,
  parseLessons,
  shouldExtractLessons,
  lessonsReady,
  groupLessons,
  MAX_LESSONS_PER_POST,
  type LessonRow,
} from "@/domain/social/lessons";

describe("buildLessonPrompt", () => {
  it("reads the caption, the slides' text and the transcript, and says which", () => {
    const r = buildLessonPrompt({
      username: "lana.k.social", format: "Carousel", caption: "3 hooks that work",
      slideText: [{ at: "Slide 1", text: "Stop scrolling" }, { at: "Slide 2", text: "Open with the result" }],
      transcript: "Here's the thing about hooks.",
    })!;
    expect(r.basis).toBe("caption+slides+transcript");
    expect(r.prompt).toContain("@lana.k.social");
    expect(r.prompt).toContain("Slide 2: Open with the result");
    expect(r.prompt).toContain("Here's the thing about hooks.");
  });

  // Their words are source material, not ours to reuse.
  it("asks for principles in our own words, and for claims to be named as claims", () => {
    const { prompt } = buildLessonPrompt({ username: "a", format: "Reel", caption: "c", slideText: null, transcript: null })!;
    expect(prompt).toMatch(/own words/);
    expect(prompt).toMatch(/"claim"/);
    expect(prompt).toMatch(/empty list/i);
  });

  it("has nothing to read when there is no caption, slide text or transcript", () => {
    expect(buildLessonPrompt({ username: "a", format: "Reel", caption: "  ", slideText: [], transcript: null })).toBeNull();
  });
});

describe("parseLessons", () => {
  const one = { principle: "Open with the result, not the setup.", howToApply: "Put the finished page on screen at 0s.", area: "hook", kind: "practice", quote: "Show the after first" };

  it("reads a list of lessons", () => {
    expect(parseLessons(JSON.stringify({ lessons: [one] }))).toEqual([one]);
  });

  // A post that teaches nothing is an answer, not a failure.
  it("accepts an empty list as no lessons", () => {
    expect(parseLessons('{"lessons": []}')).toEqual([]);
  });

  it.each(["Great post!", "{}", '{"lessons": "none"}', "[1,2]", ""])("fails closed on %j", (raw) => {
    expect(parseLessons(raw)).toBeNull();
  });

  it("drops a lesson with no principle and keeps the rest", () => {
    expect(parseLessons(JSON.stringify({ lessons: [{ area: "hook" }, one] }))).toEqual([one]);
  });

  it("files an unknown area under other", () => {
    expect(parseLessons(JSON.stringify({ lessons: [{ ...one, area: "vibes" }] }))![0].area).toBe("other");
  });

  // Unsure whether it is a practice or an assertion: treat it as unverified.
  it("calls a lesson without a clear kind a claim", () => {
    expect(parseLessons(JSON.stringify({ lessons: [{ ...one, kind: "tip" }] }))![0].kind).toBe("claim");
  });

  it("keeps at most five lessons a post and short quotes", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...one, principle: `p${i}`, quote: "x".repeat(500) }));
    const r = parseLessons(JSON.stringify({ lessons: many }))!;
    expect(r).toHaveLength(MAX_LESSONS_PER_POST);
    expect(r[0].quote!.length).toBeLessThanOrEqual(200);
  });
});

describe("shouldExtractLessons", () => {
  it("reads a new post, a stale one, and retries errors three times", () => {
    expect(shouldExtractLessons(null)).toBe(true);
    expect(shouldExtractLessons({ status: "stale", attempts: 0 })).toBe(true);
    expect(shouldExtractLessons({ status: "error", attempts: 2 })).toBe(true);
    expect(shouldExtractLessons({ status: "error", attempts: 3 })).toBe(false);
  });

  it("does not read again a post already read, with lessons or without", () => {
    expect(shouldExtractLessons({ status: "ok", attempts: 1 })).toBe(false);
    expect(shouldExtractLessons({ status: "none", attempts: 1 })).toBe(false);
  });
});

describe("lessonsReady", () => {
  // A carousel's lessons are on its slides: wait until they have been read.
  it("waits for the visual reading to finish, one way or the other", () => {
    expect(lessonsReady({ visualStatus: null, visualAttempts: null }, true)).toBe(false);
    expect(lessonsReady({ visualStatus: "error", visualAttempts: 1 }, true)).toBe(false);
    expect(lessonsReady({ visualStatus: "ok", visualAttempts: 1 }, true)).toBe(true);
    expect(lessonsReady({ visualStatus: "unavailable", visualAttempts: 1 }, true)).toBe(true);
    expect(lessonsReady({ visualStatus: "error", visualAttempts: 3 }, true)).toBe(true);
  });

  it("does not wait for a reading that will never happen", () => {
    expect(lessonsReady({ visualStatus: null, visualAttempts: null }, false)).toBe(true);
  });
});

describe("groupLessons", () => {
  const row = (o: Partial<LessonRow>): LessonRow => ({
    postId: "p1", username: "lana.k.social", permalink: "https://instagram.com/p/1", postedAt: new Date("2026-11-01T00:00:00Z"), basis: "caption",
    area: "hook", principle: "Open with the result.", howToApply: "Show the after first.", kind: "practice", quote: null, ...o,
  });

  it("merges the same principle taught twice into one lesson with both sources", () => {
    const g = groupLessons([row({}), row({ postId: "p2", permalink: "https://instagram.com/p/2", principle: "open with the result" })]);
    expect(g).toHaveLength(1);
    expect(g[0].lessons).toHaveLength(1);
    expect(g[0].lessons[0].sources.map((s) => s.postId)).toEqual(["p1", "p2"]);
  });

  it("puts the areas taught most first", () => {
    const g = groupLessons([row({ area: "caption", principle: "a" }), row({ principle: "b" }), row({ principle: "c" })]);
    expect(g.map((a) => a.area)).toEqual(["hook", "caption"]);
  });
});
