import { describe, it, expect, vi } from "vitest";
import { extractLessons, readLessons } from "@/domain/social/lesson-sync";
import { createMockAnthropicClient } from "../../mocks/anthropic";
import { fakeDb } from "../../mocks/recording-db";

const NOW = new Date("2026-11-16T12:00:00Z");
/** A saved teacher video as both reads see it: the row, its frames' reading and its lesson run. */
const saved = {
  id: "ig:abc123", username: null, caption: "3 hooks that stop the scroll", note: "the 3-second rule", status: "ok",
  transcript: "Here's the hook formula I use.", onScreenText: [{ at: "Frame at 0s", text: "Open with the result" }],
  visualStatus: "ok", visualAttempts: 1, runStatus: null, runAttempts: null,
};
const reply = (lessons: unknown[]) => vi.fn().mockResolvedValue({ text: JSON.stringify({ lessons }) });
const lesson = { principle: "Open with the result, not the setup.", howToApply: "Show the finished page at 0s.", area: "hook", kind: "practice", quote: null };

function run(video: Record<string, unknown>, generate = reply([lesson])) {
  const d = fakeDb({ teacher_videos: [video] });
  const anthropic = createMockAnthropicClient({ generate });
  return extractLessons({ db: d.db, anthropic, now: () => NOW }, []).then((r) => ({ ...d, r, generate }));
}

describe("readLessons", () => {
  it("reads the caption, the text on screen, the transcript and why it was saved, and stores what it teaches", async () => {
    const generate = reply([lesson]);
    const { db, inserts } = fakeDb({ teacher_videos: [saved] });
    const r = await readLessons({ db, anthropic: createMockAnthropicClient({ generate }), now: () => NOW }, "ig:abc123");
    const prompt = generate.mock.calls[0][0] as string;
    expect(prompt).toContain("Frame at 0s: Open with the result");
    expect(prompt).toContain("Here's the hook formula I use.");
    expect(prompt).toContain('Why it was saved: "the 3-second rule"');
    expect(prompt).toContain("by a creator whose handle was not given");
    expect(r).toEqual({ status: "ok", lessons: [lesson] });
    // An unknown creator is stored as "unknown", never guessed.
    expect(inserts.find((w) => w.table === "social_lessons")!.values).toEqual([
      expect.objectContaining({ postId: "ig:abc123", username: "unknown", area: "hook", principle: "Open with the result, not the setup.", kind: "practice" }),
    ]);
    expect(inserts.find((w) => w.table === "social_lesson_runs")!.values).toMatchObject({ postId: "ig:abc123", status: "ok", attempts: 1, basis: "caption+slides+transcript", lessonCount: 1 });
  });

  it("names the creator when it is known", async () => {
    const generate = reply([lesson]);
    const { db, inserts } = fakeDb({ teacher_videos: [{ ...saved, username: "lana.k.social" }] });
    await readLessons({ db, anthropic: createMockAnthropicClient({ generate }), now: () => NOW }, "ig:abc123");
    expect(generate.mock.calls[0][0]).toContain("by @lana.k.social");
    expect((inserts.find((w) => w.table === "social_lessons")!.values as unknown as Array<{ username: string }>)[0].username).toBe("lana.k.social");
  });

  // Read again: the old lessons are replaced, not added to.
  it("replaces a video's earlier lessons", async () => {
    const { db, deletes } = fakeDb({ teacher_videos: [{ ...saved, runStatus: "stale", runAttempts: 0 }] });
    await readLessons({ db, anthropic: createMockAnthropicClient({ generate: reply([lesson]) }), now: () => NOW }, "ig:abc123");
    expect(deletes).toEqual([{ table: "social_lessons" }]);
  });

  it("records an unreadable reply as an error, never as no lessons, counting attempts", async () => {
    const { db, inserts } = fakeDb({ teacher_videos: [{ ...saved, runStatus: "error", runAttempts: 1 }] });
    const r = await readLessons({ db, anthropic: createMockAnthropicClient({ generate: vi.fn().mockResolvedValue({ text: "What a great post!" }) }), now: () => NOW }, "ig:abc123");
    expect(r).toMatchObject({ status: "error", attempts: 2, detail: expect.stringMatching(/unreadable/) });
    expect(inserts.find((w) => w.table === "social_lesson_runs")!.values).toMatchObject({ status: "error", attempts: 2 });
    expect(inserts.some((w) => w.table === "social_lessons")).toBe(false);
  });

  it("records a video with no words at all as teaching nothing, without asking the model", async () => {
    const generate = reply([lesson]);
    const { db, inserts } = fakeDb({ teacher_videos: [{ ...saved, caption: null, transcript: null, onScreenText: [] }] });
    const r = await readLessons({ db, anthropic: createMockAnthropicClient({ generate }), now: () => NOW }, "ig:abc123");
    expect(generate).not.toHaveBeenCalled();
    expect(r).toEqual({ status: "none", lessons: [] });
    expect(inserts.find((w) => w.table === "social_lesson_runs")!.values).toMatchObject({ status: "none", lessonCount: 0 });
  });
});

describe("extractLessons — the daily retry", () => {
  it("reads a saved video still owed its lessons", async () => {
    const { r, inserts } = await run({ ...saved, runStatus: "error", runAttempts: 1 });
    expect(inserts.find((w) => w.table === "social_lessons")).toBeDefined();
    expect(r).toEqual({ extracted: 1, none: 0, failed: 0, lessons: 1 });
  });

  it("records a video that teaches nothing as none", async () => {
    const { r, inserts } = await run(saved, reply([]));
    expect(inserts.some((w) => w.table === "social_lessons")).toBe(false);
    expect(r).toMatchObject({ extracted: 0, none: 1 });
  });

  it("counts an unreadable reply as failed", async () => {
    const { r } = await run(saved, vi.fn().mockResolvedValue({ text: "nope" }));
    expect(r).toMatchObject({ failed: 1, none: 0 });
  });

  // Frames are read once, when the video is sent; a failed reading never comes back.
  it("does not wait for frames that will not be read again", async () => {
    const { generate } = await run({ ...saved, onScreenText: null, visualStatus: "error", visualAttempts: 1, runStatus: "error", runAttempts: 1 });
    expect(generate).toHaveBeenCalled();
  });

  it("leaves a video already read alone, and one that failed three times", async () => {
    expect((await run({ ...saved, runStatus: "ok", runAttempts: 1 })).generate).not.toHaveBeenCalled();
    expect((await run({ ...saved, runStatus: "error", runAttempts: 3 })).generate).not.toHaveBeenCalled();
  });
});
