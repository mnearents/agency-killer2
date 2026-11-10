import { describe, it, expect, vi } from "vitest";
import { createMockInstagramApiClient } from "../../mocks/instagram-api";
import { createMockAssemblyAiClient } from "../../mocks/assemblyai";
import { createMockAnthropicClient } from "../../mocks/anthropic";
import { fakeDb } from "../../mocks/recording-db";
import {
  transformMediaToPost,
  syncSocialPosts,
  DEFAULT_MEDIA_LIMIT,
  postUpsertSet,
  type TransformInput,
} from "@/domain/social/sync";
import type { IgMedia, IgMediaInsights } from "@/integrations/instagram-api";

function makeMedia(overrides: Partial<IgMedia> = {}): IgMedia {
  return {
    id: "17890000000000001",
    caption: "New stationery drop! 🎨✨ #radandhappy",
    media_type: "IMAGE",
    media_product_type: "FEED",
    permalink: "https://www.instagram.com/p/abc123/",
    thumbnail_url: undefined,
    media_url: "https://scontent.cdninstagram.com/image.jpg",
    timestamp: "2026-07-15T14:30:00+0000",
    like_count: 245,
    comments_count: 18,
    ...overrides,
  };
}

function makeInsights(overrides: Partial<IgMediaInsights> = {}): IgMediaInsights {
  return {
    mediaId: "17890000000000001",
    impressions: 5200,
    reach: 3800,
    saved: 92,
    shares: 15,
    plays: 0,
    totalInteractions: 370,
    ...overrides,
  };
}

describe("transformMediaToPost", () => {
  const igUserId = "17841400000000000";
  const syncedAt = new Date("2026-07-28T12:00:00Z");

  it("transforms a feed image post with insights", () => {
    const input: TransformInput = {
      media: makeMedia(),
      insights: makeInsights(),
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.id).toBe("17890000000000001");
    expect(result.igUserId).toBe(igUserId);
    expect(result.caption).toBe("New stationery drop! 🎨✨ #radandhappy");
    expect(result.mediaType).toBe("IMAGE");
    expect(result.mediaProductType).toBe("FEED");
    expect(result.permalink).toBe("https://www.instagram.com/p/abc123/");
    expect(result.likeCount).toBe(245);
    expect(result.commentsCount).toBe(18);
    expect(result.impressions).toBe(5200);
    expect(result.reach).toBe(3800);
    expect(result.saved).toBe(92);
    expect(result.shares).toBe(15);
    expect(result.plays).toBe(0);
    expect(result.totalInteractions).toBe(370);
    expect(result.postedAt).toEqual(new Date("2026-07-15T14:30:00+0000"));
    expect(result.syncedAt).toEqual(syncedAt);
  });

  it("transforms a reel with plays", () => {
    const input: TransformInput = {
      media: makeMedia({
        id: "reel-1",
        media_type: "VIDEO",
        media_product_type: "REELS",
        thumbnail_url: "https://scontent.cdninstagram.com/thumb.jpg",
      }),
      insights: makeInsights({
        mediaId: "reel-1",
        plays: 12500,
        shares: 45,
      }),
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.mediaType).toBe("VIDEO");
    expect(result.mediaProductType).toBe("REELS");
    expect(result.plays).toBe(12500);
    expect(result.shares).toBe(45);
    expect(result.thumbnailUrl).toBe("https://scontent.cdninstagram.com/thumb.jpg");
  });

  it("transforms a carousel post", () => {
    const input: TransformInput = {
      media: makeMedia({
        id: "carousel-1",
        media_type: "CAROUSEL_ALBUM",
        media_product_type: "FEED",
      }),
      insights: makeInsights({ mediaId: "carousel-1" }),
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.mediaType).toBe("CAROUSEL_ALBUM");
    expect(result.mediaProductType).toBe("FEED");
  });

  it("handles missing caption", () => {
    const input: TransformInput = {
      media: makeMedia({ caption: undefined }),
      insights: makeInsights(),
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.caption).toBeNull();
  });

  it("handles missing like_count and comments_count", () => {
    const input: TransformInput = {
      media: makeMedia({ like_count: undefined, comments_count: undefined }),
      insights: makeInsights(),
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.likeCount).toBe(0);
    expect(result.commentsCount).toBe(0);
  });

  it("uses null insights when insights fetch failed", () => {
    const input: TransformInput = {
      media: makeMedia(),
      insights: null,
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.impressions).toBe(0);
    expect(result.reach).toBe(0);
    expect(result.saved).toBe(0);
    expect(result.shares).toBe(0);
    expect(result.plays).toBe(0);
    expect(result.totalInteractions).toBe(0);
    // Basic engagement from media object is still available
    expect(result.likeCount).toBe(245);
    expect(result.commentsCount).toBe(18);
  });
});

