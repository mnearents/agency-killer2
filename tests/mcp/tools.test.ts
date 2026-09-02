import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpArgumentError } from "@/mcp/args";
import {
  READ_TOOLS,
  dispatchTool,
  toJsonSchema,
  type McpToolContext,
} from "@/mcp/tools";

vi.mock("@/domain/meta/queries", () => ({
  getInsightTotals: vi.fn().mockResolvedValue([]),
  getInsightsByCampaign: vi.fn().mockResolvedValue([]),
  getInsightsByAdCreative: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/domain/shopify/queries", () => ({
  getOrderSummary: vi.fn().mockResolvedValue({
    totalOrders: 0,
    totalRevenueCents: 0,
    subscriptionOrders: 0,
    subscriptionRevenueCents: 0,
  }),
  getDailyOrders: vi.fn().mockResolvedValue([]),
  getTopProducts: vi.fn().mockResolvedValue([]),
  getSubscriptionOrders: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/domain/attentive/queries", () => ({
  getAttentiveWeekSummary: vi.fn().mockResolvedValue({
    emailDelivered: 0, emailClicks: 0, emailConversions: 0, emailRevenueCents: 0, emailUnsubscribes: 0,
    smsDelivered: 0, smsClicks: 0, smsConversions: 0, smsRevenueCents: 0, smsUnsubscribes: 0,
    totalAttributedConversions: 0, totalAttributedRevenueCents: 0,
  }),
}));
vi.mock("@/domain/social/queries", () => ({
  getPostSummary: vi.fn().mockResolvedValue({
    totalPosts: 0, totalReach: 0, totalImpressions: 0, totalEngagements: 0, avgEngagementRate: null,
  }),
  getPostsByDateRange: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/domain/inventory/queries", () => ({
  getInventoryItems: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/domain/calendar/queries", () => ({
  getEntriesByWeek: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/domain/voice/queries", () => ({
  getAllSamples: vi.fn().mockResolvedValue([]),
  getAllRules: vi.fn().mockResolvedValue([]),
  getAllBannedWords: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/domain/alerts/runner", () => ({
  runAlertChecks: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/db/freshness", () => ({
  getDataFreshness: vi.fn().mockResolvedValue([]),
}));

import * as metaQueries from "@/domain/meta/queries";
import * as shopifyQueries from "@/domain/shopify/queries";
import * as socialQueries from "@/domain/social/queries";
import * as inventoryQueries from "@/domain/inventory/queries";
import * as calendarQueries from "@/domain/calendar/queries";
import * as voiceQueries from "@/domain/voice/queries";
import { runAlertChecks } from "@/domain/alerts/runner";
import { getDataFreshness } from "@/db/freshness";

