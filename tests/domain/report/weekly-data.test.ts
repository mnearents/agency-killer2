import { describe, it, expect } from "vitest";
import {
  computeWeekRange,
  formatAdsSummary,
  formatShopifySummary,
  formatSocialSummary,
  formatWeeklyDataBlock,
  type AdsWeekData,
  type ShopifyWeekData,
  type SocialWeekData,
} from "@/domain/report/weekly-data";

describe("computeWeekRange", () => {
  it("returns Monday-Sunday of the previous week given a Monday", () => {
    // Monday Aug 4 2025 → previous week is Jul 28 (Mon) to Aug 3 (Sun)
    const now = new Date("2025-08-04T14:00:00Z");
    const range = computeWeekRange(now);
    expect(range.start).toBe("2025-07-28");
    expect(range.end).toBe("2025-08-03");
    expect(range.label).toBe("Jul 28 – Aug 3");
  });

  it("handles week spanning month boundary", () => {
    const now = new Date("2025-07-07T14:00:00Z"); // Monday
    const range = computeWeekRange(now);
    expect(range.start).toBe("2025-06-30");
    expect(range.end).toBe("2025-07-06");
  });

  it("handles mid-week date by still returning previous full week", () => {
    // Wednesday Aug 6 → previous week is still Jul 28 – Aug 3
    const now = new Date("2025-08-06T14:00:00Z");
    const range = computeWeekRange(now);
    expect(range.start).toBe("2025-07-28");
    expect(range.end).toBe("2025-08-03");
  });
});

describe("formatAdsSummary", () => {
  it("formats ads data with key metrics", () => {
    const data: AdsWeekData = {
      totalSpendDollars: 450.25,
      totalRevenueDollars: 1350.80,
      roas: 3.0,
      totalImpressions: 125000,
      totalClicks: 2500,
      ctr: 2.0,
      totalPurchases: 45,
      costPerPurchaseDollars: 10.01,
      topCreatives: [
        { name: "Summer Planner UGC", roas: 4.5, spendDollars: 120, revenueDollars: 540 },
        { name: "Doodle Kit Static", roas: 2.1, spendDollars: 80, revenueDollars: 168 },
      ],
    };

    const block = formatAdsSummary(data);

    expect(block).toContain("$450.25");
    expect(block).toContain("$1,350.80");
    expect(block).toContain("3.00x");
    expect(block).toContain("Summer Planner UGC");
    expect(block).toContain("4.50x");
  });

  it("handles zero spend gracefully", () => {
    const data: AdsWeekData = {
      totalSpendDollars: 0,
      totalRevenueDollars: 0,
      roas: null,
      totalImpressions: 0,
      totalClicks: 0,
      ctr: null,
      totalPurchases: 0,
      costPerPurchaseDollars: null,
      topCreatives: [],
    };

    const block = formatAdsSummary(data);
    expect(block).toContain("No ad spend");
  });
});

describe("formatShopifySummary", () => {
  it("formats Shopify data with revenue and subscription breakdown", () => {
    const data: ShopifyWeekData = {
      totalOrders: 120,
      totalRevenueDollars: 3200.50,
      subscriptionOrders: 85,
      subscriptionRevenueDollars: 680.00,
      avgOrderValueDollars: 26.67,
      topProducts: [
        { title: "Really Awesome Doodles Tier 1", count: 40 },
        { title: "Planner Refill Pack", count: 25 },
      ],
    };

    const block = formatShopifySummary(data);

    expect(block).toContain("120");
    expect(block).toContain("$3,200.50");
    expect(block).toContain("85 subscriptions");
    expect(block).toContain("Really Awesome Doodles");
  });
});

describe("formatSocialSummary", () => {
  it("formats social data with engagement highlights", () => {
    const data: SocialWeekData = {
      postsPublished: 8,
      totalReach: 45000,
      avgEngagementRate: 7.2,
      totalSaves: 320,
      totalShares: 85,
      topPost: {
        caption: "New planner reveal! 🎨",
        engagementRate: 12.5,
        saves: 95,
        format: "Reel",
        permalink: "https://instagram.com/p/abc",
      },
      reelPlays: 28000,
    };

    const block = formatSocialSummary(data);

    expect(block).toContain("8 posts");
    expect(block).toContain("45,000");
    expect(block).toContain("7.20%");
    expect(block).toContain("New planner reveal");
    expect(block).toContain("12.50%");
  });

  it("handles no posts", () => {
    const data: SocialWeekData = {
      postsPublished: 0,
      totalReach: 0,
      avgEngagementRate: null,
      totalSaves: 0,
      totalShares: 0,
      topPost: null,
      reelPlays: 0,
    };

    const block = formatSocialSummary(data);
    expect(block).toContain("No posts");
  });
});

describe("formatWeeklyDataBlock", () => {
  it("combines all channel summaries into one prompt block", () => {
    const block = formatWeeklyDataBlock({
      weekRange: { start: "2025-07-28", end: "2025-08-03", label: "Jul 28 – Aug 3" },
      ads: {
        totalSpendDollars: 450, totalRevenueDollars: 1350, roas: 3.0,
        totalImpressions: 125000, totalClicks: 2500, ctr: 2.0,
        totalPurchases: 45, costPerPurchaseDollars: 10.0, topCreatives: [],
      },
      shopify: {
        totalOrders: 120, totalRevenueDollars: 3200,
        subscriptionOrders: 85, subscriptionRevenueDollars: 680,
        avgOrderValueDollars: 26.67, topProducts: [],
      },
      social: {
        postsPublished: 8, totalReach: 45000, avgEngagementRate: 7.2,
        totalSaves: 320, totalShares: 85, topPost: null, reelPlays: 28000,
      },
    });

    expect(block).toContain("Jul 28 – Aug 3");
    expect(block).toContain("## Meta Ads");
    expect(block).toContain("## Shopify");
    expect(block).toContain("## Organic Social");
  });
});
