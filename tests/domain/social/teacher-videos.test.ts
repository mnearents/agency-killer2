import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  parseInstagramLinks,
  parseLearnMessage,
  learnFromVideo,
  describeLearnResult,
  teacherVideoId,
  type TeacherVideoDeps,
} from "@/domain/social/teacher-videos";
import { socialDownloads, socialLessonRuns, socialLessons, socialPostVisuals, teacherVideos } from "@/db/schema";
import type { Db } from "@/db/client";
import type { VideoToolkit } from "@/integrations/video-frames";
import { createMockReelDownloader } from "../../mocks/reel-downloader";
import { createMockAssemblyAiClient } from "../../mocks/assemblyai";
import { createTestDb } from "../../helpers/test-db";

const NOW = new Date("2026-11-16T18:00:00Z");

describe("parseInstagramLinks", () => {
  it("finds reel and post links in any form Instagram shares them, once each, without tracking", () => {
    const links = parseInstagramLinks(
      "<https://www.instagram.com/reel/DAbc_12-x/?igsh=MWQ1|instagram.com/reel/DAbc_12-x> and https://instagram.com/p/Cxyz789/ " +
        "and https://www.instagram.com/lana.k.social/reel/Qrst456/ and again https://m.instagram.com/reels/DAbc_12-x/",
    );
    expect(links).toEqual([
      { shortcode: "DAbc_12-x", url: "https://www.instagram.com/reel/DAbc_12-x/", username: null },
      { shortcode: "Cxyz789", url: "https://www.instagram.com/p/Cxyz789/", username: null },
      { shortcode: "Qrst456", url: "https://www.instagram.com/reel/Qrst456/", username: "lana.k.social" },
    ]);
  });

  it("finds nothing in a profile, story or other link", () => {
    expect(parseInstagramLinks("https://www.instagram.com/lana.k.social/ https://www.instagram.com/stories/x/123/ https://example.com/reel/abcde")).toEqual([]);
  });
});

describe("parseLearnMessage", () => {
  it("takes the link, an @handle and the rest as why it was saved", () => {
    expect(parseLearnMessage("<https://www.instagram.com/reel/DAbc123/?igsh=x|instagram.com/reel/DAbc123> @Lana.K.Social love how she structures the hook")).toEqual({
      links: [{ shortcode: "DAbc123", url: "https://www.instagram.com/reel/DAbc123/", username: null }],
      username: "lana.k.social",
      note: "love how she structures the hook",
    });
  });

  it("has no handle or note when only a link was sent", () => {
    expect(parseLearnMessage("https://www.instagram.com/reel/DAbc123/")).toMatchObject({ username: null, note: null });
  });
});

const frame = Buffer.from("jpeg");
function video(o: Partial<VideoToolkit> = {}): VideoToolkit {
  return {
    inspect: vi.fn().mockResolvedValue({ durationMs: 30_000, hasAudio: true, meanVolumeDb: -18, cuts: 9 }),
    frames: vi.fn().mockResolvedValue([frame, frame, frame]),
    contactSheet: vi.fn().mockResolvedValue(Buffer.from("sheet")),
    extractAudio: vi.fn().mockResolvedValue(Buffer.from("aac")),
    ...o,
  };
}

const VISUAL = JSON.stringify({ summary: "A woman talks to camera about hooks.", visualType: "person", onScreenText: [{ at: "0s", text: "Your hook is too slow" }], visualHook: "Your hook is too slow", faceInFirst2s: true });
const LESSONS = JSON.stringify({ lessons: [
  { principle: "Open with the payoff, not a greeting.", howToApply: "Start on the finished page.", area: "hook", kind: "practice", quote: "Lead with the payoff" },
  { principle: "Reels under 7 seconds get pushed further.", howToApply: null, area: "reel-structure", kind: "claim", quote: null },
] });

/** One model for both readings: the frames, then the lessons. */
const model = (lessons = LESSONS) => vi.fn(async (prompt: string) => ({
  text: prompt.includes("List what this post teaches") ? lessons : VISUAL, inputTokens: 1, outputTokens: 1, stopReason: "end_turn",
}));

let db: Db;
let truncate: (...t: string[]) => Promise<unknown>;
beforeAll(async () => {
  ({ db, truncate } = await createTestDb());
});
beforeEach(async () => {
  await truncate("teacher_videos", "social_downloads", "social_post_visuals", "social_lessons", "social_lesson_runs");
});

