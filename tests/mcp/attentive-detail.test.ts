/**
 * `email_campaign_detail` and `email_journey_detail` at their call sites.
 *
 * The queries behind them are straightforward; what is worth asserting is that
 * the tools are registered, that an empty window says WHY it is empty, and
 * that the two revenue figures in the campaign tool are never presented as
 * additive — `bySegment` is the same money counted a second way.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ALL_TOOLS, dispatchTool, type McpToolContext } from "@/mcp/tools";
import * as attentiveQueries from "@/domain/attentive/queries";

vi.mock("@/domain/attentive/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/attentive/queries")>();
  return {
    ...actual,
    getAttentiveWeekSummary: vi.fn(),
    getCampaignMessagePerformance: vi.fn(),
    getCampaignSegmentPerformance: vi.fn(),
    getJourneyMessagePerformance: vi.fn(),
    getMessageCostTotals: vi.fn(),
  };
});

const NOW = new Date("2026-09-18T12:00:00Z");
const ctx = { db: {} as never, now: () => NOW } as unknown as McpToolContext;

const NO_COST = {
  campaignCostCents: 0,
  automatedSendCostCents: 0,
  receivedCostCents: 0,
  carrierFeesCents: 0,
  totalCents: 0,
  days: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(attentiveQueries.getCampaignMessagePerformance).mockResolvedValue([]);
  vi.mocked(attentiveQueries.getCampaignSegmentPerformance).mockResolvedValue([]);
  vi.mocked(attentiveQueries.getJourneyMessagePerformance).mockResolvedValue([]);
  vi.mocked(attentiveQueries.getMessageCostTotals).mockResolvedValue(NO_COST);
});

describe("the detail tools are reachable", () => {
  it.each(["email_campaign_detail", "email_journey_detail"])("%s is in the tool list", (name) => {
    expect(ALL_TOOLS.map((t) => t.name)).toContain(name);
  });
});

describe("email_campaign_detail", () => {
  const campaign = {
    date: "2026-08-19",
    campaign: "2026 Dated Sale",
    message: "Email",
    channel: "EMAIL",
    delivered: 35998,
    emailUniqueOpens: 19814,
    totalClicks: 1035,
    conversions: 29,
    revenueCents: 68348,
    unsubscribes: 159,
  };

  it("names the campaign and reports money in dollars", async () => {
    vi.mocked(attentiveQueries.getCampaignMessagePerformance).mockResolvedValue([campaign]);
    const r = (await dispatchTool(ctx, "email_campaign_detail", {})) as {
      campaigns: Array<{ campaign: string; revenue: number; unsubscribes: number }>;
    };
    expect(r.campaigns[0].campaign).toBe("2026 Dated Sale");
    expect(r.campaigns[0].revenue).toBe(683.48);
    expect(r.campaigns[0].unsubscribes).toBe(159);
  });

  /**
   * 159 unsubscribes is meaningless without the denominator: it is either a
   * catastrophe or routine depending on whether the send was 500 or 36,000.
   */
  it("rates unsubscribes against what was delivered", async () => {
    vi.mocked(attentiveQueries.getCampaignMessagePerformance).mockResolvedValue([campaign]);
    const r = (await dispatchTool(ctx, "email_campaign_detail", {})) as {
      campaigns: Array<{ unsubscribesPerThousandDelivered: number | null }>;
    };
    expect(r.campaigns[0].unsubscribesPerThousandDelivered).toBeCloseTo(4.42, 2);
  });

  // A rate over nothing delivered is undefined, and 0 would read as "nobody left".
  it("returns null, not zero, when nothing was delivered", async () => {
    vi.mocked(attentiveQueries.getCampaignMessagePerformance).mockResolvedValue([
      { ...campaign, delivered: 0, unsubscribes: 0 },
    ]);
    const r = (await dispatchTool(ctx, "email_campaign_detail", {})) as {
      campaigns: Array<{ unsubscribesPerThousandDelivered: number | null }>;
    };
    expect(r.campaigns[0].unsubscribesPerThousandDelivered).toBeNull();
  });

  /**
   * An empty window here means the detail reports were not being collected
   * yet, not that nothing was sent. Without the note the two are the same
   * empty array — and the older one is far more likely.
   */
  it("says why an empty window is empty", async () => {
    const r = (await dispatchTool(ctx, "email_campaign_detail", {})) as { note?: string };
    expect(r.note).toMatch(/began syncing/);
  });

  it("drops the note once there is data", async () => {
    vi.mocked(attentiveQueries.getCampaignMessagePerformance).mockResolvedValue([campaign]);
    const r = (await dispatchTool(ctx, "email_campaign_detail", {})) as { note?: string };
    expect(r.note).toBeUndefined();
  });

  // Zero days of cost data is a gap; zero dollars across thirty days is a free
  // month. The same 0 means both unless the day count is reported beside it.
  it("distinguishes no cost data from no cost", async () => {
    const r = (await dispatchTool(ctx, "email_campaign_detail", {})) as {
      messagingCost: { total: number; daysWithData: number; note?: string };
    };
    expect(r.messagingCost.daysWithData).toBe(0);
    expect(r.messagingCost.note).toMatch(/unknown rather than zero/);

    vi.mocked(attentiveQueries.getMessageCostTotals).mockResolvedValue({ ...NO_COST, days: 30 });
    const withData = (await dispatchTool(ctx, "email_campaign_detail", {})) as {
      messagingCost: { daysWithData: number; note?: string };
    };
    expect(withData.messagingCost.daysWithData).toBe(30);
    expect(withData.messagingCost.note).toBeUndefined();
  });

  /**
   * `bySegment` is the same revenue as `campaigns`, counted per audience.
   * Adding them double-counts, and nothing about two arrays of numbers says
   * so — the description has to.
   */
  it("warns in its own description that the two revenue figures are the same money", () => {
    const tool = ALL_TOOLS.find((t) => t.name === "email_campaign_detail")!;
    expect(tool.description).toMatch(/SAME money/);
    expect(tool.description).toMatch(/never add the two together/i);
  });
});

