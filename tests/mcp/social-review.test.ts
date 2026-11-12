import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchTool, type McpToolContext } from "@/mcp/tools";
import { McpArgumentError } from "@/mcp/args";
import * as reviewQueries from "@/domain/social/review-queries";
import type { ReviewPost } from "@/domain/social/review";

vi.mock("@/domain/social/review-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/social/review-queries")>()),
  getReviewPosts: vi.fn(),
  getAccountDayRows: vi.fn(),
  getLatestReview: vi.fn(),
  saveReview: vi.fn(),
  getPeers: vi.fn(),
  getPeerPosts: vi.fn(),
  getPeerDays: vi.fn(),
  setPeer: vi.fn(),
  getTargets: vi.fn(),
  recordTarget: vi.fn(),
  getLessons: vi.fn(),
  getLessonCoverage: vi.fn(),
  getTeacherAdvice: vi.fn(),
}));
vi.mock("@/domain/social/download-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/social/download-queries")>()),
  getDownloadSummary: vi.fn().mockResolvedValue({ ok: 4, failed: 1, rateLimited: 0 }),
}));

const NOW = new Date("2026-11-09T12:00:00Z");
const ctx: McpToolContext = { db: {} as never, now: () => NOW, actor: "Matt" };
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

let n = 0;
const reel = (o: Partial<ReviewPost> = {}): ReviewPost => ({
  id: `r${++n}`, caption: "caption", permalink: "https://instagram.com/reel/x", thumbnailUrl: null, format: "reel", postedAt: daysAgo(20),
  views: 1000, reach: 800, likes: 40, comments: 4, saved: 4, shares: 2, reposts: 0, follows: null, profileVisits: null,
  avgWatchTimeMs: 5000, durationMs: 20_000, insightsStatus: "ok", openingWords: "Stop buying planners.",
  analysis: { hookType: "bold-claim", approach: "teach", audience: "planner lovers", topic: "planning", hook: "Stop buying planners." },
  ...o,
});

