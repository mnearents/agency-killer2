import { describe, it, expect } from "vitest";
import {
  buildGuardrailsForOutputType,
  formatMetricsBlock,
  formatCreativeBlock,
  buildAnalysisRequest,
  type CampaignSummary,
  type CreativeSummary,
  type AnalysisPromptInput,
} from "@/domain/meta/analysis";
import type { DerivedMetrics } from "@/domain/meta/metrics";
import type { GuardrailOptions } from "@/ai/guardrails";
import { assembleVoicePrompt, type VoiceProfile } from "@/domain/voice/voice";

const VOICE_PROFILE: VoiceProfile = {
  samples: [
    { id: "1", title: "Test", content: "So excited about planners!", tags: [] },
  ],
  rules: ["No vulgarity"],
  bannedWords: ["synergy", "delve"],
};

const SAMPLE_METRICS: DerivedMetrics = {
  spendDollars: 50,
  revenueDollars: 150,
  roas: 3.0,
  costPerPurchaseDollars: 10,
  ctr: 2.0,
  cpm: 5.0,
  cpc: 0.25,
  conversionRate: 2.5,
  addToCartRate: 15,
  checkoutRate: 50,
};

const SAMPLE_CAMPAIGN: CampaignSummary = {
  campaignName: "Summer Sale",
  dateRange: { start: "2025-06-01", end: "2025-06-30" },
  metrics: SAMPLE_METRICS,
};

// ─── Guardrail configuration per output type ──────────────────────────

describe("buildGuardrailsForOutputType: analysis vs creative", () => {
  const baseGuardrails: GuardrailOptions = {
    bannedWords: ["synergy", "delve"],
    checkPii: true,
    checkFabricatedStats: true,
  };

  it("DISABLES fabricated-stats check for analysis output", () => {
    const result = buildGuardrailsForOutputType(baseGuardrails, "analysis");
    expect(result.checkFabricatedStats).toBe(false);
  });

  it("KEEPS fabricated-stats check for creative output", () => {
    const result = buildGuardrailsForOutputType(baseGuardrails, "creative");
    expect(result.checkFabricatedStats).toBe(true);
  });

  it("keeps PII check enabled for both output types", () => {
    const analysis = buildGuardrailsForOutputType(baseGuardrails, "analysis");
    const creative = buildGuardrailsForOutputType(baseGuardrails, "creative");
    expect(analysis.checkPii).toBe(true);
    expect(creative.checkPii).toBe(true);
  });

  it("keeps banned words for both output types", () => {
    const analysis = buildGuardrailsForOutputType(baseGuardrails, "analysis");
    const creative = buildGuardrailsForOutputType(baseGuardrails, "creative");
    expect(analysis.bannedWords).toEqual(["synergy", "delve"]);
    expect(creative.bannedWords).toEqual(["synergy", "delve"]);
  });
});

// ─── Metrics block formatting ─────────────────────────────────────────

describe("formatMetricsBlock: deterministic text from metrics", () => {
  it("includes campaign name and date range", () => {
    const block = formatMetricsBlock([SAMPLE_CAMPAIGN]);
    expect(block).toContain("Summer Sale");
    expect(block).toContain("2025-06-01");
    expect(block).toContain("2025-06-30");
  });

  it("includes key metrics with dollar signs and percentages", () => {
    const block = formatMetricsBlock([SAMPLE_CAMPAIGN]);
    expect(block).toContain("$50.00"); // spend
    expect(block).toContain("$150.00"); // revenue
    expect(block).toContain("3.00"); // ROAS
    expect(block).toContain("2.00%"); // CTR
  });

  it("handles null metrics gracefully", () => {
    const campaign: CampaignSummary = {
      campaignName: "No Data Yet",
      dateRange: { start: "2025-07-01", end: "2025-07-01" },
      metrics: {
        ...SAMPLE_METRICS,
        roas: null,
        costPerPurchaseDollars: null,
        ctr: null,
      },
    };
    const block = formatMetricsBlock([campaign]);
    expect(block).toContain("No Data Yet");
    expect(block).toContain("N/A"); // null metrics shown as N/A
  });

  it("includes LTV metrics when present", () => {
    const campaign: CampaignSummary = {
      ...SAMPLE_CAMPAIGN,
      ltvMetrics: {
        rawRoas: 0.5,
        ltvAdjustedRoas: 2.9,
        profitableWithLtv: true,
      },
    };
    const block = formatMetricsBlock([campaign]);
    expect(block).toContain("0.50"); // raw ROAS
    expect(block).toContain("2.90"); // LTV-adjusted ROAS
  });

  it("formats multiple campaigns", () => {
    const campaigns: CampaignSummary[] = [
      SAMPLE_CAMPAIGN,
      {
        campaignName: "Fall Collection",
        dateRange: { start: "2025-09-01", end: "2025-09-30" },
        metrics: SAMPLE_METRICS,
      },
    ];
    const block = formatMetricsBlock(campaigns);
    expect(block).toContain("Summer Sale");
    expect(block).toContain("Fall Collection");
  });

  it("produces identical output for identical input (determinism)", () => {
    const a = formatMetricsBlock([SAMPLE_CAMPAIGN]);
    const b = formatMetricsBlock([SAMPLE_CAMPAIGN]);
    expect(a).toBe(b);
  });
});

