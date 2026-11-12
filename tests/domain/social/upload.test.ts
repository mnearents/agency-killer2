import { describe, it, expect, vi } from "vitest";
import { analyseUploadedReel, type UploadDeps } from "@/domain/social/upload";
import { createMockAnthropicClient } from "../../mocks/anthropic";
import { createMockAssemblyAiClient } from "../../mocks/assemblyai";
import { fakeDb } from "../../mocks/recording-db";
import type { VideoToolkit } from "@/integrations/video-frames";

const NOW = new Date("2026-11-10T12:00:00Z");
const coverOnlyReel = {
  id: "18112236008622292", caption: "Don't recommend hand painting a sign in a rush", mediaType: "VIDEO", mediaProductType: "REELS",
  transcriptionStatus: null, transcriptionAttempts: 0, openingWords: null, durationMs: null, postedAt: new Date("2026-10-26T00:00:00Z"),
  visualStatus: "cover_only", visualAttempts: 1,
};
const answer = JSON.stringify({
  summary: "Tara paints a sign by hand, too fast.", visualType: "person", handDrawn: true, onScreenText: [{ at: "0s", text: "Don't do this" }],
  firstFrame: "Tara holding a brush over a wooden sign.", visualHook: "Don't do this", faceInFirst2s: true, productVisible: false,
  productFirstSeen: null, setting: "garage workshop", emotion: "funny, self-deprecating", branding: false,
});

function video(o: Partial<VideoToolkit> = {}): VideoToolkit {
  return {
    inspect: vi.fn().mockResolvedValue({ durationMs: 12_000, hasAudio: true, meanVolumeDb: -22, cuts: 6 }),
    frames: vi.fn().mockImplementation(async (_f: string, t: number[]) => t.map(() => Buffer.from("jpg"))),
    contactSheet: vi.fn().mockResolvedValue(Buffer.from("sheet")),
    extractAudio: vi.fn().mockResolvedValue(Buffer.from("aac")),
    ...o,
  };
}

function setup(post: Record<string, unknown> | null = coverOnlyReel, o: Partial<UploadDeps> = {}, peer: Record<string, unknown> | null = null) {
  const d = fakeDb({ ...(post ? { social_posts: [post] } : {}), ...(peer ? { social_peer_posts: [peer] } : {}) });
  const deps: UploadDeps = {
    db: d.db,
    anthropic: createMockAnthropicClient({ generate: vi.fn().mockResolvedValue({ text: answer }) }),
    video: video(),
    transcriber: createMockAssemblyAiClient({
      transcribe: vi.fn().mockResolvedValue({
        id: "t1", status: "completed", text: "Don't do this. I painted this sign in an hour.", durationMs: 12_000,
        words: [{ text: "Don't", start: 200, end: 500, confidence: 1 }, { text: "do", start: 520, end: 700, confidence: 1 }, { text: "this.", start: 720, end: 1000, confidence: 1 }],
      }),
    }),
    now: () => NOW,
    ...o,
  };
  return { ...d, deps };
}

