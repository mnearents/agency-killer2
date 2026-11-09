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
      tryNext: "- Open with a question", author: "claude", requestedBy: "Matt", createdAt: NOW,
    });
    const r = (await dispatchTool(ctx, "social_review", {})) as Record<string, any>;
    expect(r.previousReview).toMatchObject({ weekStart: "2026-10-26", headline: "Questions win", tryNext: "- Open with a question" });
  });
});

describe("social_review_save", () => {
  const review = {
    weekStart: "2026-11-02", weekEnd: "2026-11-08", headline: "Your bold openers are working",
    summary: "s", working: "w", notWorking: "n", why: "y", tryNext: "- t",
  };

  it("saves the review as Claude's, for the signed-in person, and says where to read it", async () => {
    vi.mocked(reviewQueries.saveReview).mockImplementation(async (_db, r) => ({ ...r, id: "rv2", createdAt: NOW, requestedBy: r.requestedBy ?? null }));
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