const NOW = new Date("2026-09-02T12:00:00Z");
const ctx: McpToolContext = { db: {} as never, now: () => NOW };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the tool catalogue", () => {
  it("exposes tools under unique names", () => {
    const names = READ_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("describes every tool, since the description is all the model gets", () => {
    for (const tool of READ_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });

  it("marks the whole read surface as read-only", () => {
    expect(READ_TOOLS.every((t) => t.readOnly)).toBe(true);
  });

  it("names tools in the snake_case MCP convention", () => {
    for (const tool of READ_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("toJsonSchema", () => {
  it("produces an object schema even for a tool that takes no arguments", () => {
    expect(toJsonSchema({})).toEqual({ type: "object", properties: {}, required: [] });
  });

  it("lists required arguments", () => {
    const schema = toJsonSchema({ id: { type: "string", required: true } });
    expect(schema.required).toEqual(["id"]);
  });

  it("renders a date argument as a formatted string, not a bare string", () => {
    const schema = toJsonSchema({ startDate: { type: "date" } });
    expect(schema.properties.startDate).toMatchObject({ type: "string", format: "date" });
  });

  it("renders an enum as its allowed values", () => {
    const schema = toJsonSchema({ channel: { type: "enum", values: ["Email", "SMS"] } });
    expect(schema.properties.channel).toMatchObject({ enum: ["Email", "SMS"] });
  });
});

describe("dispatchTool", () => {
  it("rejects a tool that does not exist", async () => {
    await expect(dispatchTool(ctx, "delete_everything", {})).rejects.toThrow(
      /delete_everything/
    );
  });

  it("rejects a bad argument before running any query", async () => {
    await expect(
      dispatchTool(ctx, "ads_performance", { days: "forever" })
    ).rejects.toThrow(McpArgumentError);
    expect(metaQueries.getInsightTotals).not.toHaveBeenCalled();
  });

  it("rejects an argument the tool never declared", async () => {
    await expect(
      dispatchTool(ctx, "ads_performance", { campaignName: "Spring" })
    ).rejects.toThrow(/campaignName/);
    expect(metaQueries.getInsightTotals).not.toHaveBeenCalled();
  });
});

describe("data_freshness", () => {
  it("reports each source so staleness can be checked before analysis", async () => {
    vi.mocked(getDataFreshness).mockResolvedValue([
      { source: "Meta ads", table: "meta_insights", basis: "synced", rows: 10, lastAt: null, ageHours: null, stale: true },
    ]);

    const result = (await dispatchTool(ctx, "data_freshness", {})) as {
      sources: unknown[];
      anyStale: boolean;
    };

    expect(result.sources).toHaveLength(1);
    expect(result.anyStale).toBe(true);
  });
});

describe("ads_performance", () => {
  it("defaults to a trailing 30-day window", async () => {
    await dispatchTool(ctx, "ads_performance", {});
    const [, start, end] = vi.mocked(metaQueries.getInsightTotals).mock.calls[0];
    expect(start.toISOString()).toBe("2026-08-03T12:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-02T12:00:00.000Z");
  });

  it("honours an explicit date range", async () => {
    await dispatchTool(ctx, "ads_performance", {
      startDate: "2026-07-01",
      endDate: "2026-07-31",
    });
    const [, start, end] = vi.mocked(metaQueries.getInsightTotals).mock.calls[0];
    expect(start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });

  it("echoes the window it actually used so the numbers are attributable", async () => {
    const result = (await dispatchTool(ctx, "ads_performance", { days: 7 })) as {
      range: { startDate: string; endDate: string };
    };
    expect(result.range.startDate).toBe("2026-08-26T12:00:00.000Z");
  });

  // A model reading `spendCents: 250000` as "$250,000" is a plausible and
  // expensive misread. Convert at the boundary instead of hoping.
  it("reports money in dollars rather than raw cents", async () => {
    vi.mocked(metaQueries.getInsightTotals).mockResolvedValue([
      {
        spendCents: 250000, impressions: 1000, clicks: 100, reach: 900,
        purchases: 10, purchaseValueCents: 750000, addToCart: 40, initiateCheckout: 20,
      },
    ]);

    const result = (await dispatchTool(ctx, "ads_performance", {})) as {
      totals: { spendDollars: number; revenueDollars: number; roas: number | null };
    };

    expect(result.totals.spendDollars).toBe(2500);
    expect(result.totals.revenueDollars).toBe(7500);
    expect(result.totals.roas).toBe(3);
  });

  it("returns no cents-denominated field anywhere in the payload", async () => {
    vi.mocked(metaQueries.getInsightsByCampaign).mockResolvedValue([
      {
        campaignId: "1",
        campaignName: "Spring",
        rows: [{
          spendCents: 10000, impressions: 100, clicks: 10, reach: 90,
          purchases: 1, purchaseValueCents: 30000, addToCart: 4, initiateCheckout: 2,
        }],
      },
    ]);

    const json = JSON.stringify(await dispatchTool(ctx, "ads_performance", {}));
    expect(json).not.toMatch(/Cents/);
  });

  it("ranks campaigns by spend so the biggest lever is first", async () => {
    const row = (spendCents: number) => ({
      spendCents, impressions: 100, clicks: 10, reach: 90,
      purchases: 1, purchaseValueCents: 0, addToCart: 0, initiateCheckout: 0,
    });
    vi.mocked(metaQueries.getInsightsByCampaign).mockResolvedValue([
      { campaignId: "1", campaignName: "Small", rows: [row(1000)] },
      { campaignId: "2", campaignName: "Big", rows: [row(90000)] },
    ]);

    const result = (await dispatchTool(ctx, "ads_performance", {})) as {
      campaigns: { campaignName: string }[];
    };
    expect(result.campaigns.map((c) => c.campaignName)).toEqual(["Big", "Small"]);
  });
});

describe("store_performance", () => {
  it("converts order revenue to dollars", async () => {
    vi.mocked(shopifyQueries.getOrderSummary).mockResolvedValue({
      totalOrders: 12,
      totalRevenueCents: 123456,
      subscriptionOrders: 3,
      subscriptionRevenueCents: 20000,
    });

    const result = (await dispatchTool(ctx, "store_performance", {})) as {
      summary: { totalRevenueDollars: number; subscriptionRevenueDollars: number };
    };
    expect(result.summary.totalRevenueDollars).toBe(1234.56);
    expect(result.summary.subscriptionRevenueDollars).toBe(200);
  });
});

describe("social_performance", () => {
  it("caps how many posts come back so a long window cannot flood the context", async () => {
    const posts = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`, caption: "hi", mediaType: "IMAGE", mediaProductType: "FEED",
      permalink: null, likeCount: 1, commentsCount: 0, impressions: 10, reach: 10,
      saved: 0, shares: 0, plays: 0, totalInteractions: 1,
      postedAt: new Date("2026-09-01T00:00:00Z"),
    }));
    vi.mocked(socialQueries.getPostsByDateRange).mockResolvedValue(posts);

    const result = (await dispatchTool(ctx, "social_performance", { limit: 5 })) as {
      posts: unknown[];
      postsReturned: number;
      postsMatched: number;
    };

    expect(result.posts).toHaveLength(5);
    expect(result.postsReturned).toBe(5);
    // Saying only "here are 5" would let the model treat a sample as the whole set.
    expect(result.postsMatched).toBe(50);
  });

  it("ranks posts by engagement rather than returning an arbitrary slice", async () => {
    const post = (id: string, likes: number) => ({
      id, caption: id, mediaType: "IMAGE", mediaProductType: "FEED", permalink: null,
      likeCount: likes, commentsCount: 0, impressions: 100, reach: 100,
      saved: 0, shares: 0, plays: 0, totalInteractions: likes,
      postedAt: new Date("2026-09-01T00:00:00Z"),
    });
    vi.mocked(socialQueries.getPostsByDateRange).mockResolvedValue([
      post("quiet", 1),
      post("loud", 90),
    ]);

    const result = (await dispatchTool(ctx, "social_performance", {})) as {
      posts: { id: string }[];
    };
    expect(result.posts[0].id).toBe("loud");
  });
});

describe("inventory_status", () => {
  const stocked = {
    variantId: "1", productTitle: "Doodle Pad", variantTitle: null, sku: "D-1",
    quantity: 500, tracked: true, productStatus: "ACTIVE", unitsSoldLast30d: 1,
  };
  const stockedOut = {
    variantId: "2", productTitle: "Sticker Set", variantTitle: null, sku: "S-1",
    quantity: 0, tracked: true, productStatus: "ACTIVE", unitsSoldLast30d: 60,
  };

  it("labels each item with what is actually wrong with it", async () => {
    vi.mocked(inventoryQueries.getInventoryItems).mockResolvedValue([stockedOut]);

    const result = (await dispatchTool(ctx, "inventory_status", {})) as {
      items: { classification: string; daysOfCover: number | null }[];
    };
    expect(result.items[0].classification).toBe("stockout");
  });

  it("omits healthy stock by default — only the problems are worth the context", async () => {
    vi.mocked(inventoryQueries.getInventoryItems).mockResolvedValue([stocked, stockedOut]);

    const result = (await dispatchTool(ctx, "inventory_status", {})) as {
      items: { variantId: string }[];
    };
    expect(result.items.map((i) => i.variantId)).toEqual(["2"]);
  });

  it("includes healthy stock on request", async () => {
    vi.mocked(inventoryQueries.getInventoryItems).mockResolvedValue([stocked, stockedOut]);

    const result = (await dispatchTool(ctx, "inventory_status", {
      includeHealthy: true,
    })) as { items: unknown[] };
    expect(result.items).toHaveLength(2);
  });

  it("counts every variant it looked at, not just the ones it returned", async () => {
    vi.mocked(inventoryQueries.getInventoryItems).mockResolvedValue([stocked, stockedOut]);

    const result = (await dispatchTool(ctx, "inventory_status", {})) as {
      variantsChecked: number;
    };
    expect(result.variantsChecked).toBe(2);
  });
});

describe("current_alerts", () => {
  it("returns the same alerts the scheduled run would raise, as data", async () => {
    vi.mocked(runAlertChecks).mockResolvedValue([
      { type: "roas-drop", severity: "warning", message: "ROAS fell" },
    ]);

    const result = (await dispatchTool(ctx, "current_alerts", {})) as {
      alerts: { type: string; severity: string }[];
    };
    expect(result.alerts[0].type).toBe("roas-drop");
  });

  // The check-failure alert is the one that says the report is untrustworthy.
  it("flags when a check failed to run", async () => {
    vi.mocked(runAlertChecks).mockResolvedValue([
      { type: "check-failed", severity: "warning", message: "inventory did not run" },
    ]);

    const result = (await dispatchTool(ctx, "current_alerts", {})) as {
      someChecksFailed: boolean;
    };
    expect(result.someChecksFailed).toBe(true);
  });

  it("does not claim a failure when every check ran", async () => {
    vi.mocked(runAlertChecks).mockResolvedValue([]);
    const result = (await dispatchTool(ctx, "current_alerts", {})) as {
      someChecksFailed: boolean;
    };
    expect(result.someChecksFailed).toBe(false);
  });
});

describe("brand_voice", () => {
  it("returns the rules and banned words that any generated copy must respect", async () => {
    vi.mocked(voiceQueries.getAllRules).mockResolvedValue([
      { id: "r1", rule: "No exclamation marks", createdAt: NOW },
    ] as never);
    vi.mocked(voiceQueries.getAllBannedWords).mockResolvedValue([
      { id: "b1", word: "synergy", createdAt: NOW },
    ] as never);

    const result = (await dispatchTool(ctx, "brand_voice", {})) as {
      rules: string[];
      bannedWords: string[];
    };
    expect(result.rules).toEqual(["No exclamation marks"]);
    expect(result.bannedWords).toEqual(["synergy"]);
  });

  it("leaves the writing samples out unless asked — they are large", async () => {
    vi.mocked(voiceQueries.getAllSamples).mockResolvedValue([
      { id: "s1", title: "A", content: "long text", tags: [], createdAt: NOW },
    ] as never);

    const withoutSamples = (await dispatchTool(ctx, "brand_voice", {})) as {
      samples: unknown[] | null;
      sampleCount: number;
    };
    expect(withoutSamples.samples).toBeNull();
    expect(withoutSamples.sampleCount).toBe(1);

    const withSamples = (await dispatchTool(ctx, "brand_voice", {
      includeSamples: true,
    })) as { samples: unknown[] | null };
    expect(withSamples.samples).toHaveLength(1);
  });
});

describe("calendar_entries", () => {
  it("looks ahead by default, since the calendar is for planning", async () => {
    await dispatchTool(ctx, "calendar_entries", {});
    const [, start, end] = vi.mocked(calendarQueries.getEntriesByWeek).mock.calls[0];
    expect(start.toISOString()).toBe("2026-09-02T12:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-02T12:00:00.000Z");
  });
});
