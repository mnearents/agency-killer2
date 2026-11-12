import { describe, it, expect, vi } from "vitest";
import { extractLessons } from "@/domain/social/lesson-sync";
import { createMockAnthropicClient } from "../../mocks/anthropic";
import { fakeDb } from "../../mocks/recording-db";

const NOW = new Date("2026-11-11T12:00:00Z");
const carousel = {
  id: "c1", username: "lana.k.social", caption: "3 hooks that stop the scroll", mediaType: "CAROUSEL_ALBUM", mediaProductType: "FEED",
  transcript: null, onScreenText: [{ at: "Slide 2", text: "Open with the result" }],
  visualStatus: "ok", visualAttempts: 1, runStatus: null, runAttempts: null,
};
const reply = (lessons: unknown[]) => vi.fn().mockResolvedValue({ text: JSON.stringify({ lessons }) });
const lesson = { principle: "Open with the result, not the setup.", howToApply: "Show the finished page at 0s.", area: "hook", kind: "practice", quote: null };

function run(post: Record<string, unknown>, generate = reply([lesson]), waitForVisuals = true) {
  const d = fakeDb({ social_peer_posts: [post] });
  const anthropic = createMockAnthropicClient({ generate });
  return extractLessons({ db: d.db, anthropic, now: () => NOW }, { waitForVisuals }, []).then((r) => ({ ...d, r, generate }));
}

describe("extractLessons", () => {
  it("reads a teacher post's caption and slide text and stores what it teaches", async () => {
    const { r, inserts, generate } = await run(carousel);
    expect(generate.mock.calls[0][0]).toContain("Slide 2: Open with the result");
    expect(inserts.find((w) => w.table === "social_lessons")!.values).toEqual([
      expect.objectContaining({ postId: "c1", username: "lana.k.social", area: "hook", principle: "Open with the result, not the setup.", kind: "practice" }),
    ]);
    expect(inserts.find((w) => w.table === "social_lesson_runs")!.values).toMatchObject({ postId: "c1", status: "ok", attempts: 1, basis: "caption+slides", lessonCount: 1 });
    expect(r).toEqual({ extracted: 1, none: 0, failed: 0, lessons: 1 });
  });

  // Read again after an upload: the old lessons are replaced, not added to.
  it("replaces a post's earlier lessons when it is read again", async () => {
    const { deletes } = await run({ ...carousel, runStatus: "stale", runAttempts: 0 });
    expect(deletes).toEqual([{ table: "social_lessons" }]);
  });

  it("reads an uploaded reel's transcript", async () => {
    const { generate, inserts } = await run({ ...carousel, mediaType: "VIDEO", mediaProductType: "REELS", onScreenText: null, transcript: "Here's the hook formula I use." });
    expect(generate.mock.calls[0][0]).toContain("Here's the hook formula I use.");
    expect(inserts.find((w) => w.table === "social_lesson_runs")!.values).toMatchObject({ basis: "caption+transcript" });
  });

  it("records a post that teaches nothing as none, which is not read again", async () => {
    const { r, inserts } = await run(carousel, reply([]));
    expect(inserts.some((w) => w.table === "social_lessons")).toBe(false);
    expect(inserts.find((w) => w.table === "social_lesson_runs")!.values).toMatchObject({ status: "none", lessonCount: 0 });
    expect(r).toMatchObject({ extracted: 0, none: 1 });
  });

  it("records an unreadable reply as an error, never as no lessons", async () => {
    const { r, inserts } = await run(carousel, vi.fn().mockResolvedValue({ text: "What a great post!" }));
    expect(inserts.find((w) => w.table === "social_lesson_runs")!.values).toMatchObject({ status: "error", attempts: 1, detail: expect.stringMatching(/unreadable/) });
    expect(r).toMatchObject({ failed: 1, none: 0 });
  });

  it("waits for a post's slides to be read before reading it", async () => {
    const { generate, inserts } = await run({ ...carousel, visualStatus: null, visualAttempts: null });
    expect(generate).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it("does not wait for slides when there is no visual step", async () => {
    const { generate } = await run({ ...carousel, visualStatus: null, visualAttempts: null }, reply([lesson]), false);
    expect(generate).toHaveBeenCalled();
  });

  it("leaves a post already read alone", async () => {
    const { generate } = await run({ ...carousel, runStatus: "ok", runAttempts: 1 });
    expect(generate).not.toHaveBeenCalled();
  });
});
