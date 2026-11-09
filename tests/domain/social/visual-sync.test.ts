import { describe, it, expect, vi } from "vitest";
import { syncVisuals, type VisualSyncDeps } from "@/domain/social/visual-sync";
import { createMockInstagramApiClient } from "../../mocks/instagram-api";
import { createMockAnthropicClient } from "../../mocks/anthropic";
import { fakeDb } from "../../mocks/recording-db";
import type { VideoToolkit } from "@/integrations/video-frames";

const NOW = new Date("2026-11-09T12:00:00Z");
const answer = JSON.stringify({
  summary: "Tara colours a doodle page.", visualType: "illustration", handDrawn: true,
  onScreenText: [{ at: "0s", text: "Do you colour to calm down?" }], firstFrame: "A doodle page on a desk.",
  visualHook: "Do you colour to calm down?", faceInFirst2s: false, productVisible: true, productFirstSeen: "0s",
  setting: "desk", emotion: "calm", branding: false,
});

const ownReel = { id: "r1", caption: "c", mediaType: "VIDEO", mediaProductType: "REELS", postedAt: new Date("2026-11-05T00:00:00Z"), transcriptionStatus: "ok", openingWords: "Do you colour", durationMs: null, visualStatus: null, visualAttempts: null };

function video(): VideoToolkit {
  return {
    inspect: vi.fn().mockResolvedValue({ durationMs: 10_000, hasAudio: true, meanVolumeDb: -20, cuts: 4 }),
    frames: vi.fn().mockImplementation(async (_f: string, times: number[]) => times.map(() => Buffer.from("jpg"))),
    contactSheet: vi.fn().mockResolvedValue(Buffer.from("sheet")),
  };
}

function deps(seed: Record<string, Record<string, unknown>[]>, o: Partial<VisualSyncDeps> = {}) {
  const d = fakeDb(seed);
  const anthropic = createMockAnthropicClient({ generate: vi.fn().mockResolvedValue({ text: answer }) });
  const v = video();
  const full: VisualSyncDeps = {
    db: d.db,
    client: createMockInstagramApiClient({ getMediaAssets: vi.fn().mockResolvedValue({ videoUrl: "https://cdn/v.mp4", coverUrl: "https://cdn/c.jpg", imageUrls: [] }) }),
    anthropic,
    video: v,
    fetchMedia: vi.fn().mockResolvedValue({ data: Buffer.from("bytes"), contentType: "image/jpeg" }),
    writeTemp: vi.fn().mockResolvedValue({ path: "/tmp/v.mp4", remove: async () => {} }),
    now: () => NOW,
    ...o,
  };
  return { ...d, deps: full, anthropic: full.anthropic, video: full.video };
}