describe("analyseUploadedReel", () => {
  it("runs the uploaded file through the same frames analysis and marks where it came from", async () => {
    const { deps, inserts } = setup();
    const r = await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/up.mp4", songUsed: "Espresso — Sabrina Carpenter" });
    expect(deps.video.frames).toHaveBeenCalledWith("/tmp/up.mp4", [0, 1000, 2000, 3000, 6000, 9000]);
    const row = inserts.find((w) => w.table === "social_post_visuals")!.values;
    expect(row).toMatchObject({
      postId: coverOnlyReel.id, status: "ok", basis: "frames", source: "manual_upload", songUsed: "Espresso — Sabrina Carpenter",
      audio: "licensed-music-likely", faceInFirst2s: 1, cuts: 6, cutsPerMinute: 30, durationMs: 12_000,
    });
    expect(String(row.audioNote)).toMatch(/uploaded file/);
    expect(r).toMatchObject({ ok: true, visualHook: "Don't do this", transcribed: true });
  });

  it("marks the reel analysed, with its length", async () => {
    const { deps, updates } = setup();
    await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/up.mp4", songUsed: null });
    const post = updates.filter((u) => u.table === "social_posts").map((u) => u.values);
    expect(post).toContainEqual(expect.objectContaining({ visualStatus: "analyzed", durationMs: 12_000 }));
  });

  // Speech in the upload is the reel's own words — the hook may be spoken.
  it("transcribes speech in the upload, keeps the opening words, and has the post's hook read again", async () => {
    const { deps, inserts, updates } = setup();
    await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/up.mp4", songUsed: null });
    expect(deps.video.extractAudio).toHaveBeenCalledWith("/tmp/up.mp4");
    expect(deps.transcriber!.uploadFile).toHaveBeenCalledWith(Buffer.from("aac"));
    expect(inserts.find((w) => w.table === "kb_documents")!.values).toMatchObject({ category: "social-transcript", sourceFile: `ig:${coverOnlyReel.id}` });
    expect(updates.find((u) => u.table === "social_posts" && u.values.transcriptionStatus === "ok")!.values).toMatchObject({ openingWords: "Don't do this." });
    expect(updates.find((u) => u.table === "social_post_analyses")!.values).toMatchObject({ status: "stale", attempts: 0 });
  });

  it("does not transcribe a silent upload", async () => {
    const { deps } = setup(coverOnlyReel, { video: video({ inspect: vi.fn().mockResolvedValue({ durationMs: 12_000, hasAudio: false, meanVolumeDb: null, cuts: 6 }) }) });
    const r = await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/up.mp4", songUsed: null });
    expect(deps.transcriber!.uploadFile).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, transcribed: false });
  });

  it("does not transcribe again a reel already transcribed", async () => {
    const { deps } = setup({ ...coverOnlyReel, transcriptionStatus: "ok", openingWords: "Hi" });
    await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/up.mp4", songUsed: null });
    expect(deps.transcriber!.uploadFile).not.toHaveBeenCalled();
  });

  // A failed transcript costs the hook its words, not the visual analysis.
  it("still analyses the frames when transcription fails", async () => {
    const { deps, inserts } = setup(coverOnlyReel, {
      transcriber: createMockAssemblyAiClient({ uploadFile: vi.fn().mockRejectedValue(new Error("AssemblyAI upload error (500)")) }),
    });
    const r = await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/up.mp4", songUsed: null });
    expect(inserts.find((w) => w.table === "social_post_visuals")!.values).toMatchObject({ status: "ok", source: "manual_upload" });
    expect(r).toMatchObject({ ok: true, transcribed: false, transcriptError: expect.stringMatching(/500/) });
  });

  it("refuses an upload for a post it does not hold", async () => {
    const { deps, inserts } = setup(null);
    expect(await analyseUploadedReel(deps, { postId: "999", filePath: "/tmp/up.mp4", songUsed: null })).toEqual({ ok: false, reason: "not-found" });
    expect(inserts).toEqual([]);
  });

  it("refuses an upload for a post that is not a reel", async () => {
    const { deps } = setup({ ...coverOnlyReel, mediaType: "IMAGE", mediaProductType: "FEED" });
    expect(await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/up.mp4", songUsed: null })).toEqual({ ok: false, reason: "not-a-reel" });
  });

  // ffmpeg could not read a length: not a video, whatever the extension says.
  it("refuses a file ffmpeg cannot read as a video", async () => {
    const { deps, inserts } = setup(coverOnlyReel, { video: video({ inspect: vi.fn().mockRejectedValue(new Error("Invalid data found when processing input")) }) });
    const r = await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/up.mp4", songUsed: null });
    expect(r).toMatchObject({ ok: false, reason: "unreadable-video" });
    expect(inserts.filter((w) => w.table === "social_post_visuals")).toEqual([]);
  });

  it("reports an analysis Claude could not complete, without marking the reel analysed", async () => {
    const { deps, updates } = setup(coverOnlyReel, { anthropic: createMockAnthropicClient({ generate: vi.fn().mockResolvedValue({ text: "Lovely!" }) }) });
    const r = await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/up.mp4", songUsed: null });
    expect(r).toMatchObject({ ok: false, reason: "analysis-failed" });
    expect(updates.some((u) => u.table === "social_posts" && u.values.visualStatus === "analyzed")).toBe(false);
  });
});

// Instagram never gives another account's video, so a peer's reel is seen by
// its cover until Matt uploads a copy. The copy gets the same frames, cuts
// and transcript as one of Tara's.
const peerReel = {
  id: "17999000111222333", username: "pippipost.shop", caption: "POV: you finally finish the journal", mediaType: "VIDEO", mediaProductType: "REELS",
  transcript: null, openingWords: null, postedAt: new Date("2026-11-01T00:00:00Z"), visualAttempts: 1,
};