const accountDay = (day: string, o: Record<string, unknown> = {}) => ({
  day, followersCount: null, follows: 14, unfollows: 11, reach: 7831, reachFollowers: 4597, reachNonFollowers: 3045,
  views: 16518, viewsReel: 349, viewsPost: 3623, viewsCarousel: 526, viewsStory: 9285, viewsAd: 2735, profileViews: 112, accountsEngaged: 240,
  insightsFetchedAt: NOW, ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  const usual = Array.from({ length: 6 }, () => reel());
  vi.mocked(reviewQueries.getReviewPosts).mockResolvedValue([reel({ id: "hit", postedAt: daysAgo(5), views: 4000 }), reel({ id: "new", postedAt: daysAgo(0.5), views: 90 }), ...usual]);
  vi.mocked(reviewQueries.getAccountDayRows).mockResolvedValue(
    Array.from({ length: 35 }, (_, i) => accountDay(new Date(Date.parse("2026-10-05T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10))),
  );
  vi.mocked(reviewQueries.getLatestReview).mockResolvedValue(null);
  vi.mocked(reviewQueries.getTargets).mockResolvedValue([]);
  vi.mocked(reviewQueries.getPeers).mockResolvedValue([{ username: "pippipost.shop", purpose: "peer", notes: "bookish merch", active: true }]);
  vi.mocked(reviewQueries.getPeerPosts).mockResolvedValue([
    ...Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, username: "pippipost.shop", caption: "c", format: "reel" as const, permalink: null, thumbnailUrl: null, postedAt: daysAgo(15 + i), likeCount: 100, commentsCount: 10, viewCount: 10_000, analysis: null })),
    { id: "pp-hit", username: "pippipost.shop", caption: "Which book ruined you?", format: "reel" as const, permalink: "https://instagram.com/reel/pp", thumbnailUrl: null, postedAt: daysAgo(4), likeCount: 205, commentsCount: 256, viewCount: 40_015, analysis: { hookType: "question", approach: "community", audience: "book lovers", topic: "reading", hook: "Which book ruined you?" } },
  ]);
  vi.mocked(reviewQueries.getPeerDays).mockResolvedValue([{ username: "pippipost.shop", day: "2026-11-08", name: "Pippi Post", followersCount: 250_599, mediaCount: 2544 }]);
});

describe("social_review", () => {
  it("covers the seven complete days ending yesterday by default", async () => {
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.week).toEqual({ start: "2026-11-02", end: "2026-11-08" });
  });

  it("takes a week by its first day", async () => {
    const r = (await dispatchTool(ctx, "social_review", { weekStart: "2026-10-26" })) as Record<string, any>;
    expect(r.week).toEqual({ start: "2026-10-26", end: "2026-11-01" });
  });

  it("summarises the account's week against the week before and the four before that", async () => {
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.account.thisWeek).toMatchObject({ follows: 98, unfollows: 77, net: 21, daysMeasured: 7 });
    expect(r.account.previousWeek).toMatchObject({ from: "2026-10-26", to: "2026-11-01" });
    expect(r.account.fourWeeksBefore).toMatchObject({ from: "2026-10-05", to: "2026-11-01", daysMeasured: 28 });
  });

  it("judges each post in the week against her usual, with what it was", async () => {
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    const hit = r.posts.find((p: { id: string }) => p.id === "hit");
    expect(hit).toMatchObject({ verdict: "breakout", vsUsual: { views: 4 }, hookType: "bold-claim", openingWords: "Stop buying planners.", lengthSeconds: 20 });
    expect(r.posts.map((p: { id: string }) => p.id)).not.toContain("new"); // posted today, outside the week
  });

  it("gives her usual per format and the 90-day patterns", async () => {
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.usual.find((u: { format: string }) => u.format === "reel")).toMatchObject({ views: { median: 1000, n: 7 } });
    expect(Array.isArray(r.patterns)).toBe(true);
  });

  // Coverage is part of the answer: a week reviewed from half its data must
  // say so, or the review reads gaps as results.
  it("says what the numbers lack", async () => {
    vi.mocked(reviewQueries.getReviewPosts).mockResolvedValue([reel({ postedAt: daysAgo(4), views: null, analysis: null })]);
    vi.mocked(reviewQueries.getAccountDayRows).mockResolvedValue([accountDay("2026-11-05")]);
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.coverage).toMatchObject({ postsInWeek: 1, postsWithViews: 0, postsAnalysed: 0, accountDaysMeasured: 1 });
    expect(r.coverage.notes.join(" ")).toMatch(/1 of 7 days/);
  });

  // The next review checks whether last week's suggestions were tried.
  it("returns the last review's suggestions", async () => {
    vi.mocked(reviewQueries.getLatestReview).mockResolvedValue({
      id: "rv1", weekStart: "2026-10-26", weekEnd: "2026-11-01", headline: "Questions win", summary: "s", working: "w", notWorking: "n", why: "y",
      tryNext: "- Open with a question", fromPeers: null, ideasTried: null, plan: [{ day: "Mon", format: "reel", idea: "Question opener", keyword: null }], author: "claude", requestedBy: "Matt", createdAt: NOW,
    });
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.previousReview).toMatchObject({ weekStart: "2026-10-26", headline: "Questions win", tryNext: "- Open with a question", plan: [{ day: "Mon", idea: "Question opener" }] });
  });
});