// ─── Full request assembly ────────────────────────────────────────────

describe("buildAnalysisRequest: ties everything together", () => {
  const voice = assembleVoicePrompt(VOICE_PROFILE);

  it("uses creative strategist system prompt for analysis", () => {
    const req = buildAnalysisRequest({
      campaigns: [SAMPLE_CAMPAIGN],
      voice,
      outputType: "analysis",
    });
    expect(req.system).toContain("creative strategist");
    expect(req.system).toContain("Advantage+");
    expect(req.system).toContain("Do NOT suggest budget changes");
    expect(req.system).toContain("what to shoot next");
  });

  it("includes formatted metrics in the user prompt", () => {
    const req = buildAnalysisRequest({
      campaigns: [SAMPLE_CAMPAIGN],
      voice,
      outputType: "analysis",
    });
    expect(req.prompt).toContain("Summer Sale");
    expect(req.prompt).toContain("$50.00");
  });

  it("sets guardrails with fabricated-stats OFF for analysis", () => {
    const req = buildAnalysisRequest({
      campaigns: [SAMPLE_CAMPAIGN],
      voice,
      outputType: "analysis",
    });
    expect(req.guardrails?.checkFabricatedStats).toBe(false);
    expect(req.guardrails?.checkPii).toBe(true);
  });

  it("sets guardrails with fabricated-stats ON for creative", () => {
    const req = buildAnalysisRequest({
      campaigns: [SAMPLE_CAMPAIGN],
      voice,
      outputType: "creative",
    });
    expect(req.guardrails?.checkFabricatedStats).toBe(true);
  });

  it("includes additional context when provided", () => {
    const req = buildAnalysisRequest({
      campaigns: [SAMPLE_CAMPAIGN],
      voice,
      outputType: "analysis",
      additionalContext: "CTC recommended increasing spend by 20%",
    });
    expect(req.prompt).toContain("CTC recommended increasing spend by 20%");
  });

  it("includes creative data when provided", () => {
    const creatives: CreativeSummary[] = [
      {
        adName: "UGC Reel - Planner Haul",
        campaignName: "Summer Sale",
        creativeTitle: "New planners are here!",
        creativeBody: "Check out our latest collection",
        metrics: SAMPLE_METRICS,
      },
    ];
    const req = buildAnalysisRequest({
      campaigns: [SAMPLE_CAMPAIGN],
      creatives,
      voice,
      outputType: "analysis",
    });
    expect(req.prompt).toContain("UGC Reel - Planner Haul");
    expect(req.prompt).toContain("New planners are here!");
    expect(req.prompt).toContain("Creative Performance");
  });
});

// ─── Creative block formatting ────────────────────────────────────────

describe("formatCreativeBlock: creative performance data", () => {
  const CREATIVE_A: CreativeSummary = {
    adName: "UGC Reel - Planner Haul",
    campaignName: "Summer Sale",
    creativeTitle: "New planners just dropped!",
    creativeBody: "Y'all our best collection yet",
    metrics: { ...SAMPLE_METRICS, roas: 4.5 },
  };

  const CREATIVE_B: CreativeSummary = {
    adName: "Studio Shot - Product Grid",
    campaignName: "Summer Sale",
    creativeTitle: "Shop the collection",
    creativeBody: "Premium stationery for everyday joy",
    metrics: { ...SAMPLE_METRICS, roas: 1.2 },
  };

  it("sorts creatives by ROAS descending (best first)", () => {
    const block = formatCreativeBlock([CREATIVE_B, CREATIVE_A]);
    const posA = block.indexOf("UGC Reel");
    const posB = block.indexOf("Studio Shot");
    expect(posA).toBeLessThan(posB); // 4.5x before 1.2x
  });

  it("includes ad name, campaign, headline, and copy", () => {
    const block = formatCreativeBlock([CREATIVE_A]);
    expect(block).toContain("UGC Reel - Planner Haul");
    expect(block).toContain("Summer Sale");
    expect(block).toContain("New planners just dropped!");
    expect(block).toContain("Y'all our best collection yet");
  });

  it("includes performance metrics", () => {
    const block = formatCreativeBlock([CREATIVE_A]);
    expect(block).toContain("4.50"); // ROAS
    expect(block).toContain("$50.00"); // spend
  });

  it("truncates long copy", () => {
    const longCopy: CreativeSummary = {
      ...CREATIVE_A,
      creativeBody: "x".repeat(300),
    };
    const block = formatCreativeBlock([longCopy]);
    expect(block).toContain("...");
    expect(block.length).toBeLessThan(1000);
  });

  it("returns empty string for no creatives", () => {
    expect(formatCreativeBlock([])).toBe("");
  });
});
