import { describe, it, expect, vi } from "vitest";
import { parseMessage } from "@/worker/slack/router";
import { routeCommand, type ParsedCommand } from "@/worker/slack/router";
import { assembleVoicePrompt, type VoiceProfile } from "@/domain/voice/voice";
import { handleAdsReport, type AdsReportDeps } from "@/worker/slack/handlers/ads-report";
import { formatOrchestratorResult, formatGuardrailError, formatUnknownCommand } from "@/worker/slack/formatter";
import type { OrchestratorResult } from "@/ai/orchestrator";
import type { InsightRow } from "@/domain/meta/metrics";

const VOICE_PROFILE: VoiceProfile = {
  samples: [
    { id: "1", title: "Test", content: "So excited about planners!", tags: [] },
  ],
  rules: ["No vulgarity"],
  bannedWords: ["synergy", "delve"],
};

const MOCK_INSIGHTS: InsightRow[] = [
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
  {
    spendCents: 3000,
    impressions: 8000,
    clicks: 150,
    reach: 6000,
    purchases: 3,
    purchaseValueCents: 9000,
    addToCart: 20,
    initiateCheckout: 10,
  },
];

// ─── Slack formatter ──────────────────────────────────────────────────

describe("formatOrchestratorResult", () => {
  it("formats successful result as non-error Slack response", () => {
    const result: OrchestratorResult = {
      ok: true,
      text: "Your ads are performing well! ROAS is 3.0x.",
      inputTokens: 500,
      outputTokens: 100,
    };
    const response = formatOrchestratorResult(result);
    expect(response.isError).toBe(false);
    expect(response.text).toContain("3.0x");
  });

  it("formats guardrail failure as error with human-readable violations", () => {
    const result: OrchestratorResult = {
      ok: false,
      guardrailResult: {
        passed: false,
        violations: [
          { rule: "banned-word", detail: 'Output contains banned word: "synergy"' },
          { rule: "pii-detected", detail: "Output contains email address" },
        ],
      },
    };
    const response = formatOrchestratorResult(result);
    expect(response.isError).toBe(true);
    expect(response.text).toContain("blocked");
  });

  it("includes context label when provided", () => {
    const result: OrchestratorResult = {
      ok: true,
      text: "Looking good!",
      inputTokens: 100,
      outputTokens: 50,
    };
    const response = formatOrchestratorResult(result, "Ads Report");
    expect(response.text).toContain("Ads Report");
  });
});

describe("formatGuardrailError", () => {
  it("lists each violation in plain language", () => {
    const text = formatGuardrailError([
      { rule: "banned-word", detail: 'Contains "synergy"' },
      { rule: "pii-detected", detail: "Contains email address" },
    ]);
    expect(text).toContain("synergy");
    expect(text).toContain("email");
  });

  it("handles empty violations list", () => {
    const text = formatGuardrailError([]);
    expect(text).toBe("");
  });
});

describe("formatUnknownCommand", () => {
  it("returns a helpful error with the unrecognized input", () => {
    const response = formatUnknownCommand("!foobar stuff");
    expect(response.isError).toBe(true);
    expect(response.text).toContain("foobar");
  });
});

// ─── Full vertical slice ──────────────────────────────────────────────

describe("ads report: full flow", () => {
  it("parses → routes → computes → generates → formats", async () => {
    // Step 1: Parse Slack message
    const parsed = parseMessage("!ads report");
    expect(parsed.type).toBe("command");
    const cmd = parsed as ParsedCommand;

    // Step 2: Route to handler
    const route = routeCommand(cmd);
    expect(route.handler).toBe("meta:analysis");

    // Step 3: Set up dependencies with mocks
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    const deps: AdsReportDeps = {
      getInsightRows: vi.fn().mockResolvedValue(MOCK_INSIGHTS),
      getCampaignName: vi.fn().mockResolvedValue("Summer Sale"),
      runOrchestrator: vi.fn().mockResolvedValue({
        ok: true,
        text: "Your ads are doing great! The Summer Sale campaign has a 3x ROAS.",
        inputTokens: 800,
        outputTokens: 150,
      } satisfies OrchestratorResult),
      voice,
    };

    // Step 4: Run the handler
    const response = await handleAdsReport(deps, {
      dateRange: { start: "2025-06-01", end: "2025-06-30" },
    });

    // Step 5: Verify the response
    expect(response.isError).toBe(false);
    expect(response.text).toContain("3x ROAS");

    // Step 6: Verify the orchestrator was called with correct data
    const orchestratorCall = (deps.runOrchestrator as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(orchestratorCall.prompt).toContain("Summer Sale");
    expect(orchestratorCall.prompt).toContain("$80.00"); // total spend: 5000 + 3000 = 8000 cents = $80
    expect(orchestratorCall.system).toContain("Rad & Happy");

    // Step 7: Verify guardrails were configured for analysis (fabricated-stats OFF)
    expect(orchestratorCall.guardrails.checkFabricatedStats).toBe(false);
    expect(orchestratorCall.guardrails.checkPii).toBe(true);
  });

  it("returns error when orchestrator guardrails block the response", async () => {
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    const deps: AdsReportDeps = {
      getInsightRows: vi.fn().mockResolvedValue(MOCK_INSIGHTS),
      getCampaignName: vi.fn().mockResolvedValue("Summer Sale"),
      runOrchestrator: vi.fn().mockResolvedValue({
        ok: false,
        guardrailResult: {
          passed: false,
          violations: [
            { rule: "pii-detected", detail: "Output contains email address" },
          ],
        },
      } satisfies OrchestratorResult),
      voice,
    };

    const response = await handleAdsReport(deps, {
      dateRange: { start: "2025-06-01", end: "2025-06-30" },
    });

    expect(response.isError).toBe(true);
    expect(response.text).toContain("blocked");
  });

  it("handles empty insight data gracefully", async () => {
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    const deps: AdsReportDeps = {
      getInsightRows: vi.fn().mockResolvedValue([]),
      getCampaignName: vi.fn().mockResolvedValue("Summer Sale"),
      runOrchestrator: vi.fn().mockResolvedValue({
        ok: true,
        text: "No data available for this period.",
        inputTokens: 200,
        outputTokens: 20,
      } satisfies OrchestratorResult),
      voice,
    };

    const response = await handleAdsReport(deps, {
      dateRange: { start: "2025-06-01", end: "2025-06-30" },
    });

    expect(response.isError).toBe(false);
  });
});