describe("social_review_save", () => {
  const review = {
    weekStart: "2026-11-02", weekEnd: "2026-11-08", headline: "Your bold openers are working",
    summary: "s", working: "w", notWorking: "n", why: "y", tryNext: "- t",
  };

  it("saves the review as Claude's, for the signed-in person, and says where to read it", async () => {
    vi.mocked(reviewQueries.saveReview).mockImplementation(async (_db, r) => ({ ...r, id: "rv2", createdAt: NOW, requestedBy: r.requestedBy ?? null, fromPeers: r.fromPeers ?? null, ideasTried: r.ideasTried ?? null, plan: r.plan ?? null }));
    const r = (await dispatchTool(ctx, "social_review_save", review)) as Record<string, any>;
    expect(vi.mocked(reviewQueries.saveReview).mock.calls[0][1]).toMatchObject({ weekStart: "2026-11-02", author: "claude", requestedBy: "Matt" });
    expect(r).toMatchObject({ written: true, id: "rv2", path: "/social/review/rv2" });
  });

  it("refuses an empty section", async () => {
    await expect(dispatchTool(ctx, "social_review_save", { ...review, why: "   " })).rejects.toBeInstanceOf(McpArgumentError);
    expect(reviewQueries.saveReview).not.toHaveBeenCalled();
  });

  it("refuses a week that ends before it starts", async () => {
    await expect(dispatchTool(ctx, "social_review_save", { ...review, weekEnd: "2026-11-01" })).rejects.toThrow(/weekEnd/);
  });
});

describe("peer accounts", () => {
  it("puts each tracked account's week and standouts in the review data", async () => {
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.peers[0]).toMatchObject({ username: "pippipost.shop", notes: "bookish merch", followers: { latest: 250_599 } });
    expect(r.peers[0].standouts[0]).toMatchObject({ id: "pp-hit", verdict: "breakout", hookType: "question" });
  });

  // One bad peer read must not cost the review its own account's numbers.
  it("names a peer section that failed and still returns the rest", async () => {
    vi.mocked(reviewQueries.getPeerPosts).mockRejectedValue(new Error("db down"));
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.peers).toEqual({ error: "db down" });
    expect(r.account.thisWeek.net).toBe(21);
  });

  it("answers what a peer is doing over a chosen span", async () => {
    const r = (await dispatchTool(ctx, "social_peers", { username: "@PippiPost.shop" })) as Record<string, any>;
    expect(r.peers).toHaveLength(1);
    expect(r.peers[0].username).toBe("pippipost.shop");
    expect(r.caveat).toMatch(/likes, comments and reel views/);
  });

  it("says when the account asked about is not tracked", async () => {
    const r = (await dispatchTool(ctx, "social_peers", { username: "someone.else" })) as Record<string, any>;
    expect(r.error).toMatch(/not tracked.*social_peer_set/);
  });

  it("starts tracking an account for the signed-in person", async () => {
    vi.mocked(reviewQueries.setPeer).mockResolvedValue({ username: "bookish.co", purpose: "peer", active: true, notes: "n" });
    const r = (await dispatchTool(ctx, "social_peer_set", { username: "@Bookish.co", notes: "n" })) as Record<string, any>;
    expect(vi.mocked(reviewQueries.setPeer).mock.calls[0][1]).toEqual({ username: "bookish.co", active: true, notes: "n", addedBy: "Matt" });
    expect(r).toMatchObject({ written: true, username: "bookish.co", active: true });
  });

  it("refuses something that is not an Instagram username", async () => {
    await expect(dispatchTool(ctx, "social_peer_set", { username: "bad name)" })).rejects.toBeInstanceOf(McpArgumentError);
  });

  it("saves the optional ideas from peers with the review", async () => {
    vi.mocked(reviewQueries.saveReview).mockImplementation(async (_db, r) => ({ ...r, id: "rv3", createdAt: NOW, requestedBy: r.requestedBy ?? null, fromPeers: r.fromPeers ?? null, ideasTried: r.ideasTried ?? null, plan: r.plan ?? null }));
    await dispatchTool(ctx, "social_review_save", {
      weekStart: "2026-11-02", weekEnd: "2026-11-08", headline: "h", summary: "s", working: "w", notWorking: "n", why: "y", tryNext: "- t",
      fromPeers: "Pippi Post's question reel broke out.",
    });
    expect(vi.mocked(reviewQueries.saveReview).mock.calls[0][1]).toMatchObject({ fromPeers: "Pippi Post's question reel broke out." });
  });
});