describe("email_journey_detail", () => {
  const step = {
    journeyName: "Browse Abandonment - Text + Email (1)",
    triggerName: "Viewed a product",
    message: "Journey Browse Abandoner Email 1",
    channel: "EMAIL",
    sendDays: 4,
    delivered: 158,
    totalClicks: 1,
    conversions: 1,
    revenueCents: 1659,
    unsubscribes: 0,
  };

  it("names the journey, the trigger and the step", async () => {
    vi.mocked(attentiveQueries.getJourneyMessagePerformance).mockResolvedValue([step]);
    const r = (await dispatchTool(ctx, "email_journey_detail", {})) as {
      messages: Array<{ journey: string; trigger: string; message: string }>;
    };
    expect(r.messages[0].journey).toBe("Browse Abandonment - Text + Email (1)");
    expect(r.messages[0].trigger).toBe("Viewed a product");
    expect(r.messages[0].message).toBe("Journey Browse Abandoner Email 1");
  });

  /**
   * A step that sent on four days and one that sent all month produce the same
   * totals at different scales. Without `sendDays` the first reads as the
   * second and looks like a failing step rather than a rare one.
   */
  it("reports how many days the step actually sent", async () => {
    vi.mocked(attentiveQueries.getJourneyMessagePerformance).mockResolvedValue([step]);
    const r = (await dispatchTool(ctx, "email_journey_detail", {})) as {
      messages: Array<{ sendDays: number }>;
    };
    expect(r.messages[0].sendDays).toBe(4);
  });

  it("rates clicks against what was delivered", async () => {
    vi.mocked(attentiveQueries.getJourneyMessagePerformance).mockResolvedValue([step]);
    const r = (await dispatchTool(ctx, "email_journey_detail", {})) as {
      messages: Array<{ clickRatePct: number | null }>;
    };
    expect(r.messages[0].clickRatePct).toBeCloseTo(0.63, 2);
  });

  it("returns null rates when nothing was delivered", async () => {
    vi.mocked(attentiveQueries.getJourneyMessagePerformance).mockResolvedValue([
      { ...step, delivered: 0, totalClicks: 0, unsubscribes: 0 },
    ]);
    const r = (await dispatchTool(ctx, "email_journey_detail", {})) as {
      messages: Array<{ clickRatePct: number | null; unsubscribesPerThousandDelivered: number | null }>;
    };
    expect(r.messages[0].clickRatePct).toBeNull();
    expect(r.messages[0].unsubscribesPerThousandDelivered).toBeNull();
  });

  it("says why an empty window is empty", async () => {
    const r = (await dispatchTool(ctx, "email_journey_detail", {})) as { note?: string };
    expect(r.note).toMatch(/began syncing/);
  });

  it("rejects an unknown argument instead of ignoring it", async () => {
    await expect(dispatchTool(ctx, "email_journey_detail", { journey: "x" })).rejects.toThrow(
      /Unknown argument/
    );
  });
});
