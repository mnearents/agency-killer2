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
    quantity: 500, priceCents: 2000, tracked: true, productStatus: "ACTIVE",
    unitsSoldLast30d: 1, unitsSoldLast12m: 12,
  };
  const stockedOut = {
    variantId: "2", productTitle: "Sticker Set", variantTitle: null, sku: "S-1",
    quantity: 0, priceCents: 700, tracked: true, productStatus: "ACTIVE",
    unitsSoldLast30d: 60, unitsSoldLast12m: 720,
  };
  // Real shape and real figures: 617 units at $10, selling ~25/month, against
  // a 31 Dec 2026 deadline.
  const datedPlanner = {
    variantId: "3", productTitle: "2026 Dated 5x8 Planner", variantTitle: null,
    sku: "PLNRD5X8Y26", quantity: 617, priceCents: 1000, tracked: true,
    productStatus: "ACTIVE", unitsSoldLast30d: 25, unitsSoldLast12m: 300,
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

  // Days of cover cannot see a deadline. This SKU reads ~24 months of cover
  // and classifies healthy while ~520 of its 617 units are heading for the
  // skip on 1 January. Cover asks when stock runs out; a dated edition needs
  // to be asked how much is left when the clock stops.
  it("measures a dated edition against its deadline, not its days of cover", async () => {
    vi.mocked(inventoryQueries.getInventoryItems).mockResolvedValue([datedPlanner]);

    const result = (await dispatchTool(ctx, "inventory_status", {
      includeHealthy: true,
    })) as {
      items: {
        classification: string;
        daysOfCover: number | null;
        datedEdition: { editionYear: number; unitsStranded: number; dollarsStranded: number } | null;
      }[];
    };

    const [planner] = result.items;
    expect(planner.classification).toBe("healthy");
    expect(planner.daysOfCover).toBeGreaterThan(700);
    expect(planner.datedEdition).not.toBeNull();
    expect(planner.datedEdition!.editionYear).toBe(2026);
    expect(planner.datedEdition!.unitsStranded).toBeGreaterThan(500);
  });

  // Money crosses this boundary in dollars. $5,210 misread as $521,000 is the
  // kind of plausible wrong number that gets acted on.
  it("reports the stranded value in dollars, as every other tool does", async () => {
    vi.mocked(inventoryQueries.getInventoryItems).mockResolvedValue([datedPlanner]);

    const result = (await dispatchTool(ctx, "inventory_status", {
      includeHealthy: true,
    })) as { items: { datedEdition: { dollarsStranded: number } | null }[] };

    const stranded = result.items[0].datedEdition!;
    expect(stranded.dollarsStranded).toBeLessThan(10_000);
    expect(stranded.dollarsStranded).toBeGreaterThan(4_000);
  });

  it("leaves the dated field null on an undated product", async () => {
    vi.mocked(inventoryQueries.getInventoryItems).mockResolvedValue([stocked]);

    const result = (await dispatchTool(ctx, "inventory_status", {
      includeHealthy: true,
    })) as { items: { datedEdition: unknown }[] };
    expect(result.items[0].datedEdition).toBeNull();
  });

  // The whole point of the flag is that this row is a problem while every
  // velocity-based classification calls it healthy. Filtering on
  // classification alone would drop it from the default response.
  it("returns a stranding dated edition even though it classifies healthy", async () => {
    vi.mocked(inventoryQueries.getInventoryItems).mockResolvedValue([datedPlanner]);

    const result = (await dispatchTool(ctx, "inventory_status", {})) as {
      items: { variantId: string }[];
    };
    expect(result.items.map((i) => i.variantId)).toEqual(["3"]);
  });

  // 997 units of next year's planner, DRAFT, no sales because it isn't on
  // sale. Whether it strands is genuinely unknown, and unknown is not safe —
  // it must not be filtered out alongside the healthy stock.
  it("returns a dated edition whose fate could not be projected", async () => {
    vi.mocked(inventoryQueries.getInventoryItems).mockResolvedValue([
      {
        ...datedPlanner,
        variantId: "4",
        productTitle: "2027 Dated 8x10 Planner - Pencil Edition",
        productStatus: "DRAFT",
        quantity: 997,
        unitsSoldLast30d: 0,
      },
    ]);

    const result = (await dispatchTool(ctx, "inventory_status", {})) as {
      items: { variantId: string; datedEdition: { unitsStranded: number | null } | null }[];
    };
    expect(result.items.map((i) => i.variantId)).toEqual(["4"]);
    expect(result.items[0].datedEdition!.unitsStranded).toBeNull();
  });

  // A dated edition that will sell through in time is not a problem, so it
  // must not push its way into a response asking only for problems.
  it("omits a dated edition that will sell through before its deadline", async () => {
    vi.mocked(inventoryQueries.getInventoryItems).mockResolvedValue([
      { ...datedPlanner, quantity: 50, unitsSoldLast30d: 30 },
    ]);

    const result = (await dispatchTool(ctx, "inventory_status", {})) as {
      items: unknown[];
    };
    expect(result.items).toEqual([]);
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