describe("what posts show", () => {
  it("gives each post in the week what it shows", async () => {
    vi.mocked(reviewQueries.getReviewPosts).mockResolvedValue([
      reel({ id: "v1", postedAt: daysAgo(4), visual: { basis: "frames", visualType: "illustration", visualHook: "Do you colour?", faceInFirst2s: false, productVisible: true, handDrawn: true, audio: "speech", cutsPerMinute: 24, onScreenText: [{ at: "0s", text: "Do you colour?" }], hasContactSheet: true } }),
    ]);
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.posts[0].visual).toMatchObject({ looked: "frames", visualHook: "Do you colour?", faceInFirst2s: false, audio: "speech", contactSheetPath: "/api/social/sheet/v1" });
  });

  it("says how many posts were looked at, and how", async () => {
    vi.mocked(reviewQueries.getReviewPosts).mockResolvedValue([
      reel({ postedAt: daysAgo(4), visual: { basis: "cover", visualType: "photo", visualHook: null, faceInFirst2s: null, productVisible: null, handDrawn: null, audio: "licensed-music-likely", cutsPerMinute: null } }),
      reel({ postedAt: daysAgo(3), visual: null }),
    ]);
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.coverage).toMatchObject({ postsLookedAt: 1, reelsSeenByCoverOnly: 1 });
    expect(r.coverage.notes.join(" ")).toMatch(/licensed music/);
  });
});

describe("scorecard and targets", () => {
  it("scores the week against the targets set", async () => {
    vi.mocked(reviewQueries.getTargets).mockResolvedValue([{ metric: "reels_per_week", value: 5, targetDate: null, notes: null, setAt: NOW, requestedBy: "Matt" }]);
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.scorecard.find((s: { measure: string }) => s.measure === "reels_per_week")).toMatchObject({ actual: 1, target: 5, status: "behind" });
    expect(r.scorecard.find((s: { measure: string }) => s.measure === "posts_per_week")).toMatchObject({ status: "no-target" });
  });

  it("records a follower target with its date, for the signed-in person", async () => {
    const r = (await dispatchTool(ctx, "social_target_set", { metric: "followers", value: 140_000, targetDate: "2027-06-30" })) as Record<string, any>;
    expect(vi.mocked(reviewQueries.recordTarget).mock.calls[0][1]).toEqual({ metric: "followers", value: 140_000, targetDate: "2027-06-30", notes: null, requestedBy: "Matt" });
    expect(r.written).toBe(true);
  });

  it("refuses a follower target without a date", async () => {
    await expect(dispatchTool(ctx, "social_target_set", { metric: "followers", value: 140_000 })).rejects.toThrow(/targetDate/);
  });

  it("clears a target", async () => {
    await dispatchTool(ctx, "social_target_set", { metric: "posts_per_week", clear: true });
    expect(vi.mocked(reviewQueries.recordTarget).mock.calls[0][1]).toMatchObject({ metric: "posts_per_week", value: null });
  });
});

describe("plan and ideas tried", () => {
  const review = { weekStart: "2026-11-02", weekEnd: "2026-11-08", headline: "h", summary: "s", working: "w", notWorking: "n", why: "y", tryNext: "- t" };

  it("saves the week's plan and last week's ideas as rows", async () => {
    vi.mocked(reviewQueries.saveReview).mockImplementation(async (_db, r) => ({ ...r, id: "rv4", createdAt: NOW, requestedBy: r.requestedBy ?? null, fromPeers: r.fromPeers ?? null, ideasTried: r.ideasTried ?? null, plan: r.plan ?? null }));
    await dispatchTool(ctx, "social_review_save", {
      ...review,
      plan: [{ day: "Mon", format: "reel", idea: "Question opener", keyword: "COLOR" }],
      ideasTried: [{ idea: "Open with a question", tried: "yes", result: "Twice her usual views" }],
    });
    expect(vi.mocked(reviewQueries.saveReview).mock.calls[0][1]).toMatchObject({
      plan: [{ day: "Mon", format: "reel", idea: "Question opener", keyword: "COLOR" }],
      ideasTried: [{ idea: "Open with a question", tried: "yes", result: "Twice her usual views" }],
    });
  });

  it("refuses a plan row with a format that is not one", async () => {
    await expect(dispatchTool(ctx, "social_review_save", { ...review, plan: [{ day: "Mon", format: "tiktok", idea: "x" }] })).rejects.toBeInstanceOf(McpArgumentError);
  });
});

