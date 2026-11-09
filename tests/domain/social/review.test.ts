import { describe, it, expect } from "vitest";
import {
  formatGroup,
  buildBaselines,
  scorePost,
  findPatterns,
  summariseAccountDays,
  lengthBucket,
  openingWords,
  accountDaysToFetch,
  SETTLE_HOURS,
  type ReviewPost,
} from "@/domain/social/review";

const NOW = new Date("2026-11-09T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

let n = 0;
function reel(overrides: Partial<ReviewPost> = {}): ReviewPost {
  n++;
  return {
    id: `r${n}`, caption: "c", permalink: null, thumbnailUrl: null, format: "reel", postedAt: daysAgo(10),
    views: 1000, reach: 800, likes: 40, comments: 4, saved: 4, shares: 2, reposts: 0, follows: null, profileVisits: null,
    avgWatchTimeMs: 5000, durationMs: 20_000, insightsStatus: "ok", openingWords: null, analysis: null,
    ...overrides,
  };
}

describe("formatGroup", () => {
  it("separates reels from feed videos, which share media_type VIDEO", () => {
    expect(formatGroup("VIDEO", "REELS")).toBe("reel");
    expect(formatGroup("VIDEO", "FEED")).toBe("video");
    expect(formatGroup("CAROUSEL_ALBUM", "FEED")).toBe("carousel");
    expect(formatGroup("IMAGE", "STORY")).toBe("story");
    expect(formatGroup("IMAGE", null)).toBe("image");
  });
});

describe("buildBaselines", () => {
  it("takes each format's median over settled, measured posts", () => {
    const posts = [reel({ views: 100 }), reel({ views: 200 }), reel({ views: 300 }), reel({ views: 400 }), reel({ views: 500 })];
    const b = buildBaselines(posts, NOW).get("reel")!;
    expect(b.views).toEqual({ median: 300, n: 5 });
  });

  // A reel posted this morning has a fraction of the views it will have; in
  // the baseline it would drag "usual" down and flatter everything after it.
  it("leaves out posts still settling", () => {
    const posts = [reel({ views: 100 }), reel({ views: 5, postedAt: new Date(NOW.getTime() - (SETTLE_HOURS - 1) * 3_600_000) })];
    expect(buildBaselines(posts, NOW).get("reel")!.views.n).toBe(1);
  });

  // Views were never requested before 2026-11-09: null is unmeasured, and
  // counting it as zero would make the usual reel look like a flop.
  it("leaves out posts whose measure was never taken", () => {
    const posts = [reel({ views: 100 }), reel({ views: null })];
    expect(buildBaselines(posts, NOW).get("reel")!.views.n).toBe(1);
  });

  // Shares were never requested either: an old post's 0 is unmeasured, and
  // in the baseline it would halve her usual share rate.
  it("keeps the share rate of posts synced before shares were requested out of the baseline", () => {
    const posts = [reel({ shares: 8, reach: 800 }), reel({ views: null, shares: 0, reach: 800 })];
    expect(buildBaselines(posts, NOW).get("reel")!.shareRate).toEqual({ median: 0.01, n: 1 });
  });

  it("leaves out a failed post even when it holds a reach", () => {
    const posts = [reel({ views: 100 }), reel({ views: 50, reach: 40, insightsStatus: "failed" })];
    expect(buildBaselines(posts, NOW).get("reel")!.reach.n).toBe(1);
  });

  it("leaves out posts whose insights failed", () => {
    const posts = [reel({ views: 100 }), reel({ views: 0, reach: 0, insightsStatus: "failed" })];
    expect(buildBaselines(posts, NOW).get("reel")!.reach.n).toBe(1);
  });

  it("reads watch-through as average watch time over length", () => {
    const b = buildBaselines([reel({ avgWatchTimeMs: 5000, durationMs: 20_000 })], NOW).get("reel")!;
    expect(b.watchThrough.median).toBeCloseTo(0.25);
  });
});

describe("scorePost", () => {
  const usual = buildBaselines(Array.from({ length: 6 }, () => reel({ views: 1000, shares: 2, reach: 800 })), NOW);

  it("calls a reel at three times her usual views a breakout", () => {
    const s = scorePost(reel({ views: 3000 }), usual, NOW);
    expect(s.vsUsual.views).toBe(3);
    expect(s.verdict).toBe("breakout");
  });

  it("calls a reel at half her usual views below", () => {
    expect(scorePost(reel({ views: 500 }), usual, NOW).verdict).toBe("below");
  });

  it("calls a reel near her usual typical", () => {
    expect(scorePost(reel({ views: 1100 }), usual, NOW).verdict).toBe("typical");
  });

  it("does not judge a post that is still settling", () => {
    const s = scorePost(reel({ views: 50, postedAt: daysAgo(1) }), usual, NOW);
    expect(s.settled).toBe(false);
    expect(s.verdict).toBe("settling");
  });

  // Five posts is the least that says what "usual" is.
  it("says there is not enough history rather than comparing with two posts", () => {
    const thin = buildBaselines([reel(), reel()], NOW);
    expect(scorePost(reel({ views: 5000 }), thin, NOW).verdict).toBe("not-enough-history");
  });

  it("says a post with no measurement is not measured", () => {
    expect(scorePost(reel({ views: null, reach: 0, insightsStatus: "failed" }), usual, NOW).verdict).toBe("not-measured");
  });
});

describe("findPatterns", () => {
  const usual = Array.from({ length: 6 }, () => reel({ views: 1000 }));
  const q = (views: number) => reel({ views, analysis: { hookType: "question", approach: "teach", audience: "homeschool parents", topic: "planning" } });
  const s = (views: number) => reel({ views, analysis: { hookType: "story", approach: "relate", audience: "homeschool parents", topic: "planning" } });

  it("ranks hook types by how their posts did against her usual", () => {
    const posts = [...usual, q(3000), q(2500), q(2000), s(500), s(600), s(400)];
    const p = findPatterns(posts, buildBaselines(posts, NOW), NOW).filter((g) => g.dimension === "hookType");
    expect(p.map((g) => g.value)).toEqual(["question", "story"]);
    expect(p[0]).toMatchObject({ posts: 3, medianViewsVsUsual: 2.5 });
  });

  // Two posts are an anecdote; reported as a pattern they steer a week of work.
  it("leaves out a group of fewer than three posts", () => {
    const posts = [...usual, q(3000), q(2500), s(500), s(600), s(400)];
    const p = findPatterns(posts, buildBaselines(posts, NOW), NOW).filter((g) => g.dimension === "hookType");
    expect(p.map((g) => g.value)).toEqual(["story"]);
  });
});

describe("lengthBucket", () => {
  it.each([[9000, "under 15s"], [15_000, "15-30s"], [45_000, "30-60s"], [90_000, "over 60s"], [null, null]])("%s → %s", (ms, bucket) => {
    expect(lengthBucket(ms as number | null)).toBe(bucket);
  });
});

describe("openingWords", () => {
  it("keeps the words spoken in the first three seconds", () => {
    const words = [
      { text: "Stop", start: 100, end: 400, confidence: 0.9 },
      { text: "buying", start: 450, end: 800, confidence: 0.9 },
      { text: "planners.", start: 850, end: 1400, confidence: 0.9 },
      { text: "Here's", start: 3100, end: 3500, confidence: 0.9 },
    ];
    expect(openingWords(words)).toBe("Stop buying planners.");
  });

  it("is null when nothing is said in the first three seconds", () => {
    expect(openingWords([{ text: "late", start: 4000, end: 4500, confidence: 1 }])).toBeNull();
    expect(openingWords(undefined)).toBeNull();
  });
});

describe("summariseAccountDays", () => {
  const day = (d: string, o: Record<string, number | null> = {}) => ({
    day: d, followersCount: null, follows: 10, unfollows: 8, reach: 1000, reachFollowers: 600, reachNonFollowers: 400,
    views: 5000, viewsReel: 500, viewsPost: 1000, viewsCarousel: 500, viewsStory: 2500, viewsAd: 500, profileViews: 100, accountsEngaged: 50,
    insightsFetchedAt: new Date(), ...o,
  });

  it("totals follows and unfollows into net growth and the share of reach that was new people", () => {
    const s = summariseAccountDays([day("2026-11-02"), day("2026-11-03", { follows: 20, unfollows: 5 })], "2026-11-02", "2026-11-08");
    expect(s).toMatchObject({ follows: 30, unfollows: 13, net: 17, daysMeasured: 2, daysInRange: 7 });
    expect(s.nonFollowerReachShare).toBeCloseTo(0.4);
    expect(s.organicViews).toBe(9000); // ads excluded
  });

  // Ads show the account's own posts; counted as organic they flatter it.
  it("keeps ad views apart from organic views", () => {
    expect(summariseAccountDays([day("2026-11-02")], "2026-11-02", "2026-11-02").viewsBySurface.ad).toBe(500);
  });

  it("reads the follower change from the first and last counts held", () => {
    const s = summariseAccountDays([day("2026-11-02", { followersCount: 128_000 }), day("2026-11-08", { followersCount: 128_240 })], "2026-11-02", "2026-11-08");
    expect(s.followers).toEqual({ first: 128_000, firstOn: "2026-11-02", last: 128_240, lastOn: "2026-11-08", change: 240 });
  });

  // No days is unknown, not a week nobody followed.
  it("reports a range with no measured days as null totals", () => {
    const s = summariseAccountDays([], "2026-11-02", "2026-11-08");
    expect(s).toMatchObject({ follows: null, unfollows: null, net: null, daysMeasured: 0 });
  });
});

describe("accountDaysToFetch", () => {
  // Instagram revises recent days, so the last three are read again.
  it("re-reads the last three complete days and fills any gap in the last four weeks", () => {
    const held = new Set(["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    const days = accountDaysToFetch(held, "2026-11-09", 28);
    expect(days.slice(-3)).toEqual(["2026-11-06", "2026-11-07", "2026-11-08"]);
    expect(days).toContain("2026-10-12");
    expect(days).not.toContain("2026-11-05");
    expect(days).not.toContain("2026-11-09"); // today is not over
  });
});
