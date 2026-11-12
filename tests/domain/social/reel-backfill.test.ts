import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchReelVideo, runReelDownloads, type ReelDownloadDeps } from "@/domain/social/reel-backfill";
import * as queries from "@/domain/social/download-queries";
import * as upload from "@/domain/social/upload";
import { createMockReelDownloader } from "../../mocks/reel-downloader";
import { createMockAnthropicClient } from "../../mocks/anthropic";
import { fakeDb } from "../../mocks/recording-db";
import type { VideoToolkit } from "@/integrations/video-frames";
import type { DownloadCandidate } from "@/domain/social/download-plan";

vi.mock("@/domain/social/download-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/social/download-queries")>()),
  getDownloadQueue: vi.fn(),
  getDownloadUsage: vi.fn(),
}));
vi.mock("@/domain/social/upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/social/upload")>()),
  analyseUploadedReel: vi.fn(),
}));

const NOW = new Date("2026-11-12T12:00:00Z");
const c = (postId: string, account: DownloadCandidate["account"]): DownloadCandidate => ({ postId, account, username: account === "own" ? null : "lana.k.social", permalink: `https://www.instagram.com/reel/${postId}/`, postedAt: NOW });

function video(o: Partial<VideoToolkit> = {}): VideoToolkit {
  return {
    inspect: vi.fn().mockResolvedValue({ durationMs: 15_000, hasAudio: true, meanVolumeDb: -20, cuts: 4 }),
    frames: vi.fn(), contactSheet: vi.fn(), extractAudio: vi.fn(),
    ...o,
  };
}

function setup(o: Partial<ReelDownloadDeps> = {}) {
  const d = fakeDb({});
  const sleep = vi.fn().mockResolvedValue(undefined);
  const deps: ReelDownloadDeps = {
    db: d.db, anthropic: createMockAnthropicClient(), video: video(), downloader: createMockReelDownloader(),
    limits: { plan: 100, teacher: 60, peer: 40 }, now: () => NOW, sleep, ...o,
  };
  return { ...d, deps, sleep };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getDownloadQueue).mockResolvedValue({ own: [c("o1", "own")], teachers: [c("t1", "teacher")], peers: [] });
  vi.mocked(queries.getDownloadUsage).mockResolvedValue({ usage: { own: 0, teacher: 0, peer: 0 }, quota: { remaining: null, resetAt: null, limit: null }, last: null });
  vi.mocked(upload.analyseUploadedReel).mockResolvedValue({ ok: true, account: "own", summary: "Tara colours a page.", visualHook: "POV", durationMs: 15_000, cuts: 4, transcribed: false, transcriptError: null, audioNote: "n" });
});

describe("fetchReelVideo", () => {
  it("resolves the reel, downloads the best video at once and checks it is one", async () => {
    const { deps } = setup();
    const r = await fetchReelVideo(deps, "https://www.instagram.com/reel/x/");
    expect(deps.downloader.download).toHaveBeenCalledWith("https://cdn/v.mp4", 500 * 1024 * 1024);
    expect(deps.video.inspect).toHaveBeenCalledWith("/tmp/reel.mp4");
    expect(r).toMatchObject({ ok: true, path: "/tmp/reel.mp4", quality: "720x1280p" });
  });

  it.each([
    ["a non-video content type", { contentType: "text/html", bytes: 2_000_000 }, /content type/],
    ["a file under 100KB", { contentType: "video/mp4", bytes: 50_000 }, /too small/],
  ])("rejects %s and deletes it", async (_name, file, detail) => {
    const removed: string[] = [];
    const downloader = createMockReelDownloader({ download: vi.fn().mockResolvedValue({ path: "/tmp/r.mp4", ...file, remove: async () => { removed.push("x"); } }) });
    const { deps } = setup({ downloader });
    expect(await fetchReelVideo(deps, "u")).toMatchObject({ ok: false, reason: "bad-file", detail: expect.stringMatching(detail) });
    expect(removed).toEqual(["x"]);
  });

  it("rejects a file ffprobe reads no length from", async () => {
    const { deps } = setup({ video: video({ inspect: vi.fn().mockResolvedValue({ durationMs: null, hasAudio: false, meanVolumeDb: null, cuts: 0 }) }) });
    expect(await fetchReelVideo(deps, "u")).toMatchObject({ ok: false, reason: "bad-file", detail: expect.stringMatching(/length/) });
  });

  it("rejects a file over 500MB", async () => {
    const downloader = createMockReelDownloader({ download: vi.fn().mockRejectedValue(Object.assign(new Error("big"), { code: "TOO_LARGE" })) });
    const { deps } = setup({ downloader });
    expect(await fetchReelVideo(deps, "u")).toMatchObject({ ok: false, reason: "bad-file", detail: expect.stringMatching(/500MB/) });
  });

  it("passes on the API's failure", async () => {
    const downloader = createMockReelDownloader({ resolve: vi.fn().mockResolvedValue({ ok: false, reason: "no-video", detail: "message: Media not found", rate: { limit: 3, remaining: 1, resetSeconds: 100 } }) });
    const { deps } = setup({ downloader });
    expect(await fetchReelVideo(deps, "u")).toMatchObject({ ok: false, reason: "no-video" });
    expect(downloader.download).not.toHaveBeenCalled();
  });
});

