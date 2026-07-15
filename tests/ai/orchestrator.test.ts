import { describe, it, expect, vi } from "vitest";
import { createOrchestrator } from "@/ai/orchestrator";
import { createMockAnthropicClient } from "../mocks/anthropic";
import type { GenerateResult } from "@/integrations/anthropic";

describe("orchestrator: guardrail enforcement", () => {
  it("returns ok:true when model output passes guardrails", async () => {
    const client = createMockAnthropicClient({
      generate: vi.fn().mockResolvedValue({
        text: "Check out our new planner collection!",
        inputTokens: 100,
        outputTokens: 20,
        stopReason: "end_turn",
      } satisfies GenerateResult),
    });

    const orchestrator = createOrchestrator({ client });
    const result = await orchestrator.run({ prompt: "Write ad copy" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("Check out our new planner collection!");
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(20);
    }
  });

  it("returns ok:false when model returns empty output", async () => {
    const client = createMockAnthropicClient({
      generate: vi.fn().mockResolvedValue({
        text: "",
        inputTokens: 100,
        outputTokens: 0,
        stopReason: "end_turn",
      } satisfies GenerateResult),
    });

    const orchestrator = createOrchestrator({ client });
    const result = await orchestrator.run({ prompt: "Write ad copy" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.guardrailResult.violations).toContainEqual(
        expect.objectContaining({ rule: "empty-output" })
      );
    }
  });

  it("blocks model output containing PII when checkPii is enabled", async () => {
    const client = createMockAnthropicClient({
      generate: vi.fn().mockResolvedValue({
        text: "Email tara@radandhappy.com for your discount!",
        inputTokens: 100,
        outputTokens: 15,
        stopReason: "end_turn",
      } satisfies GenerateResult),
    });

    const orchestrator = createOrchestrator({
      client,
      defaultGuardrails: { checkPii: true },
    });
    const result = await orchestrator.run({ prompt: "Write ad copy" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.guardrailResult.violations).toContainEqual(
        expect.objectContaining({ rule: "pii-detected" })
      );
    }
  });

  it("blocks model output with banned words via default guardrails", async () => {
    const client = createMockAnthropicClient({
      generate: vi.fn().mockResolvedValue({
        text: "Let's delve into the synergy of our product line.",
        inputTokens: 100,
        outputTokens: 15,
        stopReason: "end_turn",
      } satisfies GenerateResult),
    });

    const orchestrator = createOrchestrator({
      client,
      defaultGuardrails: { bannedWords: ["delve", "synergy"] },
    });
    const result = await orchestrator.run({ prompt: "Write ad copy" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const rules = result.guardrailResult.violations.map((v) => v.rule);
      expect(rules).toContain("banned-word");
    }
  });

  it("per-request guardrails merge with defaults", async () => {
    const client = createMockAnthropicClient({
      generate: vi.fn().mockResolvedValue({
        text: "Email tara@radandhappy.com to leverage our synergy!",
        inputTokens: 100,
        outputTokens: 15,
        stopReason: "end_turn",
      } satisfies GenerateResult),
    });

    const orchestrator = createOrchestrator({
      client,
      defaultGuardrails: { bannedWords: ["leverage", "synergy"] },
    });
    const result = await orchestrator.run({
      prompt: "Write ad copy",
      guardrails: { checkPii: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const rules = result.guardrailResult.violations.map((v) => v.rule);
      // Both default (banned-word) and per-request (pii) should fire
      expect(rules).toContain("banned-word");
      expect(rules).toContain("pii-detected");
    }
  });

  it("blocks fabricated statistics in model output", async () => {
    const client = createMockAnthropicClient({
      generate: vi.fn().mockResolvedValue({
        text: "Our campaigns achieved a 4.7x ROAS last quarter with $127,500 in revenue.",
        inputTokens: 100,
        outputTokens: 20,
        stopReason: "end_turn",
      } satisfies GenerateResult),
    });

    const orchestrator = createOrchestrator({
      client,
      defaultGuardrails: { checkFabricatedStats: true },
    });
    const result = await orchestrator.run({ prompt: "Analyze performance" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.guardrailResult.violations).toContainEqual(
        expect.objectContaining({ rule: "fabricated-stat" })
      );
    }
  });

  it("passes system prompt and options to the client", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: "Clean output here.",
      inputTokens: 200,
      outputTokens: 10,
      stopReason: "end_turn",
    } satisfies GenerateResult);

    const client = createMockAnthropicClient({ generate });
    const orchestrator = createOrchestrator({
      client,
      defaultModel: "claude-sonnet-4-20250514",
    });

    await orchestrator.run({
      prompt: "Write a caption",
      system: "You are a brand voice assistant.",
      maxTokens: 500,
      temperature: 0.7,
    });

    expect(generate).toHaveBeenCalledWith("Write a caption", {
      model: "claude-sonnet-4-20250514",
      system: "You are a brand voice assistant.",
      maxTokens: 500,
      temperature: 0.7,
    });
  });

  it("returns ok:false when model throws, not an unhandled crash", async () => {
    const client = createMockAnthropicClient({
      generate: vi.fn().mockRejectedValue(new Error("API rate limit")),
    });

    const orchestrator = createOrchestrator({ client });

    await expect(
      orchestrator.run({ prompt: "Write ad copy" })
    ).rejects.toThrow("API rate limit");
  });
});
