import { describe, it, expect } from "vitest";
import {
  buildGuardrailsForOutputType,
  formatMetricsBlock,
  buildAnalysisRequest,
  type CampaignSummary,
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

  it("includes the voice system prompt", () => {
    const req = buildAnalysisRequest({
      campaigns: [SAMPLE_CAMPAIGN],
      voice,
      outputType: "analysis",
    });
    expect(req.system).toContain("Rad & Happy");
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
});
