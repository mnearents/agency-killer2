import { describe, it, expect, vi, afterEach } from "vitest";
import { createInstagramApiClient, describeInstagramError, insightMetricsFor, parseAccountDay, parseInsightsResponse, type IgMediaInsight } from "@/integrations/instagram-api";

describe("parseInsightsResponse", () => {
  it("extracts all metrics from a reel response", () => {
    const data: IgMediaInsight[] = [
      { name: "views", period: "lifetime", values: [{ value: 5000 }] },
      { name: "reach", period: "lifetime", values: [{ value: 3200 }] },
      { name: "saved", period: "lifetime", values: [{ value: 150 }] },
      { name: "shares", period: "lifetime", values: [{ value: 42 }] },
      { name: "ig_reels_avg_watch_time", period: "lifetime", values: [{ value: 12 }] },
      { name: "total_interactions", period: "lifetime", values: [{ value: 620 }] },
    ];

    const result = parseInsightsResponse("media-123", data);

    expect(result).toEqual({
      mediaId: "media-123",
      impressions: 5000,
      reach: 3200,
      saved: 150,
      shares: 42,
      plays: 5000, // views = plays for reels
      totalInteractions: 620,
      views: 5000,
      reposts: null,
      avgWatchTimeMs: 12,
      totalWatchTimeMs: null,
      follows: null,
      profileVisits: null,
    });
  });

  it("defaults missing metrics to 0", () => {
    const data: IgMediaInsight[] = [
      { name: "views", period: "lifetime", values: [{ value: 1000 }] },
      { name: "reach", period: "lifetime", values: [{ value: 800 }] },
    ];

    const result = parseInsightsResponse("media-456", data);

    expect(result.saved).toBe(0);
    expect(result.shares).toBe(0);
    expect(result.plays).toBe(0);
    expect(result.totalInteractions).toBe(0);
  });

  it("handles empty data array", () => {
    const result = parseInsightsResponse("media-789", []);

    expect(result).toEqual({
      mediaId: "media-789",
      impressions: 0,
      reach: 0,
      saved: 0,
      shares: 0,
      plays: 0,
      totalInteractions: 0,
      views: null,
      reposts: null,
      avgWatchTimeMs: null,
      totalWatchTimeMs: null,
      follows: null,
      profileVisits: null,
    });
  });

  it("reads views as plays only when reel metrics present", () => {
    // Reel: has ig_reels_avg_watch_time → views counts as plays
    const reelData: IgMediaInsight[] = [
      { name: "views", period: "lifetime", values: [{ value: 12000 }] },
      { name: "ig_reels_avg_watch_time", period: "lifetime", values: [{ value: 8 }] },
    ];
    const reelResult = parseInsightsResponse("reel-1", reelData);
    expect(reelResult.plays).toBe(12000);

    // Image: no reel metrics → views is impressions only, plays stays 0
    const imageData: IgMediaInsight[] = [
      { name: "views", period: "lifetime", values: [{ value: 5000 }] },
    ];
    const imageResult = parseInsightsResponse("image-1", imageData);
    expect(imageResult.plays).toBe(0);
    expect(imageResult.impressions).toBe(5000);
  });

  it("reads views as impressions, falls back to legacy impressions", () => {
    const data: IgMediaInsight[] = [
      { name: "impressions", period: "lifetime", values: [{ value: 9000 }] },
    ];

    const result = parseInsightsResponse("legacy-1", data);
    expect(result.impressions).toBe(9000);

    const data2: IgMediaInsight[] = [
      { name: "views", period: "lifetime", values: [{ value: 7000 }] },
      { name: "impressions", period: "lifetime", values: [{ value: 9000 }] },
    ];

    const result2 = parseInsightsResponse("both-1", data2);
    expect(result2.impressions).toBe(7000); // views takes priority
  });

  it("handles metrics with empty values array", () => {
    const data: IgMediaInsight[] = [
      { name: "views", period: "lifetime", values: [] },
      { name: "reach", period: "lifetime", values: [{ value: 500 }] },
    ];

    const result = parseInsightsResponse("media-empty", data);

    expect(result.impressions).toBe(0);
    expect(result.reach).toBe(500);
  });
});

