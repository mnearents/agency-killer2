import { describe, it, expect } from "vitest";
import {
  buildWeeklyReportRequest,
  type WeeklyReportInput,
} from "@/domain/report/weekly-analysis";
import type { VoicePromptResult } from "@/domain/voice/voice";

const mockVoice: VoicePromptResult = {
  systemPrompt: "You are a brand voice assistant.",
  guardrailOptions: {
    bannedWords: ["synergy"],
    checkPii: true,
    checkFabricatedStats: false,
  },
};

function makeInput(overrides: Partial<WeeklyReportInput> = {}): WeeklyReportInput {
  return {
    dataBlock: "# Weekly Performance: Jul 28 – Aug 3\n\n## Meta Ads\nSpend: $450\n\n## Shopify\n120 orders\n\n## Organic Social\n8 posts",
    voice: mockVoice,
    ...overrides,
  };
}

describe("buildWeeklyReportRequest", () => {
  it("builds an orchestrator request with the data block and system prompt", () => {
    const request = buildWeeklyReportRequest(makeInput());

    expect(request.prompt).toContain("Jul 28 – Aug 3");
    expect(request.prompt).toContain("$450");
    expect(request.system).toContain("marketing strategist");
    expect(request.system).toContain(mockVoice.systemPrompt);
  });

  it("disables fabricated stats check since we feed real numbers", () => {
    const request = buildWeeklyReportRequest(makeInput());

    expect(request.guardrails?.checkFabricatedStats).toBe(false);
  });

  it("includes KB context when provided", () => {
    const request = buildWeeklyReportRequest(makeInput({
      kbContext: "Meeting notes: Tara wants to push the planner refill kits this month.",
    }));

    expect(request.prompt).toContain("planner refill kits");
  });

  it("includes previous week highlights when provided", () => {
    const request = buildWeeklyReportRequest(makeInput({
      previousWeekHighlights: "Last week we noted the UGC reel style was outperforming studio shots.",
    }));

    expect(request.prompt).toContain("UGC reel style");
  });

  it("system prompt covers all required sections", () => {
    const request = buildWeeklyReportRequest(makeInput());
    const system = request.system!;

    // Should instruct Claude to cover these areas
    expect(system).toContain("worked");
    expect(system).toContain("trend");
    expect(system).toContain("coming week");
    expect(system).toContain("across channels");
  });
});