describe("reels Instagram withholds the video of", () => {
  const coverOnly = (id: string, days: number, views: number) => reel({
    id, postedAt: daysAgo(days), views, visualStatus: "cover_only", permalink: `https://www.instagram.com/reel/${id}/`, caption: "Don't recommend hand painting a sign in a rush 😂 an antipodean tradition",
    visual: { basis: "cover", visualType: "photo", visualHook: null, faceInFirst2s: null, productVisible: null, handDrawn: null, audio: "licensed-music-likely", cutsPerMinute: null },
  });

  it("lists cover-only reels from the last 90 days, newest first, with links, so the review can ask for them by name", async () => {
    vi.mocked(reviewQueries.getReviewPosts).mockResolvedValue([coverOnly("A1", 14, 17_918), coverOnly("B2", 64, 15_625), coverOnly("old", 120, 9_000), reel({ postedAt: daysAgo(3), visualStatus: "analyzed" })]);
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.reelsMissingVisuals).toEqual([
      { id: "A1", postedAt: daysAgo(14).toISOString(), permalink: "https://www.instagram.com/reel/A1/", caption: "Don't recommend hand painting a sign in a rush 😂 an antipodean tradition", views: 17_918 },
      { id: "B2", postedAt: daysAgo(64).toISOString(), permalink: "https://www.instagram.com/reel/B2/", caption: expect.any(String), views: 15_625 },
    ]);
    expect(r.uploadPage).toBe("/social/uploads");
    expect(r.coverage.coverOnlyReelsExcluded).toBe(2);
  });

  it("gives each post its visual status, and an upload's source", async () => {
    vi.mocked(reviewQueries.getReviewPosts).mockResolvedValue([
      reel({ id: "u1", postedAt: daysAgo(4), visualStatus: "analyzed", visual: { basis: "frames", visualType: "person", visualHook: "Don't do this", faceInFirst2s: true, productVisible: false, handDrawn: true, audio: "licensed-music-likely", cutsPerMinute: 30, source: "manual_upload", songUsed: "Espresso", audioNote: "Sound measured from the uploaded file" } }),
    ]);
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.posts[0]).toMatchObject({ visualStatus: "analyzed", visual: { source: "manual_upload", songUsed: "Espresso", audioNote: expect.stringMatching(/uploaded file/) } });
  });
});