describe("analyseUploadedReel — a peer's reel", () => {
  it("analyses the frames as the peer's, marked as an upload, with the sound the file has", async () => {
    const { deps, inserts } = setup(null, {}, peerReel);
    const r = await analyseUploadedReel(deps, { postId: peerReel.id, filePath: "/tmp/p.mp4", songUsed: "Golden Hour" });
    expect(deps.video.frames).toHaveBeenCalledWith("/tmp/p.mp4", [0, 1000, 2000, 3000, 6000, 9000]);
    const row = inserts.find((w) => w.table === "social_post_visuals")!.values;
    expect(row).toMatchObject({ postId: peerReel.id, account: "peer", status: "ok", basis: "frames", source: "manual_upload", songUsed: "Golden Hour", audio: "speech", cuts: 6 });
    expect(String(row.audioNote)).toMatch(/uploaded file/);
    expect(r).toMatchObject({ ok: true, account: "peer", transcribed: true });
  });

  // Competitor speech must not reach the knowledge base, which feeds the
  // generation of Tara's own copy.
  it("keeps the transcript on the peer post, never in the knowledge base, and has its hook read again", async () => {
    const { deps, inserts, updates } = setup(null, {}, peerReel);
    await analyseUploadedReel(deps, { postId: peerReel.id, filePath: "/tmp/p.mp4", songUsed: null });
    expect(inserts.some((w) => w.table === "kb_documents")).toBe(false);
    expect(updates.find((u) => u.table === "social_peer_posts")!.values).toMatchObject({
      transcript: "Don't do this. I painted this sign in an hour.", openingWords: "Don't do this.",
    });
    expect(updates.find((u) => u.table === "social_post_analyses")!.values).toMatchObject({ status: "stale", attempts: 0 });
  });

  // A teacher's reel teaches in what is said: its lessons are read again with the words.
  it("has the reel's lessons read again now its words are known", async () => {
    const { deps, updates } = setup(null, {}, peerReel);
    await analyseUploadedReel(deps, { postId: peerReel.id, filePath: "/tmp/p.mp4", songUsed: null });
    expect(updates.find((u) => u.table === "social_lesson_runs")!.values).toEqual({ status: "stale", attempts: 0 });
  });

  it("writes nothing to Tara's posts", async () => {
    const { deps, updates } = setup(null, {}, peerReel);
    await analyseUploadedReel(deps, { postId: peerReel.id, filePath: "/tmp/p.mp4", songUsed: null });
    expect(updates.some((u) => u.table === "social_posts")).toBe(false);
  });

  it("records a silent upload as silent and does not transcribe it", async () => {
    const { deps, inserts } = setup(null, { video: video({ inspect: vi.fn().mockResolvedValue({ durationMs: 12_000, hasAudio: false, meanVolumeDb: null, cuts: 6 }) }) }, peerReel);
    const r = await analyseUploadedReel(deps, { postId: peerReel.id, filePath: "/tmp/p.mp4", songUsed: null });
    expect(deps.transcriber!.uploadFile).not.toHaveBeenCalled();
    expect(inserts.find((w) => w.table === "social_post_visuals")!.values).toMatchObject({ audio: "silent" });
    expect(r).toMatchObject({ ok: true, transcribed: false });
  });

  it("refuses a peer post that is not a reel", async () => {
    const { deps } = setup(null, {}, { ...peerReel, mediaType: "IMAGE", mediaProductType: "FEED" });
    expect(await analyseUploadedReel(deps, { postId: peerReel.id, filePath: "/tmp/p.mp4", songUsed: null })).toEqual({ ok: false, reason: "not-a-reel" });
  });
});

// The same pipeline, fed by the downloader instead of by hand.
describe("analyseUploadedReel — downloaded automatically", () => {
  it("marks Tara's reel as an automatic download, with the sound the copy carries", async () => {
    const { deps, inserts } = setup();
    const r = await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/a.mp4", songUsed: null }, { origin: "api_backfill" });
    const row = inserts.find((w) => w.table === "social_post_visuals")!.values;
    expect(row).toMatchObject({ source: "api_backfill", basis: "frames", audio: "speech" });
    expect(String(row.audioNote)).toMatch(/third-party/);
    expect(r).toMatchObject({ ok: true });
  });

  it("calls a downloaded reel with sound but no speech licensed music, likely", async () => {
    const { deps, inserts } = setup(coverOnlyReel, {
      transcriber: createMockAssemblyAiClient({ transcribe: vi.fn().mockResolvedValue({ id: "t", status: "completed", text: "", durationMs: 12_000, words: [] }) }),
    });
    await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/a.mp4", songUsed: null }, { origin: "api_backfill" });
    expect(inserts.find((w) => w.table === "social_post_visuals")!.values).toMatchObject({ audio: "licensed-music-likely" });
  });

  // A file Matt uploaded is never replaced by a downloaded one.
  it("refuses to overwrite a manual upload", async () => {
    const { deps, inserts } = setup({ ...coverOnlyReel, visualSource: "manual_upload" });
    const r = await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/a.mp4", songUsed: null }, { origin: "api_backfill" });
    expect(r).toEqual({ ok: false, reason: "manual-upload-exists" });
    expect(inserts).toEqual([]);
  });

  it("refuses to overwrite a peer reel Matt uploaded", async () => {
    const { deps } = setup(null, {}, { ...peerReel, visualSource: "manual_upload" });
    expect(await analyseUploadedReel(deps, { postId: peerReel.id, filePath: "/tmp/a.mp4", songUsed: null }, { origin: "api_backfill" })).toEqual({ ok: false, reason: "manual-upload-exists" });
  });

  it("marks a teacher's or peer's reel as an automatic download", async () => {
    const { deps, inserts } = setup(null, {}, peerReel);
    await analyseUploadedReel(deps, { postId: peerReel.id, filePath: "/tmp/a.mp4", songUsed: null }, { origin: "api_backfill" });
    expect(inserts.find((w) => w.table === "social_post_visuals")!.values).toMatchObject({ account: "peer", source: "api_backfill", audio: "speech" });
  });

  // Matt's own upload still replaces whatever a download produced.
  it("lets a manual upload replace an automatic one", async () => {
    const { deps, inserts } = setup({ ...coverOnlyReel, visualSource: "api_backfill" });
    await analyseUploadedReel(deps, { postId: coverOnlyReel.id, filePath: "/tmp/a.mp4", songUsed: null });
    expect(inserts.find((w) => w.table === "social_post_visuals")!.values).toMatchObject({ source: "manual_upload" });
  });
});