describe("DEFAULT_MEDIA_LIMIT", () => {
  // A rolling window, not a backfill: anything older than this is only stored
  // if a run caught it at the time. 20 covers a daily run several times over
  // at 55-56 reels a month, where 50 mostly re-fetched insights for posts
  // already stored.
  it("is 20", () => {
    expect(DEFAULT_MEDIA_LIMIT).toBe(20);
  });

  it("is what syncSocialPosts asks the client for when no limit is given", async () => {
    const asked: number[] = [];
    const client = {
      getRecentMedia: async (_id: string, limit: number) => {
        asked.push(limit);
        return [];
      },
      getStories: async () => [],
      getMediaInsights: async () => {
        throw new Error("not reached");
      },
    } as unknown as Parameters<typeof syncSocialPosts>[0]["client"];

    await syncSocialPosts({ client, db: fakeDb().db, igUserId: "ig1", sleep: async () => {} });
    expect(asked).toEqual([DEFAULT_MEDIA_LIMIT]);
  });

  it("still honours an explicit limit, so a backfill can reach further back", async () => {
    const asked: number[] = [];
    const client = {
      getRecentMedia: async (_id: string, limit: number) => {
        asked.push(limit);
        return [];
      },
      getStories: async () => [],
      getMediaInsights: async () => {
        throw new Error("not reached");
      },
    } as unknown as Parameters<typeof syncSocialPosts>[0]["client"];

    await syncSocialPosts({ client, db: fakeDb().db, igUserId: "ig1", sleep: async () => {} }, 200);
    expect(asked).toEqual([200]);
  });
});

// ─── The sync at its call sites ────────────────────────────────────────

const NOW = new Date("2026-11-09T12:00:00Z");
const noSleep = async () => {};

function client(overrides: Record<string, unknown> = {}) {
  return createMockInstagramApiClient({
    getAccountInfo: vi.fn().mockResolvedValue({ id: "ig1", username: "radandhappy", followers_count: 128_240, media_count: 4461 }),
    getAccountDay: vi.fn().mockResolvedValue({
      follows: 14, unfollows: 11, reach: 7831, reachFollowers: 4597, reachNonFollowers: 3045,
      views: 16518, viewsReel: 349, viewsPost: 3623, viewsCarousel: 526, viewsStory: 9285, viewsAd: 2735, profileViews: 112, accountsEngaged: 240,
    }),
    ...overrides,
  } as never);
}