describe("teacher accounts", () => {
  const teacher = { username: "lana.k.social", purpose: "teacher" as const, notes: "IG growth advice", active: true };
  const lessonRow = (o: Record<string, unknown> = {}) => ({
    postId: "t1", username: "lana.k.social", permalink: "https://instagram.com/p/t1", postedAt: daysAgo(3), basis: "caption+slides",
    area: "hook" as const, principle: "Open with the result.", howToApply: "Show the finished page at 0s.", kind: "practice" as const, quote: null, ...o,
  });

  beforeEach(() => {
    vi.mocked(reviewQueries.getPeers).mockResolvedValue([{ username: "pippipost.shop", purpose: "peer", notes: "bookish merch", active: true }, teacher]);
    vi.mocked(reviewQueries.getLessons).mockResolvedValue([lessonRow(), lessonRow({ postId: "t2", area: "engagement", principle: "Reply to every comment in the first hour.", kind: "claim" })]);
    vi.mocked(reviewQueries.getLessonCoverage).mockResolvedValue([{ username: "lana.k.social", posts: 50, read: 20, withLessons: 14 }]);
    vi.mocked(reviewQueries.getPeerPosts).mockResolvedValue([
      { id: "tr1", username: "lana.k.social", purpose: "teacher", caption: "My hook formula", format: "reel", permalink: "https://instagram.com/reel/tr1", thumbnailUrl: null, postedAt: daysAgo(2), likeCount: 1, commentsCount: 1, viewCount: 5000, analysis: null },
      { id: "pp1", username: "pippipost.shop", purpose: "peer", caption: "c", format: "reel", permalink: null, thumbnailUrl: null, postedAt: daysAgo(2), likeCount: 1, commentsCount: 1, viewCount: 9000, analysis: null },
    ]);
  });

  it("starts following an account as a teacher", async () => {
    vi.mocked(reviewQueries.setPeer).mockResolvedValue(teacher);
    const r = (await dispatchTool(ctx, "social_peer_set", { username: "@lana.k.social", role: "teacher" })) as Record<string, any>;
    expect(vi.mocked(reviewQueries.setPeer).mock.calls[0][1]).toMatchObject({ username: "lana.k.social", purpose: "teacher" });
    expect(r.note).toMatch(/lessons/);
    expect(r.role).toBe("teacher");
  });

  it("lists every tracked account with its role", async () => {
    const r = (await dispatchTool(ctx, "social_peers", {})) as Record<string, any>;
    expect(r.accounts).toEqual([
      { username: "pippipost.shop", role: "peer", notes: "bookish merch" },
      { username: "lana.k.social", role: "teacher", notes: "IG growth advice" },
    ]);
  });

  it("refuses a purpose that is neither peer nor teacher", async () => {
    await expect(dispatchTool(ctx, "social_peer_set", { username: "lana.k.social", role: "mentor" })).rejects.toBeInstanceOf(McpArgumentError);
  });

  // A teacher is not a benchmark: it stays out of the peer comparisons.
  it("keeps teachers out of the peer sections", async () => {
    const peers = (await dispatchTool(ctx, "social_peers", {})) as Record<string, any>;
    expect(peers.peers.map((p: any) => p.username)).toEqual(["pippipost.shop"]);
    const review = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(review.peers.map((p: any) => p.username)).toEqual(["pippipost.shop"]);
    expect(review.teachers).toEqual({ accounts: ["lana.k.social"], tool: "social_playbook" });
  });

  it("gives the lessons by area, with their sources and kinds", async () => {
    const r = (await dispatchTool(ctx, "social_playbook", {})) as Record<string, any>;
    expect(r.areas.map((a: any) => a.area)).toEqual(["hook", "engagement"]);
    expect(r.areas[0].lessons[0]).toMatchObject({ principle: "Open with the result.", kind: "practice", sources: [{ permalink: "https://instagram.com/p/t1", basis: "caption+slides" }] });
    expect(r.areas[1].lessons[0].kind).toBe("claim");
    expect(r.lessonsMatched).toBe(2);
    expect(r.caveat).toMatch(/claim/);
  });

  it("says how much of each teacher has been read, and which reels need uploading", async () => {
    const r = (await dispatchTool(ctx, "social_playbook", {})) as Record<string, any>;
    expect(r.teachers).toEqual([expect.objectContaining({
      username: "lana.k.social", notes: "IG growth advice", posts: 50, read: 20, withLessons: 14,
      reelsAwaitingUpload: [expect.objectContaining({ id: "tr1", permalink: "https://instagram.com/reel/tr1" })],
    })]);
    expect(r.uploadPage).toBe("/social/uploads");
  });

  // Advice is checked against her own numbers before it is recommended.
  it("carries Tara's own patterns to test the lessons against", async () => {
    const r = (await dispatchTool(ctx, "social_playbook", {})) as Record<string, any>;
    expect(Array.isArray(r.taraEvidence.patterns)).toBe(true);
    expect(r.taraEvidence.usual).toBeDefined();
  });

  it("narrows to one teacher and one area", async () => {
    await dispatchTool(ctx, "social_playbook", { username: "@Lana.K.Social", area: "hook" });
    expect(vi.mocked(reviewQueries.getLessons).mock.calls[0][1]).toMatchObject({ username: "lana.k.social", area: "hook" });
  });

  it("refuses an account that is not a teacher", async () => {
    const r = (await dispatchTool(ctx, "social_playbook", { username: "pippipost.shop" })) as Record<string, any>;
    expect(r.error).toMatch(/not a teacher.*social_peer_set/);
  });
});