function deps(o: Partial<TeacherVideoDeps> = {}) {
  const downloader = createMockReelDownloader({
    resolve: vi.fn().mockResolvedValue({ ok: true, videoUrl: "https://cdn/v.mp4", quality: "720x1280p", caption: "3 hook mistakes 👇", rate: { limit: 5000, remaining: 4990, resetSeconds: 86_400 } }),
  });
  const generate = model();
  const d: TeacherVideoDeps = {
    db, anthropic: { generate }, video: video(), downloader, transcriber: createMockAssemblyAiClient({
      transcribe: vi.fn().mockResolvedValue({ id: "t", status: "completed", text: "Stop opening with hi. Lead with the payoff.", words: [], durationMs: 30_000 }),
    }),
    limits: { plan: 5000 }, now: () => NOW, ...o,
  };
  return { d, downloader, generate };
}

const LINK = parseInstagramLinks("https://www.instagram.com/reel/DAbc123/")[0];
const learn = (d: TeacherVideoDeps, o: { username?: string | null; note?: string | null } = {}) =>
  learnFromVideo(d, { link: LINK, username: o.username ?? null, note: o.note ?? null, savedBy: "slack" });

describe("learnFromVideo", () => {
  it("downloads the video, transcribes it, reads its frames and lists what it teaches", async () => {
    const { d, downloader } = deps();
    const r = await learn(d, { username: "lana.k.social", note: "great hook breakdown" });

    expect(downloader.resolve).toHaveBeenCalledWith("https://www.instagram.com/reel/DAbc123/");
    expect(r).toMatchObject({
      status: "saved",
      video: { id: "ig:DAbc123", username: "lana.k.social", caption: "3 hook mistakes 👇", note: "great hook breakdown" },
      lessonsRead: "ok",
      summary: "A woman talks to camera about hooks.",
      transcribed: true,
      problems: [],
    });
    expect(r.status === "saved" && r.lessons.map((l) => l.kind)).toEqual(["practice", "claim"]);

    const [row] = await db.select().from(teacherVideos);
    expect(row).toMatchObject({ id: "ig:DAbc123", shortcode: "DAbc123", status: "ok", attempts: 1, savedBy: "slack", savedAt: NOW, transcript: "Stop opening with hi. Lead with the payoff.", durationMs: 30_000 });
    expect(await db.select({ postId: socialLessons.postId, username: socialLessons.username }).from(socialLessons)).toEqual([
      { postId: "ig:DAbc123", username: "lana.k.social" }, { postId: "ig:DAbc123", username: "lana.k.social" },
    ]);
    const [visual] = await db.select().from(socialPostVisuals);
    expect(visual).toMatchObject({ postId: "ig:DAbc123", status: "ok", source: "api_backfill", audio: "speech", onScreenText: [{ at: "0s", text: "Your hook is too slow" }] });
    // Counted against the RapidAPI plan as a teacher call.
    expect(await db.select({ account: socialDownloads.account, outcome: socialDownloads.outcome, postId: socialDownloads.postId }).from(socialDownloads)).toEqual([
      { account: "teacher", outcome: "ok", postId: "ig:DAbc123" },
    ]);
    // The file is deleted: only what was read is kept.
    expect(downloader.removed).toEqual(["/tmp/reel.mp4"]);
  });

  it("reads the on-screen text and transcript into the lessons prompt", async () => {
    const { d, generate } = deps();
    await learn(d, { note: "the 3 second rule" });
    const lessonPrompt = generate.mock.calls.map((c) => c[0] as string).find((p) => p.includes("List what this post teaches"))!;
    expect(lessonPrompt).toContain("Your hook is too slow");
    expect(lessonPrompt).toContain("Lead with the payoff.");
    expect(lessonPrompt).toContain('Why it was saved: "the 3 second rule"');
    expect(lessonPrompt).toContain("creator whose handle was not given");
  });

  it("downloads nothing for a video already saved, and keeps a handle or note it lacked", async () => {
    const { d, downloader } = deps();
    await learn(d);
    downloader.resolve = vi.fn();
    const again = await learn(d, { username: "lana.k.social", note: "still great" });
    expect(downloader.resolve).not.toHaveBeenCalled();
    expect(again).toMatchObject({ status: "already-saved", video: { username: "lana.k.social", note: "still great" } });
    expect(again.status === "already-saved" && again.lessons).toHaveLength(2);
    expect(await db.select().from(socialDownloads)).toHaveLength(1);
  });

  it("records a failed download, says why, and tries again when the link is sent again", async () => {
    const { d, downloader } = deps();
    downloader.resolve = vi.fn().mockResolvedValueOnce({ ok: false, reason: "no-video", detail: "message: Media not found", rate: { limit: null, remaining: null, resetSeconds: null } });
    const r = await learn(d);
    expect(r).toMatchObject({ status: "failed", reason: "no-video", detail: "message: Media not found" });
    expect((await db.select().from(teacherVideos))[0]).toMatchObject({ status: "failed", attempts: 1, detail: "no-video: message: Media not found" });

    downloader.resolve = vi.fn().mockResolvedValue({ ok: true, videoUrl: "https://cdn/v.mp4", quality: null, caption: null, rate: { limit: null, remaining: null, resetSeconds: null } });
    expect((await learn(d)).status).toBe("saved");
    expect((await db.select().from(teacherVideos))[0]).toMatchObject({ status: "ok", attempts: 2, detail: null });
  });

  it("refuses without calling the downloader once the plan's monthly limit is used", async () => {
    await db.insert(socialDownloads).values([{ postId: "p1", account: "peer", calledAt: NOW, outcome: "ok" }, { postId: "p2", account: "own", calledAt: NOW, outcome: "ok" }]);
    const { d, downloader } = deps({ limits: { plan: 2 } });
    const r = await learn(d);
    expect(r).toMatchObject({ status: "refused", reason: "plan-limit" });
    expect(downloader.resolve).not.toHaveBeenCalled();
    expect(await db.select().from(teacherVideos)).toEqual([]);
  });

  it("refuses while the API says its quota is spent", async () => {
    await db.insert(socialDownloads).values({ postId: "p1", account: "peer", calledAt: NOW, outcome: "ok", rateRemaining: 0, rateResetAt: new Date("2026-12-01T00:00:00Z") });
    const { d, downloader } = deps();
    expect(await learn(d)).toMatchObject({ status: "refused", reason: "quota-exhausted" });
    expect(downloader.resolve).not.toHaveBeenCalled();
  });

  it("still saves a video whose lessons could not be read, for the daily sync to retry, and says so", async () => {
    const { d } = deps({ anthropic: { generate: model("no idea") } });
    const r = await learn(d);
    expect(r).toMatchObject({ status: "saved", lessonsRead: "error", lessons: [] });
    expect(r.status === "saved" && r.problems.join(" ")).toMatch(/lessons not read yet.*daily sync/);
    expect((await db.select().from(socialLessonRuns))[0]).toMatchObject({ postId: "ig:DAbc123", status: "error", attempts: 1 });
  });

  it("says when there was no transcriber, and still reads the caption and screen", async () => {
    const { d } = deps({ transcriber: undefined });
    const r = await learn(d);
    expect(r).toMatchObject({ status: "saved", transcribed: false, lessonsRead: "ok" });
    expect(r.status === "saved" && r.problems).toEqual(["not transcribed: ASSEMBLYAI_API_KEY is not set"]);
  });

  it("records a file ffmpeg cannot read as failed, and deletes it", async () => {
    const { d, downloader } = deps({ video: video({ frames: vi.fn().mockRejectedValue(new Error("moov atom not found")) }) });
    const r = await learn(d);
    expect(r).toMatchObject({ status: "failed", reason: "unreadable-video" });
    expect(downloader.removed).toEqual(["/tmp/reel.mp4"]);
    expect((await db.select().from(teacherVideos).where(eq(teacherVideos.id, teacherVideoId("DAbc123"))))[0].status).toBe("failed");
  });
});