describe("describeInstagramError", () => {
  // Synced daily for two weeks as an opaque Graph API error. The cause was a
  // system user with no Page assigned; the message now says so.
  it("names the missing asset assignment for code 100 subcode 33", () => {
    const body = JSON.stringify({ error: { message: "Unsupported get request. Object with ID '17841401840899899' does not exist", code: 100, error_subcode: 33 } });
    expect(describeInstagramError(400, body)).toMatch(/^Instagram API error \(400\): .*Assign the Facebook Page and the Instagram account to the system user/s);
  });

  it("leaves any other error as it was", () => {
    expect(describeInstagramError(500, "boom")).toBe("Instagram API error (500): boom");
  });
});

describe("insight metrics by post type", () => {
  // Probed live 2026-11-09: reels refuse follows and profile_visits, feed
  // posts refuse the watch-time metrics, and one refused metric fails the
  // whole call. So each type asks for exactly what it supports.
  it("asks a reel for views, shares, reposts and watch time, and nothing a reel refuses", () => {
    const metrics = insightMetricsFor("VIDEO", "REELS").split(",");
    expect(metrics).toEqual(expect.arrayContaining(["views", "reach", "shares", "saved", "reposts", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time"]));
    expect(metrics).not.toContain("follows");
    expect(metrics).not.toContain("profile_visits");
  });

  it("asks a feed post for follows and profile visits, and no watch time", () => {
    const metrics = insightMetricsFor("CAROUSEL_ALBUM", "FEED").split(",");
    expect(metrics).toEqual(expect.arrayContaining(["views", "reach", "shares", "saved", "follows", "profile_visits"]));
    expect(metrics.some((m) => m.startsWith("ig_reels_"))).toBe(false);
  });
});

describe("getMediaInsights at its call site", () => {
  afterEach(() => vi.unstubAllGlobals());

  // The bug: the client was handed media_type ("VIDEO") but chose metrics by
  // media_product_type, so every reel was asked the feed set and no reel's
  // shares, views or watch time was ever stored.
  it("requests the reel metrics when told the post is a reel", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    await createInstagramApiClient("t").getMediaInsights("m1", "VIDEO", "REELS");
    expect(new URL(urls[0]).searchParams.get("metric")).toContain("ig_reels_avg_watch_time");
  });
});

describe("parseInsightsResponse — the measures added for the review", () => {
  it("reads views, reposts, watch time, follows and profile visits", () => {
    const r = parseInsightsResponse("m", [
      { name: "views", period: "lifetime", values: [{ value: 2457 }] },
      { name: "reposts", period: "lifetime", values: [{ value: 2 }] },
      { name: "ig_reels_avg_watch_time", period: "lifetime", values: [{ value: 9552 }] },
      { name: "ig_reels_video_view_total_time", period: "lifetime", values: [{ value: 19_315_845 }] },
      { name: "follows", period: "lifetime", values: [{ value: 4 }] },
      { name: "profile_visits", period: "lifetime", values: [{ value: 31 }] },
    ]);
    expect(r).toMatchObject({ views: 2457, reposts: 2, avgWatchTimeMs: 9552, totalWatchTimeMs: 19_315_845, follows: 4, profileVisits: 31 });
  });

  // A reel cannot report follows; recorded as zero it would read as a reel
  // that won nobody over.
  it("leaves a measure Instagram did not return as null, not zero", () => {
    const r = parseInsightsResponse("m", [{ name: "reach", period: "lifetime", values: [{ value: 10 }] }]);
    expect(r).toMatchObject({ views: null, reposts: null, avgWatchTimeMs: null, totalWatchTimeMs: null, follows: null, profileVisits: null });
  });
});

describe("parseAccountDay", () => {
  // Shapes from the live account, 2026-11-07.
  const followsAndReach = [
    { name: "follows_and_unfollows", total_value: { breakdowns: [{ dimension_keys: ["follow_type"], results: [{ dimension_values: ["FOLLOWER"], value: 14 }, { dimension_values: ["NON_FOLLOWER"], value: 11 }] }] } },
    { name: "reach", total_value: { value: 7831, breakdowns: [{ dimension_keys: ["follow_type"], results: [{ dimension_values: ["NON_FOLLOWER"], value: 3045 }, { dimension_values: ["FOLLOWER"], value: 4597 }] }] } },
  ];
  const views = [
    { name: "views", total_value: { value: 16518, breakdowns: [{ dimension_keys: ["media_product_type"], results: [{ dimension_values: ["REEL"], value: 349 }, { dimension_values: ["AD"], value: 2735 }, { dimension_values: ["CAROUSEL_CONTAINER"], value: 526 }, { dimension_values: ["STORY"], value: 9285 }, { dimension_values: ["POST"], value: 3623 }] }] } },
  ];
  const totals = [
    { name: "profile_views", total_value: { value: 112 } },
    { name: "accounts_engaged", total_value: { value: 240 } },
  ];

  // follows_and_unfollows broken down by follow_type: FOLLOWER is accounts
  // that followed, NON_FOLLOWER accounts that unfollowed.
  it("reads follows, unfollows, reach by follower and views by surface", () => {
    expect(parseAccountDay({ followsAndReach, views, totals })).toEqual({
      follows: 14, unfollows: 11,
      reach: 7831, reachFollowers: 4597, reachNonFollowers: 3045,
      views: 16518, viewsReel: 349, viewsPost: 3623, viewsCarousel: 526, viewsStory: 9285, viewsAd: 2735,
      profileViews: 112, accountsEngaged: 240,
    });
  });

  // Instagram returns the breakdown with no results for a day it holds
  // nothing for (seen for 2025): unknown, not a day nobody followed.
  it("reports a day with no breakdown results as unknown", () => {
    const empty = [{ name: "follows_and_unfollows", total_value: { breakdowns: [{ dimension_keys: ["follow_type"] }] } }];
    const r = parseAccountDay({ followsAndReach: empty, views: [], totals: [] });
    expect(r.follows).toBeNull();
    expect(r.unfollows).toBeNull();
    expect(r.views).toBeNull();
  });
});

describe("getPeerAccount", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Shape from @pippipost.shop, 2026-11-09. Instagram shares another
  // account's likes, comments and reel views — never its reach or saves.
  it("reads the profile and recent posts through business discovery", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({
        business_discovery: {
          username: "pippipost.shop", name: "Pippi Post", followers_count: 250_599, media_count: 2544, id: "178",
          media: { data: [
            { id: "m1", caption: "Comment BOOK to win!", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-11-05T18:14:42+0000", permalink: "https://instagram.com/reel/m1", like_count: 205, comments_count: 256, view_count: 40_015, thumbnail_url: "https://cdn/t.jpg" },
            { id: "m2", caption: "New totes", media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-11-05T23:05:59+0000", like_count: 2262, comments_count: 4, media_url: "https://cdn/i.jpg" },
          ] },
        },
      }), { status: 200 });
    }));
    const r = await createInstagramApiClient("t").getPeerAccount("ig1", "pippipost.shop", 50);
    expect(new URL(urls[0]).searchParams.get("fields")).toContain("business_discovery.username(pippipost.shop)");
    expect(r.profile).toEqual({ username: "pippipost.shop", name: "Pippi Post", followersCount: 250_599, mediaCount: 2544 });
    expect(r.media[0]).toMatchObject({ id: "m1", viewCount: 40_015, likeCount: 205, commentsCount: 256, thumbnailUrl: "https://cdn/t.jpg" });
    // An image has no views — unmeasured, not zero.
    expect(r.media[1]).toMatchObject({ viewCount: null, thumbnailUrl: "https://cdn/i.jpg" });
  });

  // Business discovery only sees business and creator accounts.
  it("refuses a username that is not one Instagram will describe", async () => {
    await expect(createInstagramApiClient("t").getPeerAccount("ig1", "bad name)", 50)).rejects.toThrow(/not an Instagram username/);
  });
});
