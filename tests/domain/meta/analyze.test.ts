import { describe, it, expect, vi } from "vitest";
import { analyzeAdPerformance, type AnalyzeDeps } from "@/domain/meta/analyze";
import { assembleVoicePrompt, type VoiceProfile } from "@/domain/voice/voice";
import type { OrchestratorResult } from "@/ai/orchestrator";

const VOICE_PROFILE: VoiceProfile = {
  samples: [
    { id: "1", title: "Test", content: "So excited about planners!", tags: [] },
  ],
  rules: [],
  bannedWords: ["synergy"],
};

/**
 * Mock the DB to return canned insight data.
 * We mock getInsightsByCampaign at the module level since
 * analyzeAdPerformance calls it internally.
 */
vi.mock("@/domain/meta/queries", () => ({
  getInsightsByCampaign: vi.fn(),
}));

import { getInsightsByCampaign } from "@/domain/meta/queries";
const mockGetInsights = vi.mocked(getInsightsByCampaign);

function makeDeps(
  orchestratorResponse: OrchestratorResult
): AnalyzeDeps {
  return {
    db: {} as AnalyzeDeps["db"], // queries are mocked
    voice: assembleVoicePrompt(VOICE_PROFILE),
    runOrchestrator: vi.fn().mockResolvedValue(orchestratorResponse),
  };
}

describe("analyzeAdPerformance", () => {
  it("returns no-data message when DB has no insights", async () => {
    mockGetInsights.mockResolvedValue([]);

    const deps = makeDeps({
      ok: true,
      text: "unused",
      inputTokens: 0,
      outputTokens: 0,
    });

    const result = await analyzeAdPerformance(deps, 7);

    expect(result.ok).toBe(true);
    expect(result.text).toContain("No ad data");
    expect(result.campaignCount).toBe(0);
    // Orchestrator should NOT be called when there's no data
    expect(deps.runOrchestrator).not.toHaveBeenCalled();
  });

  it("queries DB, computes metrics, calls orchestrator, returns analysis", async () => {
    mockGetInsights.mockResolvedValue([
      {
        campaignId: "camp_1",
        campaignName: "Summer Sale",
        rows: [
          {
            spendCents: 5000,
            impressions: 10000,
            clicks: 200,
            reach: 8000,
            purchases: 5,
            purchaseValueCents: 15000,
            addToCart: 30,
            initiateCheckout: 15,
          },
        ],
      },
    ]);

    const deps = makeDeps({
      ok: true,
      text: "Your Summer Sale campaign is performing well with a 3.0x ROAS.",
      inputTokens: 800,
      outputTokens: 100,
    });

    const result = await analyzeAdPerformance(deps, 7);

    expect(result.ok).toBe(true);
    expect(result.text).toContain("3.0x ROAS");
    expect(result.campaignCount).toBe(1);

    // Verify orchestrator was called with correct prompt content
    const call = (deps.runOrchestrator as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.prompt).toContain("Summer Sale");
    expect(call.prompt).toContain("$50.00"); // spend in dollars
    expect(call.prompt).toContain("$150.00"); // revenue
    expect(call.system).toContain("Rad & Happy");
    // Analysis output: fabricated-stats OFF
    expect(call.guardrails.checkFabricatedStats).toBe(false);
  });

  it("handles multiple campaigns", async () => {
    mockGetInsights.mockResolvedValue([
      {
        campaignId: "camp_1",
        campaignName: "Summer Sale",
        rows: [
          {
            spendCents: 5000, impressions: 10000, clicks: 200,
            reach: 8000, purchases: 5, purchaseValueCents: 15000,
            addToCart: 30, initiateCheckout: 15,
          },
        ],
      },
      {
        campaignId: "camp_2",
        campaignName: "Fall Collection",
        rows: [
          {
            spendCents: 3000, impressions: 8000, clicks: 150,
            reach: 6000, purchases: 3, purchaseValueCents: 9000,
            addToCart: 20, initiateCheckout: 10,
          },
        ],
      },
    ]);

    const deps = makeDeps({
      ok: true,
      text: "Both campaigns are performing well.",
      inputTokens: 1000,
      outputTokens: 150,
    });

    const result = await analyzeAdPerformance(deps, 7);

    expect(result.campaignCount).toBe(2);
    const call = (deps.runOrchestrator as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.prompt).toContain("Summer Sale");
    expect(call.prompt).toContain("Fall Collection");
  });

  it("returns guardrail error when orchestrator blocks", async () => {
    mockGetInsights.mockResolvedValue([
      {
        campaignId: "camp_1",
        campaignName: "Test",
        rows: [
          {
            spendCents: 1000, impressions: 100, clicks: 10,
            reach: 80, purchases: 1, purchaseValueCents: 3000,
            addToCart: 5, initiateCheckout: 3,
          },
        ],
      },
    ]);

    const deps = makeDeps({
      ok: false,
      guardrailResult: {
        passed: false,
        violations: [
          { rule: "pii-detected", detail: "Output contains email address" },
        ],
      },
    });

    const result = await analyzeAdPerformance(deps, 7);

    expect(result.ok).toBe(false);
    expect(result.text).toContain("blocked");
    expect(result.text).toContain("email address");
  });

  it("sets correct date range based on lookback days", async () => {
    mockGetInsights.mockResolvedValue([]);

    const deps = makeDeps({
      ok: true, text: "", inputTokens: 0, outputTokens: 0,
    });

    const result = await analyzeAdPerformance(deps, 30);

    expect(result.dateRange.start).toBeDefined();
    expect(result.dateRange.end).toBeDefined();
    // 30-day lookback should produce dates ~30 days apart
    const start = new Date(result.dateRange.start);
    const end = new Date(result.dateRange.end);
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(31);
  });
});
