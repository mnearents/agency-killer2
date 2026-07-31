import { describe, it, expect } from "vitest";
import {
  computePostMetrics,
  rankPosts,
  computeFormatBreakdown,
  type PostRow,
} from "@/domain/social/metrics";

function makePost(overrides: Partial<PostRow> = {}): PostRow {
  return {
    likeCount: 100,
    commentsCount: 10,
    saved: 25,
    shares: 5,
    impressions: 5000,
    reach: 3000,
    plays: 0,
    mediaType: "IMAGE",
    mediaProductType: "FEED",
    ...overrides,
  };
}

describe("computePostMetrics", () => {
  it("computes engagement rate as (likes + comments + saves + shares) / reach * 100", () => {
    const post = makePost({ likeCount: 100, commentsCount: 10, saved: 25, shares: 5, reach: 2000 });
    const metrics = computePostMetrics(post);

    // (100 + 10 + 25 + 5) / 2000 * 100 = 7.0%
    expect(metrics.engagementRate).toBeCloseTo(7.0);
  });

  it("computes save rate as saves / reach * 100", () => {
    const post = makePost({ saved: 50, reach: 1000 });
    const metrics = computePostMetrics(post);

    expect(metrics.saveRate).toBeCloseTo(5.0);
  });

  it("computes share rate as shares / reach * 100", () => {
    const post = makePost({ shares: 20, reach: 1000 });
    const metrics = computePostMetrics(post);

    expect(metrics.shareRate).toBeCloseTo(2.0);
  });

  it("returns null rates when reach is 0", () => {
    const post = makePost({ reach: 0 });
    const metrics = computePostMetrics(post);

    expect(metrics.engagementRate).toBeNull();
    expect(metrics.saveRate).toBeNull();
    expect(metrics.shareRate).toBeNull();
  });

  it("computes reach rate as reach / impressions * 100", () => {
    const post = makePost({ reach: 3000, impressions: 5000 });
    const metrics = computePostMetrics(post);

    expect(metrics.reachRate).toBeCloseTo(60.0);
  });

  it("returns null reach rate when impressions is 0", () => {
    const post = makePost({ impressions: 0 });
    const metrics = computePostMetrics(post);

    expect(metrics.reachRate).toBeNull();
  });

  it("identifies post as reel when mediaProductType is REELS", () => {
    const post = makePost({ mediaProductType: "REELS", mediaType: "VIDEO", plays: 10000 });
    const metrics = computePostMetrics(post);

    expect(metrics.isReel).toBe(true);
    expect(metrics.plays).toBe(10000);
  });

  it("identifies post as reel when mediaType is VIDEO (legacy)", () => {
    const post = makePost({ mediaProductType: "FEED", mediaType: "VIDEO", plays: 5000 });
    const metrics = computePostMetrics(post);

    // VIDEO on FEED is still a video post, not a reel
    expect(metrics.isReel).toBe(false);
  });
});

describe("rankPosts", () => {
  it("ranks posts by engagement rate descending", () => {
    const posts: PostRow[] = [
      makePost({ likeCount: 10, commentsCount: 0, saved: 0, shares: 0, reach: 1000 }), // 1%
      makePost({ likeCount: 100, commentsCount: 50, saved: 30, shares: 20, reach: 1000 }), // 20%
      makePost({ likeCount: 50, commentsCount: 10, saved: 10, shares: 5, reach: 1000 }), // 7.5%
    ];

    const ranked = rankPosts(posts, "engagementRate");

    expect(ranked[0].engagementRate).toBeCloseTo(20.0);
    expect(ranked[1].engagementRate).toBeCloseTo(7.5);
    expect(ranked[2].engagementRate).toBeCloseTo(1.0);
  });

  it("ranks posts by save rate descending", () => {
    const posts: PostRow[] = [
      makePost({ saved: 5, reach: 1000 }),  // 0.5%
      makePost({ saved: 80, reach: 1000 }), // 8%
      makePost({ saved: 30, reach: 1000 }), // 3%
    ];

    const ranked = rankPosts(posts, "saveRate");

    expect(ranked[0].saveRate).toBeCloseTo(8.0);
    expect(ranked[1].saveRate).toBeCloseTo(3.0);
    expect(ranked[2].saveRate).toBeCloseTo(0.5);
  });

  it("puts null-rate posts at the end", () => {
    const posts: PostRow[] = [
      makePost({ reach: 0 }), // null engagement rate
      makePost({ likeCount: 50, commentsCount: 5, saved: 10, shares: 5, reach: 1000 }), // 7%
    ];

    const ranked = rankPosts(posts, "engagementRate");

    expect(ranked[0].engagementRate).toBeCloseTo(7.0);
    expect(ranked[1].engagementRate).toBeNull();
  });
});

describe("computeFormatBreakdown", () => {
  it("groups posts by format and computes average metrics", () => {
    const posts: PostRow[] = [
      makePost({ mediaType: "IMAGE", mediaProductType: "FEED", likeCount: 100, commentsCount: 10, saved: 20, shares: 5, reach: 2000 }),
      makePost({ mediaType: "IMAGE", mediaProductType: "FEED", likeCount: 200, commentsCount: 20, saved: 40, shares: 10, reach: 4000 }),
      makePost({ mediaType: "VIDEO", mediaProductType: "REELS", likeCount: 500, commentsCount: 50, saved: 100, shares: 30, reach: 10000, plays: 15000 }),
    ];

    const breakdown = computeFormatBreakdown(posts);

    expect(breakdown).toHaveLength(2);

    const images = breakdown.find((b) => b.format === "Image");
    expect(images).toBeDefined();
    expect(images!.count).toBe(2);
    // avg engagement rate: ((135/2000)*100 + (270/4000)*100) / 2 = (6.75 + 6.75) / 2 = 6.75
    expect(images!.avgEngagementRate).toBeCloseTo(6.75);

    const reels = breakdown.find((b) => b.format === "Reel");
    expect(reels).toBeDefined();
    expect(reels!.count).toBe(1);
    expect(reels!.avgPlays).toBe(15000);
  });

  it("returns empty array for no posts", () => {
    expect(computeFormatBreakdown([])).toEqual([]);
  });

  it("labels CAROUSEL_ALBUM as Carousel", () => {
    const posts: PostRow[] = [
      makePost({ mediaType: "CAROUSEL_ALBUM", mediaProductType: "FEED", reach: 1000 }),
    ];

    const breakdown = computeFormatBreakdown(posts);
    expect(breakdown[0].format).toBe("Carousel");
  });
});