describe("social_review — reel sources and downloads", () => {
  it("gives each post's source and the last 7 days' automatic downloads", async () => {
    vi.mocked(reviewQueries.getReviewPosts).mockResolvedValue([
      reel({ id: "dl", postedAt: daysAgo(5), visualStatus: "analyzed", visual: { basis: "frames", visualType: "person", visualHook: null, faceInFirst2s: true, productVisible: false, handDrawn: false, audio: "speech", cutsPerMinute: 12, source: "api_backfill" } } as never),
    ]);
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.posts[0]).toMatchObject({ id: "dl", visualStatus: "analyzed", source: "api_backfill" });
    expect(r.backfill).toEqual({ last7Days: { ok: 4, failed: 1, rateLimited: 0 } });
    expect(r).toHaveProperty("reelsMissingVisuals");
  });
});

describe("teacher_advice", () => {
  const row = (o: Record<string, unknown> = {}) => ({
    postId: "t1", username: "lana.k.social", permalink: "https://instagram.com/reel/t1/", postedAt: daysAgo(3), format: "reel",
    transcript: "Stop opening with hi. Lead with the payoff.", openingWords: "Stop opening with hi.",
    faceInFirst2s: 1, cutsPerMinute: 18, audio: "speech", source: "api_backfill",
    area: "hook", principle: "Open with the payoff.", howToApply: "Show the finished page first.", kind: "practice", quote: "Lead with the payoff", ...o,
  });

  beforeEach(() => {
    vi.mocked(reviewQueries.getTeacherAdvice).mockResolvedValue([row(), row({ principle: "Reply to comments in the first hour.", area: "engagement", kind: "claim", quote: null })]);
  });

  it("gives each reel's advice with what the reel was and said", async () => {
    const r = (await dispatchTool(ctx, "teacher_advice", {})) as Record<string, any>;
    expect(r.reels).toEqual([expect.objectContaining({
      postId: "t1", username: "lana.k.social", permalink: "https://instagram.com/reel/t1/", source: "api_backfill",
      faceInFirst2s: true, cutsPerMinute: 18, audio: "speech", openingWords: "Stop opening with hi.", transcript: "Stop opening with hi. Lead with the payoff.",
      advice: [
        { tip: "Open with the payoff.", quote: "Lead with the payoff", area: "hook", kind: "practice", howToApply: "Show the finished page first." },
        { tip: "Reply to comments in the first hour.", quote: null, area: "engagement", kind: "claim", howToApply: "Show the finished page first." },
      ],
    })]);
    expect(r.adviceMatched).toBe(2);
    expect(r.caveat).toMatch(/social_review/);
  });

  it("searches by words, account, area and kind", async () => {
    await dispatchTool(ctx, "teacher_advice", { query: "hook", username: "@Lana.K.Social", area: "hook", kind: "practice" });
    expect(vi.mocked(reviewQueries.getTeacherAdvice).mock.calls[0][1]).toMatchObject({ query: "hook", username: "lana.k.social", area: "hook", kind: "practice" });
  });

  it("refuses an unknown kind", async () => {
    await expect(dispatchTool(ctx, "teacher_advice", { kind: "rumour" })).rejects.toBeInstanceOf(McpArgumentError);
  });
});