const reelMedia = makeMedia({ id: "reel-1", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-11-02T19:29:21+0000" });

describe("syncSocialPosts — insights", () => {
  // The bug that kept every reel's shares, views and watch time out of the
  // database: the product type never reached the client.
  it("tells the client a reel is a reel", async () => {
    const c = client({ getRecentMedia: vi.fn().mockResolvedValue([reelMedia]) });
    await syncSocialPosts({ client: c, db: fakeDb().db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    expect(c.getMediaInsights).toHaveBeenCalledWith("reel-1", "VIDEO", "REELS");
  });

  it("stores views, reposts and watch time, and marks the insights ok", async () => {
    const c = client({
      getRecentMedia: vi.fn().mockResolvedValue([reelMedia]),
      getMediaInsights: vi.fn().mockResolvedValue(makeInsights({ mediaId: "reel-1", views: 2457, reposts: 0, avgWatchTimeMs: 9552, totalWatchTimeMs: 19_315_845, follows: null })),
    });
    const { db, inserts } = fakeDb();
    await syncSocialPosts({ client: c, db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    const post = inserts.find((w) => w.table === "social_posts")!;
    expect(post.values).toMatchObject({ views: 2457, reposts: 0, avgWatchTimeMs: 9552, totalWatchTimeMs: 19_315_845, follows: null, insightsStatus: "ok" });
  });

  // A refused fetch used to upsert zeros over the numbers already held, so a
  // post that did well read as a flop the day its insights call failed.
  it("does not overwrite held numbers when the insights fetch fails", async () => {
    const c = client({
      getRecentMedia: vi.fn().mockResolvedValue([reelMedia]),
      getMediaInsights: vi.fn().mockRejectedValue(new Error("Instagram API error (400): nope")),
    });
    const { db, inserts } = fakeDb();
    await syncSocialPosts({ client: c, db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    const post = inserts.find((w) => w.table === "social_posts")!;
    expect(post.values.insightsStatus).toBe("failed");
    expect(Object.keys(post.set!)).not.toEqual(expect.arrayContaining(["reach"]));
    expect(Object.keys(post.set!)).not.toContain("views");
    expect(Object.keys(post.set!)).not.toContain("insightsStatus");
    expect(Object.keys(post.set!)).toContain("likeCount");
  });

  it("snapshots a measured post's day and not a failed one", async () => {
    const other = makeMedia({ id: "img-1", timestamp: "2026-11-08T12:00:00+0000" });
    const c = client({
      getRecentMedia: vi.fn().mockResolvedValue([reelMedia, other]),
      getMediaInsights: vi.fn().mockImplementation(async (id: string) => {
        if (id === "img-1") throw new Error("Instagram API error (400): nope");
        return makeInsights({ mediaId: id, views: 2457 });
      }),
    });
    const { db, inserts } = fakeDb();
    const r = await syncSocialPosts({ client: c, db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    const snaps = inserts.filter((w) => w.table === "social_post_snapshots");
    expect(snaps.map((w) => w.values.postId)).toEqual(["reel-1"]);
    expect(snaps[0].values).toMatchObject({ capturedOn: "2026-11-09", ageHours: 160, views: 2457 });
    expect(r.snapshots).toBe(1);
  });
});

describe("syncSocialPosts — the account", () => {
  it("records today's follower count", async () => {
    const { db, inserts } = fakeDb();
    const r = await syncSocialPosts({ client: client(), db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    const today = inserts.find((w) => w.table === "social_account_days" && w.values.day === "2026-11-09")!;
    expect(today.values).toMatchObject({ followersCount: 128_240 });
    // The day's other measures are not over yet and must not be blanked.
    expect(Object.keys(today.set!)).toEqual(expect.arrayContaining(["followersCount", "followersCapturedAt"]));
    expect(Object.keys(today.set!)).not.toContain("follows");
    expect(r.followersCount).toBe(128_240);
  });

  it("reads each complete day it does not hold, and keeps the follower count already on it", async () => {
    const c = client();
    const { db, inserts } = fakeDb();
    const r = await syncSocialPosts({ client: c, db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    expect(c.getAccountDay).toHaveBeenCalledWith("ig1", "2026-11-08");
    expect(c.getAccountDay).toHaveBeenCalledWith("ig1", "2026-10-12");
    expect(c.getAccountDay).not.toHaveBeenCalledWith("ig1", "2026-11-09");
    const day = inserts.find((w) => w.table === "social_account_days" && w.values.day === "2026-11-08")!;
    expect(day.values).toMatchObject({ follows: 14, unfollows: 11, reachNonFollowers: 3045 });
    expect(Object.keys(day.set!)).not.toContain("followersCount");
    expect(r.accountDays).toBe(28);
  });

  it("skips held days except the last three", async () => {
    const held = Array.from({ length: 28 }, (_, i) => ({ day: new Date(Date.parse("2026-10-12T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10) }));
    const c = client();
    await syncSocialPosts({ client: c, db: fakeDb({ social_account_days: held }).db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    expect(c.getAccountDay).toHaveBeenCalledTimes(3);
  });

  // The posts are the larger half of the sync; an account read that fails
  // must be reported, not take them down with it.
  it("reports a failed account read and still syncs the posts", async () => {
    const c = client({
      getRecentMedia: vi.fn().mockResolvedValue([reelMedia]),
      getAccountInfo: vi.fn().mockRejectedValue(new Error("Instagram API error (500): down")),
      getAccountDay: vi.fn().mockRejectedValue(new Error("Instagram API error (500): down")),
    });
    const { db, inserts } = fakeDb();
    const r = await syncSocialPosts({ client: c, db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    expect(inserts.some((w) => w.table === "social_posts")).toBe(true);
    expect(r.errors.join(" ")).toMatch(/follower count.*down/);
    expect(r.errors.join(" ")).toMatch(/account day 2026-11-08.*down/);
    expect(r.followersCount).toBeNull();
  });
});

describe("syncSocialPosts — transcripts", () => {
  it("keeps the reel's length and the words of its first three seconds", async () => {
    const c = client({ getRecentMedia: vi.fn().mockResolvedValue([reelMedia]) });
    const transcriber = createMockAssemblyAiClient({
      transcribe: vi.fn().mockResolvedValue({
        id: "t1", status: "completed", text: "Stop buying planners. Here's why.", durationMs: 21_400,
        words: [{ text: "Stop", start: 100, end: 400, confidence: 1 }, { text: "buying", start: 450, end: 800, confidence: 1 }, { text: "planners.", start: 850, end: 1400, confidence: 1 }, { text: "Here's", start: 3100, end: 3400, confidence: 1 }],
      }),
    });
    const { db, updates } = fakeDb();
    await syncSocialPosts({ client: c, db, igUserId: "ig1", transcriber, now: () => NOW, sleep: noSleep });
    expect(updates.find((u) => u.table === "social_posts")!.values).toMatchObject({ transcriptionStatus: "ok", durationMs: 21_400, openingWords: "Stop buying planners." });
  });
});

describe("syncSocialPosts — what each post was", () => {
  const candidate = { id: "img-9", caption: "5 ways to use stickers in your planner", mediaType: "CAROUSEL_ALBUM", mediaProductType: "FEED", transcriptionStatus: null, transcriptionAttempts: 0, analysisStatus: null, analysisAttempts: null };
  const answer = JSON.stringify({ summary: "Sticker ideas.", hook: "5 ways to use stickers in your planner", hookType: "list", topic: "planner stickers", approach: "teach", audience: "planner lovers" });

  it("analyses posts not yet analysed and stores what it found", async () => {
    const anthropic = createMockAnthropicClient({ generate: vi.fn().mockResolvedValue({ text: answer }) });
    const { db, inserts } = fakeDb({ social_posts: [candidate] });
    const r = await syncSocialPosts({ client: client(), db, igUserId: "ig1", anthropic, now: () => NOW, sleep: noSleep });
    const row = inserts.find((w) => w.table === "social_post_analyses")!;
    expect(row.values).toMatchObject({ postId: "img-9", status: "ok", attempts: 1, basis: "caption", hookType: "list", approach: "teach", hookSource: "caption" });
    expect(r.analysed).toBe(1);
  });

  // Fail closed: an unreadable answer is an error to retry, not an empty analysis.
  it("records an unreadable answer as an error and counts the attempt", async () => {
    const anthropic = createMockAnthropicClient({ generate: vi.fn().mockResolvedValue({ text: "Sure! Here's my analysis." }) });
    const { db, inserts } = fakeDb({ social_posts: [{ ...candidate, analysisStatus: "error", analysisAttempts: 1 }] });
    const r = await syncSocialPosts({ client: client(), db, igUserId: "ig1", anthropic, now: () => NOW, sleep: noSleep });
    expect(inserts.find((w) => w.table === "social_post_analyses")!.values).toMatchObject({ status: "error", attempts: 2, hookType: null });
    expect(r.analysisFailed).toBe(1);
  });

  // Analysed from the caption while its transcript is still coming, a reel
  // would be filed as caption-only for good.
  it("waits for a reel's transcript before analysing it", async () => {
    const anthropic = createMockAnthropicClient({ generate: vi.fn().mockResolvedValue({ text: answer }) });
    const { db } = fakeDb({ social_posts: [{ ...candidate, mediaType: "VIDEO", mediaProductType: "REELS", transcriptionStatus: "error", transcriptionAttempts: 1 }] });
    await syncSocialPosts({ client: client(), db, igUserId: "ig1", anthropic, now: () => NOW, sleep: noSleep });
    expect(anthropic.generate).not.toHaveBeenCalled();
  });

  it("says analysis is not configured without an Anthropic client, rather than reporting none to do", async () => {
    const r = await syncSocialPosts({ client: client(), db: fakeDb({ social_posts: [candidate] }).db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    expect(r.analysisConfigured).toBe(false);
  });
});

describe("thumbnails", () => {
  // The review page shows each post. Images and carousels have no
  // thumbnail_url — their picture is media_url — and Instagram's links
  // expire, so each sync refreshes the one held.
  it("uses an image's own picture as its thumbnail", () => {
    const r = transformMediaToPost({ media: makeMedia({ thumbnail_url: undefined, media_url: "https://cdn/img.jpg" }), insights: null, igUserId: "ig", syncedAt: NOW });
    expect(r.thumbnailUrl).toBe("https://cdn/img.jpg");
  });

  it("never uses a video file as a thumbnail", () => {
    const r = transformMediaToPost({ media: makeMedia({ media_type: "VIDEO", thumbnail_url: undefined, media_url: "https://cdn/v.mp4" }), insights: null, igUserId: "ig", syncedAt: NOW });
    expect(r.thumbnailUrl).toBeNull();
  });

  it("refreshes the thumbnail on every sync, measured or not", () => {
    expect(Object.keys(postUpsertSet(false))).toContain("thumbnailUrl");
    expect(Object.keys(postUpsertSet(true))).toContain("thumbnailUrl");
  });
});

describe("syncSocialPosts — peer accounts", () => {
  const peerMedia = (id: string, o: Record<string, unknown> = {}) => ({
    id, caption: "Which book ruined you?", mediaType: "VIDEO", mediaProductType: "REELS", permalink: null, thumbnailUrl: null,
    timestamp: "2026-11-05T18:14:42+0000", likeCount: 205, commentsCount: 256, viewCount: 40_015, ...o,
  });

  it("reads each tracked account and keeps its follower count and posts", async () => {
    const c = client({
      getPeerAccount: vi.fn().mockResolvedValue({ profile: { username: "pippipost.shop", name: "Pippi Post", followersCount: 250_599, mediaCount: 2544 }, media: [peerMedia("m1")] }),
    });
    const { db, inserts } = fakeDb({ social_peers: [{ username: "pippipost.shop" }] });
    const r = await syncSocialPosts({ client: c, db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    expect(c.getPeerAccount).toHaveBeenCalledWith("ig1", "pippipost.shop", 50);
    expect(inserts.find((w) => w.table === "social_peer_days")!.values).toMatchObject({ username: "pippipost.shop", day: "2026-11-09", followersCount: 250_599 });
    const post = inserts.find((w) => w.table === "social_peer_posts")!;
    expect(post.values).toMatchObject({ id: "m1", username: "pippipost.shop", viewCount: 40_015, mediaProductType: "REELS" });
    // When it was first seen is kept; the numbers move.
    expect(Object.keys(post.set!)).not.toContain("firstSeenAt");
    expect(Object.keys(post.set!)).toContain("viewCount");
    expect(r.peers).toEqual({ read: 1, failed: 0, posts: 1 });
  });

  it("reports an account it cannot read and carries on with the rest", async () => {
    const c = client({
      getPeerAccount: vi.fn().mockImplementation(async (_ig: string, u: string) => {
        if (u === "gone.shop") throw new Error("Instagram API error (400): no such user");
        return { profile: { username: u, name: null, followersCount: 10, mediaCount: 1 }, media: [] };
      }),
    });
    const { db } = fakeDb({ social_peers: [{ username: "gone.shop" }, { username: "pippipost.shop" }] });
    const r = await syncSocialPosts({ client: c, db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    expect(r.peers).toEqual({ read: 1, failed: 1, posts: 0 });
    expect(r.errors.join(" ")).toMatch(/@gone\.shop.*no such user/);
  });

  it("analyses a peer's posts from the caption", async () => {
    const anthropic = createMockAnthropicClient({ generate: vi.fn().mockResolvedValue({ text: JSON.stringify({ summary: "A question to readers.", hook: "Which book ruined you?", hookType: "question", approach: "community", topic: "reading", audience: "book lovers" }) }) });
    const { db, inserts } = fakeDb({ social_peer_posts: [{ id: "m1", caption: "Which book ruined you?", mediaType: "VIDEO", mediaProductType: "REELS", analysisStatus: null, analysisAttempts: null }] });
    const r = await syncSocialPosts({ client: client(), db, igUserId: "ig1", anthropic, now: () => NOW, sleep: noSleep });
    expect(inserts.find((w) => w.table === "social_post_analyses")!.values).toMatchObject({ postId: "m1", basis: "caption", hookType: "question" });
    expect(r.analysed).toBe(1);
  });
});

describe("syncSocialPosts — visuals", () => {
  it("keeps a peer post's pictures, refreshed each sync because the links expire", async () => {
    const c = client({
      getPeerAccount: vi.fn().mockResolvedValue({ profile: { username: "p", name: null, followersCount: 1, mediaCount: 1 }, media: [{
        id: "m1", caption: "c", mediaType: "IMAGE", mediaProductType: "FEED", permalink: null, thumbnailUrl: null, timestamp: "2026-11-05T00:00:00+0000",
        likeCount: 1, commentsCount: 1, viewCount: null, imageUrls: ["https://cdn/a.jpg"],
      }] }),
    });
    const { db, inserts } = fakeDb({ social_peers: [{ username: "p" }] });
    await syncSocialPosts({ client: c, db, igUserId: "ig1", now: () => NOW, sleep: noSleep });
    const post = inserts.find((w) => w.table === "social_peer_posts")!;
    expect(post.values.imageUrls).toEqual(["https://cdn/a.jpg"]);
    expect(Object.keys(post.set!)).toContain("imageUrls");
  });

  it("looks at what each post shows when given the video tools", async () => {
    const c = client({ getMediaAssets: vi.fn().mockResolvedValue({ videoUrl: null, coverUrl: null, imageUrls: [] }) });
    const anthropic = createMockAnthropicClient({ generate: vi.fn().mockResolvedValue({ text: "{}" }) });
    const { db } = fakeDb({ social_posts: [{ id: "img-1", caption: "c", mediaType: "IMAGE", mediaProductType: "FEED", transcriptionStatus: null, transcriptionAttempts: 0, analysisStatus: null, analysisAttempts: null, visualStatus: null, visualAttempts: null, durationMs: null }] });
    const r = await syncSocialPosts({
      client: c, db, igUserId: "ig1", anthropic, now: () => NOW, sleep: noSleep,
      visuals: { video: { inspect: vi.fn(), frames: vi.fn(), contactSheet: vi.fn(), extractAudio: vi.fn() }, fetchMedia: vi.fn(), writeTemp: vi.fn() },
    });
    expect(c.getMediaAssets).toHaveBeenCalledWith("img-1");
    expect(r.visuals).toMatchObject({ configured: true, unavailable: 1 });
  });

  it("says visuals are not configured without the video tools, rather than reporting none to do", async () => {
    const r = await syncSocialPosts({ client: client(), db: fakeDb().db, igUserId: "ig1", anthropic: createMockAnthropicClient(), now: () => NOW, sleep: noSleep });
    expect(r.visuals).toEqual({ configured: false, analysed: 0, failed: 0, unavailable: 0, failures: [] });
  });
});

describe("cover-only reels", () => {
  const at = { igUserId: "ig", syncedAt: NOW, insights: null };

  // Instagram omits media_url on reels carrying licensed music.
  it("flags a reel Instagram gives no video for as cover only", () => {
    const r = transformMediaToPost({ ...at, media: makeMedia({ media_type: "VIDEO", media_product_type: "REELS", media_url: undefined, thumbnail_url: "https://cdn/c.jpg" }) });
    expect(r.visualStatus).toBe("cover_only");
  });

  it("leaves a reel with its video, and anything that is not a reel, unflagged", () => {
    expect(transformMediaToPost({ ...at, media: makeMedia({ media_type: "VIDEO", media_product_type: "REELS", media_url: "https://cdn/v.mp4" }) }).visualStatus).toBeNull();
    expect(transformMediaToPost({ ...at, media: makeMedia({ media_url: undefined }) }).visualStatus).toBeNull();
  });

  // An uploaded reel was analysed from its frames; the next sync, which still
  // gets no video, must not undo that.
  it("never sets an analysed reel back to cover only", () => {
    const set = postUpsertSet(true) as Record<string, { queryChunks?: unknown[] }>;
    expect(JSON.stringify(set.visualStatus)).toMatch(/analyzed/);
    expect(Object.keys(postUpsertSet(false))).toContain("visualStatus");
  });
});
