import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpArgumentError } from "@/mcp/args";
import {
  ALL_TOOLS,
  dispatchTool,
  findTool,
  toJsonSchema,
  type McpToolContext,
} from "@/mcp/tools";
import { createMockAnalyticsDb } from "../mocks/analytics-db";

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
}));
vi.mock("@/domain/subscriptions/queries", () => ({
  getSubscriptionFacts: vi.fn().mockResolvedValue([]),
  getSnapshotFacts: vi.fn().mockResolvedValue([]),
  getTierChangeFacts: vi.fn().mockResolvedValue([]),
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
vi.mock("@/db/quality", () => ({
  getDataQuality: vi.fn().mockResolvedValue([]),
  anyQualityIssue: vi.fn().mockReturnValue(false),
}));
vi.mock("@/domain/pilot/queries", () => ({
  getPilotEntries: vi.fn().mockResolvedValue([]),
  noteExists: vi.fn().mockResolvedValue(true),
  appendPilotEntry: vi.fn().mockResolvedValue(undefined),
}));

import * as metaQueries from "@/domain/meta/queries";
import * as shopifyQueries from "@/domain/shopify/queries";
import * as socialQueries from "@/domain/social/queries";
import * as inventoryQueries from "@/domain/inventory/queries";
import * as calendarQueries from "@/domain/calendar/queries";
import * as voiceQueries from "@/domain/voice/queries";
import * as subscriptionQueries from "@/domain/subscriptions/queries";
import { runAlertChecks } from "@/domain/alerts/runner";
import { getDataFreshness } from "@/db/freshness";
import { getDataQuality, anyQualityIssue } from "@/db/quality";
import * as pilotQueries from "@/domain/pilot/queries";
import type { PilotEntry } from "@/domain/pilot/notes";

const NOW = new Date("2026-09-02T12:00:00Z");
const ctx: McpToolContext = { db: {} as never, now: () => NOW };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the tool catalogue", () => {
  it("exposes tools under unique names", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("describes every tool, since the description is all the model gets", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });

  // The write surface is exactly one tool. This is the assertion that has to
  // go red the moment anyone adds a second one — not to forbid it, but to make
  // it a deliberate decision rather than something that slips in behind a
  // readOnly flag nobody looked at.
  it("exposes exactly one write-enabled tool, and it is pilot_notes_add", () => {
    const writers = ALL_TOOLS.filter((t) => !t.readOnly).map((t) => t.name);
    expect(writers).toEqual(["pilot_notes_add"]);
  });

  it("names tools in the snake_case MCP convention", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("registers the three subscription tools", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(names).toContain("subscription_summary");
    expect(names).toContain("subscription_ltv");
    expect(names).toContain("subscription_changes");
  });

  // The old tool inferred tier from order price and blended censored tenure.
  // Leaving any route to it registered would keep those numbers reachable.
  it("no longer accepts the churn threshold argument the price-inference version took", async () => {
    await expect(
      dispatchTool(ctx, "subscription_ltv", { churnThresholdDays: 45 })
    ).rejects.toThrow(McpArgumentError);
  });
});

describe("subscription tools", () => {
  const fact = (over: Record<string, unknown> = {}) => ({
    id: "1",
    status: "ACTIVE",
    tier: "spark",
    pricingCohort: "grandfathered",
    billingInterval: "1 month",
    billingCadence: "monthly",
    priceCents: 500,
    priceAnomaly: false,
    inDunning: false,
    manualOrigin: false,
    orderPlaced: new Date("2026-06-01T00:00:00Z"),
    cancelledOn: null,
    ...over,
  });

  it("reports subscription_summary money in dollars, never cents", async () => {
    vi.mocked(subscriptionQueries.getSubscriptionFacts).mockResolvedValue([
      fact({ priceCents: 500 }),
      fact({ id: "2", billingCadence: "annual", billingInterval: "12 month", priceCents: 12000 }),
    ] as never);

    const r = (await dispatchTool(ctx, "subscription_summary", {})) as Record<string, never>;
    const mrr = r.mrr as unknown as Record<string, number>;
    expect(mrr.monthlyBilledDollars).toBe(5);
    expect(mrr.annualAmortisedDollars).toBe(10);
    expect(mrr.totalDollars).toBe(15);
    expect(r.arrDollars as unknown as number).toBe(180);
    expect(JSON.stringify(r)).not.toMatch(/Cents/);
  });

  it("keeps the churned and active LTV cohorts separate in the payload", async () => {
    vi.mocked(subscriptionQueries.getSubscriptionFacts).mockResolvedValue([
      fact({ status: "CANCELLED", cancelledOn: new Date("2026-08-01T00:00:00Z") }),
      fact({ id: "2" }),
    ] as never);

    const r = (await dispatchTool(ctx, "subscription_ltv", {})) as Record<string, never>;
    const churned = r.churned as unknown as Record<string, never>;
    const active = r.active as unknown as Record<string, never>;
    expect(churned.complete).toBe(true);
    expect(active.complete).toBe(false);
    expect((churned.observed as unknown as { subscribers: number }).subscribers).toBe(1);
    expect((active.observed as unknown as { subscribers: number }).subscribers).toBe(1);
  });

  // Daily snapshots began 2026-09-02, but Seal's log reaches back to 2026-05-22,
  // so the June launch window is answerable through the tool and not just in
  // the domain layer. This is the wiring that makes that true.
  it("answers tier transitions for a window that predates the snapshots", async () => {
    vi.mocked(subscriptionQueries.getSubscriptionFacts).mockResolvedValue([] as never);
    vi.mocked(subscriptionQueries.getSnapshotFacts).mockResolvedValue([] as never);
    vi.mocked(subscriptionQueries.getTierChangeFacts).mockResolvedValue([
      {
        subscriptionId: "s1",
        at: "2026-06-13T22:50:20.000Z",
        from: "spark",
        to: "studio",
        pricingCohort: "grandfathered",
        priceChangeLogged: false,
      },
    ] as never);

    const r = (await dispatchTool(ctx, "subscription_changes", {
      startDate: "2026-06-01",
      endDate: "2026-08-31",
    })) as Record<string, never>;

    const t = r.tierTransitions as unknown as Record<string, unknown>;
    expect(t.available).toBe(true);
    expect(t.upgraded).toBe(1);
    expect(t.grandfatheredSparkToStudio).toBe(1);
    expect(t.source as string).toMatch(/log/i);
  });

  // Before the log begins there is nothing to read, and "0 upgrades" would be
  // indistinguishable from "we cannot see that far back".
  it("refuses to report tier transitions for a window entirely before the log begins", async () => {
    vi.mocked(subscriptionQueries.getSubscriptionFacts).mockResolvedValue([] as never);
    vi.mocked(subscriptionQueries.getSnapshotFacts).mockResolvedValue([] as never);
    vi.mocked(subscriptionQueries.getTierChangeFacts).mockResolvedValue([] as never);

    const r = (await dispatchTool(ctx, "subscription_changes", {
      startDate: "2026-01-01",
      endDate: "2026-03-31",
    })) as Record<string, never>;

    const t = r.tierTransitions as unknown as Record<string, unknown>;
    expect(t.available).toBe(false);
    expect(t.reason as string).toMatch(/2026-05-22/);
    expect(t).not.toHaveProperty("upgraded");
    expect(t).not.toHaveProperty("grandfatheredSparkToStudio");
  });

  it("rejects a granularity it does not offer instead of ignoring it", async () => {
    await expect(
      dispatchTool(ctx, "subscription_changes", { granularity: "hour" })
    ).rejects.toThrow(McpArgumentError);
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
      { source: "Meta ads", table: "meta_insights", basis: "synced", rows: 10, lastAt: null, ageHours: null, stale: true, lastRun: null },
    ]);

    const result = (await dispatchTool(ctx, "data_freshness", {})) as {
      sources: unknown[];
      anyStale: boolean;
    };

    expect(result.sources).toHaveLength(1);
    expect(result.anyStale).toBe(true);
  });

  it("passes the last run outcome through so a model can see why a source is empty", async () => {
    // Without this, a model reading zero rows has no way to tell a broken sync
    // from a quiet account, and will confidently report the wrong one.
    vi.mocked(getDataFreshness).mockResolvedValue([
      {
        source: "Meta ads", table: "meta_insights", basis: "synced", rows: 0,
        lastAt: null, ageHours: null, stale: true,
        lastRun: { outcome: "not-configured", at: null, errorMessage: "Not configured: META_AD_ACCOUNT_ID is not set" },
      },
    ]);

    const result = (await dispatchTool(ctx, "data_freshness", {})) as {
      sources: Array<{ lastRun: { outcome: string } | null }>;
    };

    expect(result.sources[0].lastRun?.outcome).toBe("not-configured");
  });

  // A feed can run perfectly and still deliver rows nothing can classify. That
  // is how product_type sat blank on 2,114 line items for a year behind a
  // green freshness report.
  it("reports data quality checks alongside sync recency", async () => {
    vi.mocked(getDataQuality).mockResolvedValue([
      {
        check: "line items with a blank product_type",
        table: "shopify_line_items",
        detail: "Cannot be split by product_type.",
        affected: 1977,
        total: 58000,
        status: "issue",
        affectedPct: 3.4,
      },
    ]);
    vi.mocked(anyQualityIssue).mockReturnValue(true);

    const result = (await dispatchTool(ctx, "data_freshness", {})) as {
      quality: unknown[];
      anyQualityIssue: boolean;
    };

    expect(result.quality).toHaveLength(1);
    expect(result.anyQualityIssue).toBe(true);
  });

  it("keeps quality separate from staleness so one cannot mask the other", async () => {
    vi.mocked(getDataFreshness).mockResolvedValue([]);
    vi.mocked(getDataQuality).mockResolvedValue([
      {
        check: "line items with a blank product_type",
        table: "shopify_line_items",
        detail: "Cannot be split by product_type.",
        affected: 1977,
        total: 58000,
        status: "issue",
        affectedPct: 3.4,
      },
    ]);
    vi.mocked(anyQualityIssue).mockReturnValue(true);

    const result = (await dispatchTool(ctx, "data_freshness", {})) as {
      anyStale: boolean;
      anyQualityIssue: boolean;
    };

    expect(result.anyStale).toBe(false);
    expect(result.anyQualityIssue).toBe(true);
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

/**
 * ─── brand_voice(channel) and voice_check ─────────────────────────────
 *
 * This is the MCP half of #27. Claude Desktop is the head of marketing here:
 * it asks what the rules are, writes the copy, and checks it. Handing it the
 * flat rule list — every rule on every channel — is what made the Figma
 * plugin's copy channel-inappropriate in the first place, and a rule set
 * without an enforcement flag tells it a prohibition is checked when nothing
 * checks it.
 *
 * These call `dispatchTool` rather than the tool object, so registration and
 * argument parsing are exercised too: a tool that exists and is not in
 * ALL_TOOLS answers exactly like one that was never written.
 */
const IG_ONLY = 'Don\'t say "comments get" as if you\'re writing an instagram post.';
const BIO_ONLY = 'Don\'t say "link in bio" outside instagram.';

function seedVoice(opts: {
  rules?: string[];
  bannedWords?: string[];
  samples?: Array<{ id: string; title: string; content: string; tags: string[] }>;
} = {}) {
  vi.mocked(voiceQueries.getAllRules).mockResolvedValue(
    (opts.rules ?? ["Never use em dashes", "No vulgarity", IG_ONLY, BIO_ONLY]).map((rule, i) => ({
      id: `r${i}`,
      rule,
      createdAt: NOW,
    })) as never
  );
  vi.mocked(voiceQueries.getAllBannedWords).mockResolvedValue(
    (opts.bannedWords ?? ["synergy"]).map((word, i) => ({ id: `b${i}`, word, createdAt: NOW })) as never
  );
  vi.mocked(voiceQueries.getAllSamples).mockResolvedValue(
    (opts.samples ?? [
      { id: "ig1", title: "IG1", content: "ig copy one", tags: ["channel:instagram", "intent:story"] },
      { id: "ig2", title: "IG2", content: "ig copy two", tags: ["channel:instagram", "intent:promo"] },
    ]).map((s) => ({ ...s, createdAt: NOW })) as never
  );
}

type BrandVoiceResult = {
  audience: string;
  rules: Array<{ text: string; enforced: boolean; unenforcedBecause?: string }>;
  excusedOnThisChannel: string[];
  bannedWords: string[];
  samples: {
    source: string;
    explanation: string;
    used: number;
    corpusSize: number;
    items: Array<{ title: string; content: string; tags: string[] }> | null;
  };
};

const brandVoice = (args: Record<string, unknown> = {}) =>
  dispatchTool(ctx, "brand_voice", args) as Promise<BrandVoiceResult>;

describe("brand_voice", () => {
  beforeEach(() => seedVoice());

  it("returns the rules and banned words that any generated copy must respect", async () => {
    const result = await brandVoice();
    expect(result.rules.map((r) => r.text)).toContain("Never use em dashes");
    expect(result.bannedWords).toEqual(["synergy"]);
  });

  it("leaves the writing samples out unless asked — they are large", async () => {
    expect((await brandVoice()).samples.items).toBeNull();
    expect((await brandVoice({ includeSamples: true })).samples.items).toHaveLength(2);
  });

  // Even with items omitted, the caller has to be able to tell a two-sample
  // corpus from an eighty-four-sample one.
  it("reports how many samples there are even when it does not return them", async () => {
    const r = await brandVoice();
    expect(r.samples.corpusSize).toBe(2);
    expect(r.samples.used).toBe(2);
  });

  it("names the audience it answered for, including when none was asked for", async () => {
    expect((await brandVoice({ channel: "email" })).audience).toBe("email");
    expect((await brandVoice()).audience).toBe("unspecified");
  });

  // A typo'd channel widened to "everything" would hide the typo, and the
  // model would believe it had asked a question it did not ask.
  it.each(["e-mail", "insta", "Instagram", "unspecified"])(
    "refuses %o rather than answering for a channel nobody named",
    async (channel) => {
      await expect(brandVoice({ channel })).rejects.toBeInstanceOf(McpArgumentError);
    }
  );

  it("does not hand instagram the rules instagram is excused from", async () => {
    const r = await brandVoice({ channel: "instagram" });
    const texts = r.rules.map((x) => x.text);
    expect(texts).not.toContain(IG_ONLY);
    expect(texts).not.toContain(BIO_ONLY);
    expect(texts).toContain("Never use em dashes");
  });

  // Not just absent from the list — named, so the model can see that a rule
  // exists and does not apply here, rather than inferring it was never written.
  it("says which rules this channel is excused from", async () => {
    expect((await brandVoice({ channel: "instagram" })).excusedOnThisChannel).toEqual(
      expect.arrayContaining([IG_ONLY, BIO_ONLY])
    );
    expect((await brandVoice({ channel: "email" })).excusedOnThisChannel).toEqual([]);
  });

  /**
   * The model is about to write copy and then check it. A rule it is told
   * about but that nothing enforces is guidance; one that is enforced will
   * come back as a violation. Flattening the two makes `voice_check` look
   * either stricter or laxer than it is.
   */
  it("says of each rule whether anything actually checks it", async () => {
    seedVoice({ rules: ["Never use em dashes", "Sound like a friend, not a brand"] });
    const byText = Object.fromEntries((await brandVoice()).rules.map((r) => [r.text, r]));
    expect(byText["Never use em dashes"].enforced).toBe(true);
    expect(byText["Sound like a friend, not a brand"].enforced).toBe(false);
    expect(byText["Sound like a friend, not a brand"].unenforcedBecause).toBeTruthy();
  });
});

/**
 * All 84 real samples are `channel:instagram`, so asking for email samples
 * returns Instagram ones. That is the agreed behaviour — email copy written
 * from the Instagram corpus has been working in practice, so scoping to an
 * empty set would be worse than the problem. What is not acceptable is the
 * model being unable to tell that is what happened.
 */
describe("brand_voice: sample scoping and its fallback", () => {
  beforeEach(() => seedVoice());

  it("returns only the channel's samples when it has some", async () => {
    const r = await brandVoice({ channel: "instagram", includeSamples: true });
    expect(r.samples.source).toBe("channel");
    expect(r.samples.used).toBe(2);
  });

  it("falls back to the whole corpus for a channel with none, rather than returning nothing", async () => {
    const r = await brandVoice({ channel: "email", includeSamples: true });
    expect(r.samples.source).toBe("corpus-fallback");
    expect(r.samples.items).toHaveLength(2);
    expect(r.samples.explanation).toMatch(/channel:email/);
  });

  it("distinguishes that fallback from having named no channel at all", async () => {
    const asked = await brandVoice({ channel: "email" });
    const unasked = await brandVoice();
    expect(asked.samples.source).not.toBe(unasked.samples.source);
    expect(asked.samples.explanation).not.toBe(unasked.samples.explanation);
  });

  // "Never infer channel from the corpus" — #61. An all-Instagram corpus does
  // not make an email request an Instagram request.
  it("still answers for email even though every sample is instagram", async () => {
    expect((await brandVoice({ channel: "email" })).audience).toBe("email");
  });
});

describe("brand_voice: an empty corpus is a fault, not a brand with no rules", () => {
  // Zero rules over a table that should hold four is an unrun read, not a
  // permissive brand. Returning it as data invites copy written against
  // nothing and checked against nothing.
  it("reports an error rather than an empty rule set", async () => {
    seedVoice({ rules: [], bannedWords: [], samples: [] });
    const r = (await dispatchTool(ctx, "brand_voice", {})) as { error?: string };
    expect(r.error).toBeTruthy();
    expect(r).not.toHaveProperty("rules");
  });
});

type VoiceCheckToolResult = {
  ok: boolean;
  audience: string | null;
  violations: Array<{ rule: string; detail: string }>;
  enforced: string[];
  unenforced: string[];
};

const check = (args: Record<string, unknown>) =>
  dispatchTool(ctx, "voice_check", args) as Promise<VoiceCheckToolResult>;

describe("voice_check", () => {
  beforeEach(() => seedVoice());

  it("is registered, so the model can reach it", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toContain("voice_check");
  });

  it("is read-only — checking copy writes nothing", () => {
    expect(findTool("voice_check")?.readOnly).toBe(true);
  });

  it("passes clean copy and says what it checked", async () => {
    const r = await check({ text: "Our new planners are here and they are lovely.", channel: "email" });
    expect(r.ok).toBe(true);
    expect(r.enforced).toContain("Never use em dashes");
  });

  it("catches a rule violation and names the rule, not a regex", async () => {
    const r = await check({ text: "Planners — they're here", channel: "email" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("Never use em dashes");
  });

  it("catches a banned word", async () => {
    const r = await check({ text: "Real synergy in this collection.", channel: "email" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("banned-word");
  });

  /**
   * The scoping, end to end through the tool. "All comments get a link" is
   * correct Instagram copy and wrong in an inbox. If the channel were dropped
   * on the way in, both of these would return the same verdict.
   */
  it("excuses instagram from the rule instagram is excused from", async () => {
    expect((await check({ text: "All comments get a link!", channel: "instagram" })).ok).toBe(true);
    expect((await check({ text: "All comments get a link!", channel: "email" })).ok).toBe(false);
  });

  it("applies every rule when no channel is given", async () => {
    expect((await check({ text: "All comments get a link!" })).ok).toBe(false);
    expect((await check({ text: "All comments get a link!" })).audience).toBe("unspecified");
  });

  // Fail closed. Nothing was checked, so nothing is clean.
  it.each(["", "   "])("refuses %o rather than passing an empty check", async (text) => {
    const r = await check({ text, channel: "email" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("empty-output");
  });

  it("refuses a channel it does not recognise", async () => {
    await expect(check({ text: "copy", channel: "e-mail" })).rejects.toBeInstanceOf(McpArgumentError);
  });

  it("requires the text it is meant to check", async () => {
    await expect(check({ channel: "email" })).rejects.toBeInstanceOf(McpArgumentError);
  });

  // A clean pass over three uncheckable rules and a clean pass over three
  // checked ones are different results.
  it("separates the rules it enforced from the ones nothing checks", async () => {
    seedVoice({ rules: ["Never use em dashes", "Sound like a friend, not a brand"] });
    const r = await check({ text: "Our planners are here.", channel: "email" });
    expect(r.enforced).toEqual(["Never use em dashes"]);
    expect(r.unenforced).toEqual(["Sound like a friend, not a brand"]);
  });

  it("refuses when the profile gives it nothing to check", async () => {
    seedVoice({ rules: [], bannedWords: [] });
    const r = await check({ text: "anything at all", channel: "email" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("nothing-checked");
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

describe("pilot notes tools", () => {
  const entry = (o: Partial<PilotEntry>): PilotEntry => ({
    id: "1",
    noteId: "1",
    kind: "open",
    title: "A note",
    body: "body",
    category: null,
    author: "claude",
    createdAt: new Date("2026-09-01T10:00:00Z"),
    ...o,
  });

  describe("pilot_notes_get", () => {
    it("returns open notes when no status is given", async () => {
      vi.mocked(pilotQueries.getPilotEntries).mockResolvedValue([
        entry({ id: "1", noteId: "1", title: "Open one" }),
        entry({ id: "2", noteId: "2", title: "Closed one" }),
        entry({ id: "3", noteId: "2", kind: "resolution", title: null, body: "fixed" }),
      ]);

      const result = (await dispatchTool(ctx, "pilot_notes_get", {})) as {
        filters: { status: string };
        notes: { title: string }[];
      };

      expect(result.filters.status).toBe("open");
      expect(result.notes).toHaveLength(1);
      expect(result.notes[0].title).toBe("Open one");
    });

    // A sample mistaken for the whole set is how "there are only 2 open notes"
    // gets concluded from a capped list.
    it("reports both what matched and what it returned", async () => {
      vi.mocked(pilotQueries.getPilotEntries).mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => entry({ id: `${i}`, noteId: `${i}` }))
      );

      const result = (await dispatchTool(ctx, "pilot_notes_get", { limit: 2 })) as {
        matched: number;
        returned: number;
        notes: unknown[];
      };

      expect(result.matched).toBe(5);
      expect(result.returned).toBe(2);
      expect(result.notes).toHaveLength(2);
    });

    it("carries the full entry history so the reasoning is visible", async () => {
      vi.mocked(pilotQueries.getPilotEntries).mockResolvedValue([
        entry({ id: "1", noteId: "1" }),
        entry({ id: "2", noteId: "1", kind: "comment", title: null, body: "more context" }),
      ]);

      const result = (await dispatchTool(ctx, "pilot_notes_get", {})) as {
        notes: { entries: { body: string }[] }[];
      };

      expect(result.notes[0].entries.map((e) => e.body)).toEqual(["body", "more context"]);
    });

    it("rejects a status outside the known set", async () => {
      await expect(dispatchTool(ctx, "pilot_notes_get", { status: "urgent" })).rejects.toBeInstanceOf(
        McpArgumentError
      );
    });
  });

  describe("pilot_notes_add", () => {
    it("appends an opening entry and returns the id later entries attach to", async () => {
      const result = (await dispatchTool(ctx, "pilot_notes_add", {
        title: "MRR looks wrong",
        body: "Checked against Seal.",
        category: "subscriptions",
      })) as { written: boolean; noteId: string; entryId: string };

      expect(result.written).toBe(true);
      expect(result.noteId).toBe(result.entryId);
      expect(pilotQueries.appendPilotEntry).toHaveBeenCalledTimes(1);

      const [, written] = vi.mocked(pilotQueries.appendPilotEntry).mock.calls[0];
      expect(written.title).toBe("MRR looks wrong");
      expect(written.kind).toBe("open");
      expect(written.createdAt).toEqual(NOW);
    });

    it("refuses an empty body rather than storing a blank note", async () => {
      await expect(dispatchTool(ctx, "pilot_notes_add", { title: "t", body: "   " })).rejects.toBeInstanceOf(
        McpArgumentError
      );
      expect(pilotQueries.appendPilotEntry).not.toHaveBeenCalled();
    });

    it("refuses to open a note with no title", async () => {
      await expect(dispatchTool(ctx, "pilot_notes_add", { body: "detail" })).rejects.toThrow(/title/i);
      expect(pilotQueries.appendPilotEntry).not.toHaveBeenCalled();
    });

    // A typo'd noteId would otherwise create an entry no one can reach, which
    // the fold then reports as data damage.
    it("refuses to append to a note that does not exist", async () => {
      vi.mocked(pilotQueries.noteExists).mockResolvedValue(false);

      await expect(
        dispatchTool(ctx, "pilot_notes_add", { kind: "comment", body: "x", noteId: "nope" })
      ).rejects.toThrow(/No pilot note with id/);
      expect(pilotQueries.appendPilotEntry).not.toHaveBeenCalled();
    });

    it("closes a note with a resolution entry rather than editing it", async () => {
      vi.mocked(pilotQueries.noteExists).mockResolvedValue(true);

      await dispatchTool(ctx, "pilot_notes_add", {
        kind: "resolution",
        body: "Fixed in Seal.",
        noteId: "abc",
      });

      const [, written] = vi.mocked(pilotQueries.appendPilotEntry).mock.calls[0];
      expect(written.kind).toBe("resolution");
      expect(written.noteId).toBe("abc");
    });

    it("rejects an unknown argument instead of silently dropping it", async () => {
      await expect(
        dispatchTool(ctx, "pilot_notes_add", { title: "t", body: "b", status: "closed" })
      ).rejects.toBeInstanceOf(McpArgumentError);
      expect(pilotQueries.appendPilotEntry).not.toHaveBeenCalled();
    });

    // There is no update and no delete anywhere in the module; this asserts the
    // tool cannot reach one by naming a kind that implies mutation.
    it("has no kind that edits or deletes", async () => {
      for (const kind of ["edit", "delete", "update"]) {
        await expect(
          dispatchTool(ctx, "pilot_notes_add", { kind, body: "b", noteId: "abc" })
        ).rejects.toBeInstanceOf(McpArgumentError);
      }
    });
  });

  describe("pilot_notes_export", () => {
    it("renders the log as markdown", async () => {
      vi.mocked(pilotQueries.getPilotEntries).mockResolvedValue([
        entry({ id: "1", noteId: "1", title: "Something to watch" }),
      ]);

      const result = (await dispatchTool(ctx, "pilot_notes_export", {})) as {
        markdown: string;
        noteCount: number;
      };

      expect(result.markdown).toContain("# Pilot notes");
      expect(result.markdown).toContain("Something to watch");
      expect(result.noteCount).toBe(1);
    });

    // An empty document under a heading reads as "nothing is wrong". It has to
    // say that the log is empty instead.
    it("says the log is empty rather than returning a bare heading", async () => {
      vi.mocked(pilotQueries.getPilotEntries).mockResolvedValue([]);

      const result = (await dispatchTool(ctx, "pilot_notes_export", {})) as { markdown: string };
      expect(result.markdown).toMatch(/no notes/i);
    });
  });
});

describe("query", () => {
  const NOW = new Date("2026-09-06T10:00:00.000Z");

  function ctxWith(analytics: ReturnType<typeof createMockAnalyticsDb> | undefined) {
    const inserted: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({ values: (v: Record<string, unknown>) => { inserted.push(v); return Promise.resolve(); } }),
    };
    return { ctx: { db: db as never, now: () => NOW, analytics }, inserted };
  }

  it("runs a read and returns rows", async () => {
    const analytics = createMockAnalyticsDb({
      select: vi.fn().mockResolvedValue({ columns: ["n"], rows: [{ n: "4395" }], truncated: false }),
    });
    const { ctx } = ctxWith(analytics);

    const result = (await dispatchTool(ctx, "query", {
      sql: "SELECT count(*) n FROM subscriptions",
    })) as { ok: boolean; rows: unknown[] };

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([{ n: "4395" }]);
  });

  it("writes an entry to query_log", async () => {
    const { ctx, inserted } = ctxWith(createMockAnalyticsDb());
    await dispatchTool(ctx, "query", { sql: "SELECT 1" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ sqlText: "SELECT 1", ranAt: NOW });
  });

  it("describes the live catalog", async () => {
    const analytics = createMockAnalyticsDb({
      describe: vi.fn().mockResolvedValue([
        { view: "subscriptions", comment: null, columns: [{ name: "id", type: "text" }] },
      ]),
    });
    const { ctx } = ctxWith(analytics);

    const result = (await dispatchTool(ctx, "query", { action: "describe" })) as {
      ok: boolean;
      viewCount: number;
    };

    expect(result).toMatchObject({ ok: true, viewCount: 1 });
    expect(analytics.describe).toHaveBeenCalled();
  });

  // The whole security model is "this connects as a role that cannot see PII".
  // Falling back to the owner pool when the read-only URL is missing would make
  // that a comment rather than a fact.
  it("is unavailable rather than falling back to the owner connection", async () => {
    const { ctx } = ctxWith(undefined);
    const result = (await dispatchTool(ctx, "query", { sql: "SELECT 1" })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ANALYTICS_DATABASE_URL/);
  });

  it("requires sql when running a query", async () => {
    const { ctx } = ctxWith(createMockAnalyticsDb());
    const result = (await dispatchTool(ctx, "query", {})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/"sql" is required/i);
  });

  // `sql` alongside `describe` means the caller expected the SQL to run.
  // Ignoring it would return a schema listing that looks like a query result.
  it("rejects sql passed to the describe action", async () => {
    const { ctx } = ctxWith(createMockAnalyticsDb());
    const result = (await dispatchTool(ctx, "query", {
      action: "describe",
      sql: "SELECT 1",
    })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/describe.*does not take.*sql/i);
  });

  it("refuses a write without touching the connection", async () => {
    const analytics = createMockAnalyticsDb();
    const { ctx } = ctxWith(analytics);
    const result = (await dispatchTool(ctx, "query", {
      sql: "DELETE FROM subscriptions",
    })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(analytics.select).not.toHaveBeenCalled();
  });

  it("is declared read-only and names the schema in its description", () => {
    const tool = findTool("query")!;
    expect(tool.readOnly).toBe(true);
    expect(tool.description).toMatch(/analytics/);
    expect(tool.description).toMatch(/describe/);
  });
});