describe("syncVisuals — Tara's reels", () => {
  it("measures the video, sends its frames labelled by time, and stores what it shows", async () => {
    const { deps: d, inserts, updates, anthropic, video: v } = deps({ social_posts: [ownReel] });
    const r = await syncVisuals(d, []);
    expect(v.frames).toHaveBeenCalledWith("/tmp/v.mp4", [0, 1000, 2000, 3000, 6000, 9000]);
    const images = vi.mocked(anthropic.generate).mock.calls[0][1]!.images!;
    expect(images.map((i) => i.label)).toEqual(["Frame at 0s", "Frame at 1s", "Frame at 2s", "Frame at 3s", "Frame at 6s", "Frame at 9s"]);
    const row = inserts.find((w) => w.table === "social_post_visuals")!.values;
    expect(row).toMatchObject({
      postId: "r1", account: "own", status: "ok", attempts: 1, basis: "frames", visualHook: "Do you colour to calm down?",
      faceInFirst2s: 0, productVisible: 1, handDrawn: 1, durationMs: 10_000, cuts: 4, cutsPerMinute: 24, audio: "speech",
    });
    expect(row.contactSheet).toEqual(Buffer.from("sheet"));
    // A reel transcribed before lengths were kept gets one now.
    expect(updates.find((u) => u.table === "social_posts")!.values).toMatchObject({ durationMs: 10_000 });
    expect(r).toMatchObject({ analysed: 1, failed: 0, unavailable: 0 });
  });

  // Licensed music: Instagram withholds the file, the cover is all there is.
  it("analyses the cover of a reel whose video is withheld, and says what that implies about its sound", async () => {
    const { deps: d, inserts, video: v } = deps({ social_posts: [ownReel] }, {
      client: createMockInstagramApiClient({ getMediaAssets: vi.fn().mockResolvedValue({ videoUrl: null, coverUrl: "https://cdn/c.jpg", imageUrls: [] }) }),
    });
    await syncVisuals(d, []);
    expect(v.inspect).not.toHaveBeenCalled();
    expect(inserts.find((w) => w.table === "social_post_visuals")!.values).toMatchObject({
      basis: "cover", audio: "licensed-music-likely", faceInFirst2s: null, visualHook: null, contactSheet: null,
    });
  });

  it("sends a carousel's slides in order", async () => {
    const { deps: d, inserts, anthropic } = deps({ social_posts: [{ ...ownReel, mediaType: "CAROUSEL_ALBUM", mediaProductType: "FEED" }] }, {
      client: createMockInstagramApiClient({ getMediaAssets: vi.fn().mockResolvedValue({ videoUrl: null, coverUrl: null, imageUrls: ["https://cdn/1.jpg", "https://cdn/2.jpg"] }) }),
    });
    await syncVisuals(d, []);
    expect(vi.mocked(anthropic.generate).mock.calls[0][1]!.images!.map((i) => i.label)).toEqual(["Slide 1", "Slide 2"]);
    expect(inserts.find((w) => w.table === "social_post_visuals")!.values).toMatchObject({ basis: "slides", imageCount: 2, audio: null });
  });

  it("records a post with nothing to look at as unavailable, without asking the model", async () => {
    const { deps: d, inserts, anthropic } = deps({ social_posts: [ownReel] }, {
      client: createMockInstagramApiClient({ getMediaAssets: vi.fn().mockResolvedValue({ videoUrl: null, coverUrl: null, imageUrls: [] }) }),
    });
    const r = await syncVisuals(d, []);
    expect(anthropic.generate).not.toHaveBeenCalled();
    expect(inserts.find((w) => w.table === "social_post_visuals")!.values).toMatchObject({ status: "unavailable" });
    expect(r.unavailable).toBe(1);
  });

  // Fail closed: an unreadable answer is retried, never stored as a finding.
  it("records an unreadable answer as an error and counts the attempt", async () => {
    const { deps: d, inserts } = deps({ social_posts: [{ ...ownReel, visualStatus: "error", visualAttempts: 1 }] }, {
      anthropic: createMockAnthropicClient({ generate: vi.fn().mockResolvedValue({ text: "I see a lovely video!" }) }),
    });
    const r = await syncVisuals(d, []);
    expect(inserts.find((w) => w.table === "social_post_visuals")!.values).toMatchObject({ status: "error", attempts: 2, visualType: null });
    expect(r.failed).toBe(1);
  });

  it("records a download that failed as an error and carries on", async () => {
    const errors: string[] = [];
    const { deps: d, inserts } = deps({ social_posts: [ownReel] }, { fetchMedia: vi.fn().mockRejectedValue(new Error("403 from cdn")) });
    await syncVisuals(d, errors);
    expect(inserts.find((w) => w.table === "social_post_visuals")!.values).toMatchObject({ status: "error", detail: expect.stringMatching(/403/) });
  });
});

describe("syncVisuals — peers", () => {
  // Business Discovery never gives another account's video.
  it("analyses a peer reel from the cover it was given, with no sound recorded", async () => {
    const { deps: d, inserts, anthropic } = deps({
      social_peer_posts: [{ id: "p1", caption: "Which book ruined you?", mediaType: "VIDEO", mediaProductType: "REELS", imageUrls: ["https://cdn/pc.jpg"], visualStatus: null, visualAttempts: null }],
    });
    await syncVisuals(d, []);
    expect(vi.mocked(anthropic.generate).mock.calls[0][1]!.images!.map((i) => i.label)).toEqual(["Cover image"]);
    expect(inserts.find((w) => w.table === "social_post_visuals")!.values).toMatchObject({ postId: "p1", account: "peer", basis: "cover", audio: null });
  });
});
