import { describe, it, expect, vi } from "vitest";
import { generateEmailCreative, type EmailGenerateDeps } from "@/domain/email/generate";
import { assembleVoicePrompt, type VoiceProfile } from "@/domain/voice/voice";
import type { OrchestratorResult } from "@/ai/orchestrator";

const VOICE_PROFILE: VoiceProfile = {
  samples: [
    { id: "1", title: "Test", content: "So excited about planners!", tags: [] },
  ],
  rules: [],
  bannedWords: ["synergy"],
};

// Mock the DB product query
vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal();
  return actual;
});

describe("generateEmailCreative", () => {
  it("generates creative through the orchestrator", async () => {
    const validJson = JSON.stringify({
      subjectLine: "Summer planners are here!",
      previewText: "New arrivals",
      headline: "Plan Your Summer",
      bodyCopy: "Our new collection just dropped.",
      ctaText: "Shop Now",
      ctaUrl: "https://radandhappy.com",
      altText: "Summer planner collection",
      imageTemplateData: {},
    });

    const deps: EmailGenerateDeps = {
      db: {
        selectDistinctOn: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as unknown as EmailGenerateDeps["db"],
      voice: assembleVoicePrompt(VOICE_PROFILE),
      runOrchestrator: vi.fn().mockResolvedValue({
        ok: true,
        text: validJson,
        inputTokens: 500,
        outputTokens: 200,
      } satisfies OrchestratorResult),
    };

    const result = await generateEmailCreative(deps, "summer sale promo");

    expect(result.ok).toBe(true);
    expect(result.text).toContain("Summer planners");
    expect(result.brief).toBe("summer sale promo");

    // Verify orchestrator was called
    const call = (deps.runOrchestrator as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.prompt).toContain("summer sale promo");
    expect(call.guardrails.expectJson).toBe(true);
    expect(call.guardrails.checkFabricatedStats).toBe(true);
  });

  it("returns error when orchestrator blocks", async () => {
    const deps: EmailGenerateDeps = {
      db: {
        selectDistinctOn: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as unknown as EmailGenerateDeps["db"],
      voice: assembleVoicePrompt(VOICE_PROFILE),
      runOrchestrator: vi.fn().mockResolvedValue({
        ok: false,
        guardrailResult: {
          passed: false,
          violations: [{ rule: "invalid-json", detail: "Output is not valid JSON" }],
        },
      } satisfies OrchestratorResult),
    };

    const result = await generateEmailCreative(deps, "test");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("blocked");
    expect(result.text).toContain("JSON");
  });
});