describe("describeLearnResult", () => {
  const video = { id: "ig:DAbc123", url: LINK.url, username: null, caption: null, note: null };

  it("lists what a saved video teaches, marks claims, and asks for the creator when unknown", () => {
    const text = describeLearnResult(LINK, {
      status: "saved", video, lessonsRead: "ok", summary: "A woman talks to camera.", transcribed: true, problems: [],
      lessons: [
        { principle: "Open with the payoff.", howToApply: null, area: "hook", kind: "practice", quote: null },
        { principle: "Short reels get pushed further.", howToApply: null, area: "growth", kind: "claim", quote: null },
      ],
    });
    expect(text).toContain("*Saved*: https://www.instagram.com/reel/DAbc123/");
    expect(text).toContain("  • Open with the payoff.");
    expect(text).toContain("  • Short reels get pushed further. _(their claim — not verified)_");
    expect(text).toMatch(/Send it again with @theirhandle/);
  });

  it("says what went wrong and that sending it again retries", () => {
    expect(describeLearnResult(LINK, { status: "failed", video, reason: "no-video", detail: "message: Media not found" })).toMatch(/Couldn't save .*no-video.*sending it again tries again/);
    expect(describeLearnResult(LINK, { status: "refused", reason: "plan-limit", detail: "5000 downloads this month already." })).toMatch(/Couldn't download .*Nothing was saved/);
  });
});