describe("runReelDownloads", () => {
  it("downloads each queued reel, runs it through the upload pipeline as a download, and deletes the file", async () => {
    const { deps, inserts } = setup();
    const r = await runReelDownloads(deps, {});
    expect(vi.mocked(upload.analyseUploadedReel).mock.calls.map((c) => [c[1].postId, c[2]])).toEqual([["o1", { origin: "api_backfill" }], ["t1", { origin: "api_backfill" }]]);
    expect((deps.downloader as ReturnType<typeof createMockReelDownloader>).removed).toHaveLength(2);
    expect(r).toMatchObject({ calls: 2, ok: 2, failed: 0, stopped: null });
  });

  it("records every call with the quota the API reported", async () => {
    const { deps, inserts, updates } = setup();
    await runReelDownloads(deps, { only: "own" });
    const row = inserts.find((w) => w.table === "social_downloads")!.values;
    expect(row).toMatchObject({ postId: "o1", account: "own", outcome: "ok", quality: "720x1280p", rateLimit: 3, rateRemaining: 2 });
    expect((row.rateResetAt as Date).getTime()).toBe(NOW.getTime() + 2_590_961_000);
    expect(updates).toEqual([]);
  });

  it("waits between calls", async () => {
    const { deps, sleep } = setup();
    await runReelDownloads(deps, {});
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly at the rate limit and leaves the rest queued", async () => {
    const downloader = createMockReelDownloader({ resolve: vi.fn().mockResolvedValue({ ok: false, reason: "rate-limited", detail: "429", rate: { limit: 3, remaining: 0, resetSeconds: 100 } }) });
    const { deps, inserts } = setup({ downloader });
    const r = await runReelDownloads(deps, {});
    expect(downloader.resolve).toHaveBeenCalledTimes(1);
    expect(inserts.find((w) => w.table === "social_downloads")!.values).toMatchObject({ outcome: "rate-limited" });
    expect(r).toMatchObject({ calls: 1, ok: 0, stopped: "rate-limited" });
  });

  // The reel stays cover-only and on the upload page; the failure is counted.
  it("records a failed file and carries on with the next reel", async () => {
    const downloader = createMockReelDownloader({
      download: vi.fn()
        .mockResolvedValueOnce({ path: "/tmp/a.mp4", bytes: 10, contentType: "video/mp4", remove: async () => {} })
        .mockResolvedValueOnce({ path: "/tmp/b.mp4", bytes: 2_000_000, contentType: "video/mp4", remove: async () => {} }),
    });
    const { deps, inserts } = setup({ downloader });
    const r = await runReelDownloads(deps, {});
    expect(inserts.filter((w) => w.table === "social_downloads").map((w) => w.values.outcome)).toEqual(["bad-file", "ok"]);
    expect(r).toMatchObject({ calls: 2, ok: 1, failed: 1 });
  });

  it("records an analysis that failed after the download, which updates the call's row", async () => {
    vi.mocked(upload.analyseUploadedReel).mockResolvedValueOnce({ ok: false, reason: "analysis-failed", detail: "unreadable answer" });
    const { deps, updates } = setup();
    const r = await runReelDownloads(deps, { only: "own" });
    expect(updates.find((u) => u.table === "social_downloads")!.values).toMatchObject({ outcome: "analysis-failed", detail: "unreadable answer" });
    expect(r).toMatchObject({ ok: 0, failed: 1 });
  });

  it("does only one kind of account, and only as many as asked", async () => {
    const { deps } = setup();
    vi.mocked(queries.getDownloadQueue).mockResolvedValue({ own: [c("o1", "own"), c("o2", "own")], teachers: [c("t1", "teacher")], peers: [] });
    await runReelDownloads(deps, { only: "teacher", max: 1 });
    expect(vi.mocked(upload.analyseUploadedReel).mock.calls.map((c) => c[1].postId)).toEqual(["t1"]);
  });

  it("makes no call when the plan's limit is spent, and says why", async () => {
    vi.mocked(queries.getDownloadUsage).mockResolvedValue({ usage: { own: 3, teacher: 0, peer: 0 }, quota: { remaining: null, resetAt: null, limit: null }, last: null });
    const { deps } = setup({ limits: { plan: 3, teacher: 60, peer: 40 } });
    const r = await runReelDownloads(deps, {});
    expect(deps.downloader.resolve).not.toHaveBeenCalled();
    expect(r).toMatchObject({ calls: 0, stopped: "plan-limit", deferred: { own: 1, teacher: 1, peer: 0 } });
  });

  it("returns what each reel showed, for the reply", async () => {
    const { deps } = setup();
    const r = await runReelDownloads(deps, { only: "own" });
    expect(r.results[0]).toMatchObject({ postId: "o1", account: "own", outcome: "ok", summary: "Tara colours a page.", visualHook: "POV" });
  });
});
