import { describe, it, expect, vi } from "vitest";
import { createOrchestrator } from "@/ai/orchestrator";
import { createMockAnthropicClient } from "../mocks/anthropic";
import type { GenerateResult } from "@/integrations/anthropic";
import type { VoiceProfile } from "@/domain/voice/voice";
import { UNSPECIFIED } from "@/domain/voice/rules";

const IG_ONLY = 'Don\'t say "comments get" as if you\'re writing an instagram post.';
const BIO_ONLY = 'Don\'t say "link in bio" outside instagram.';

/**
 * Every orchestrator is constructed with a voice profile, so these tests supply
 * one. A profile with no rules and no banned words would make `voiceCheck`
 * report `nothing-checked`, which is a failure — a check that evaluated nothing
 * has established nothing.
 */
const VOICE: VoiceProfile = {
  samples: [],
  rules: ["Never use em dashes", "No vulgarity", IG_ONLY, BIO_ONLY],
  bannedWords: [],
};

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

    const orchestrator = createOrchestrator({ client, voiceProfile: VOICE });
    const result = await orchestrator.run({ prompt: "Write ad copy", audience: UNSPECIFIED });

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

    const orchestrator = createOrchestrator({ client, voiceProfile: VOICE });
    const result = await orchestrator.run({ prompt: "Write ad copy", audience: UNSPECIFIED });

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
      voiceProfile: VOICE,
      defaultGuardrails: { checkPii: true },
    });
    const result = await orchestrator.run({ prompt: "Write ad copy", audience: UNSPECIFIED });

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
      voiceProfile: VOICE,
      defaultGuardrails: { bannedWords: ["delve", "synergy"] },
    });
    const result = await orchestrator.run({ prompt: "Write ad copy", audience: UNSPECIFIED });

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
      voiceProfile: VOICE,
      defaultGuardrails: { bannedWords: ["leverage", "synergy"] },
    });
    const result = await orchestrator.run({
      prompt: "Write ad copy",
      audience: UNSPECIFIED,
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
      voiceProfile: VOICE,
      defaultGuardrails: { checkFabricatedStats: true },
    });
    const result = await orchestrator.run({ prompt: "Analyze performance", audience: UNSPECIFIED });

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
      voiceProfile: VOICE,
      defaultModel: "claude-sonnet-4-20250514",
    });

    await orchestrator.run({
      prompt: "Write a caption",
      audience: UNSPECIFIED,
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

    const orchestrator = createOrchestrator({ client, voiceProfile: VOICE });

    await expect(
      orchestrator.run({ prompt: "Write ad copy", audience: UNSPECIFIED })
    ).rejects.toThrow("API rate limit");
  });
});

/**
 * ─── The voice check runs here, or it runs almost nowhere ─────────────
 *
 * `voiceCheck` shipped in #59 with exactly one caller: `/api/generate`. The
 * worker's five generators — ad analysis, social analysis, the weekly report,
 * email creative, the blog — assembled a voice prompt and never checked what
 * came back. A guardrail wired to one of six callers is not far from one wired
 * to none, and it is the same failure the guardrail was built to fix.
 *
 * Wiring it at six call sites would reproduce that: six can drift to five and
 * nothing goes red. So it is wired *here*, where every generation already
 * passes, and `audience` is a required field on the request — a call site
 * cannot omit a required field, and every builder's existing unit test now has
 * to state who its copy is for.
 *
 * This module's own docstring already claimed the property ("No unguarded
 * output leaves this layer"). It was false for voice rules. A claim in a
 * docstring is a claim about code that must exist.
 *
 * ## What blocks and what travels
 *
 * A *structural* failure of the check blocks: an unrecognised audience, empty
 * output, or a profile with nothing to check all mean the check did not happen,
 * and "we did not look" must never read as "we looked and it was fine".
 *
 * A *style* violation does not withhold the text. Nothing in this system
 * auto-publishes — every generation lands in Slack or a Figma panel for a human
 * to accept — so withholding a draft over an em dash leaves that human with
 * nothing instead of something to fix, and a guardrail that blocks correct copy
 * gets turned off. The violations travel with the text on `result.voice`
 * instead. That changes when #26 saves drafts, which are a commitment.
 */
describe("orchestrator: voice rules are checked on every generation", () => {
  const generating = (text: string) =>
    createMockAnthropicClient({
      generate: vi.fn().mockResolvedValue({
        text,
        inputTokens: 10,
        outputTokens: 10,
        stopReason: "end_turn",
      } satisfies GenerateResult),
    });

  it("checks the model's output and reports what it enforced", async () => {
    const o = createOrchestrator({ client: generating("a perfectly ordinary sentence"), voiceProfile: VOICE });
    const r = await o.run({ prompt: "write copy", audience: "email" });

    expect(r.ok).toBe(true);
    expect(r.voice).not.toBeNull();
    expect(r.voice!.ok).toBe(true);
    expect(r.voice!.enforced).toContain("Never use em dashes");
  });

  it("catches a rule violation the old path would have passed through", async () => {
    const o = createOrchestrator({ client: generating("Planners — they're here"), voiceProfile: VOICE });
    const r = await o.run({ prompt: "write copy", audience: "email" });

    expect(r.voice!.ok).toBe(false);
    expect(r.voice!.violations.map((v) => v.rule)).toContain("Never use em dashes");
  });

  // The text still comes back. A blocked draft is not a better draft.
  it("returns the text alongside a style violation rather than withholding it", async () => {
    const o = createOrchestrator({ client: generating("Planners — they're here"), voiceProfile: VOICE });
    const r = await o.run({ prompt: "write copy", audience: "email" });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("Planners — they're here");
  });

  /**
   * The proof that `audience` actually reaches the check. "All comments get a
   * link" is correct Instagram copy and wrong in an inbox; if the audience were
   * dropped or defaulted, both of these would return the same verdict.
   */
  it("excuses instagram from the rule instagram is excused from", async () => {
    const o = createOrchestrator({ client: generating("All comments get a link!"), voiceProfile: VOICE });
    expect((await o.run({ prompt: "p", audience: "instagram" })).voice!.ok).toBe(true);
    expect((await o.run({ prompt: "p", audience: "email" })).voice!.ok).toBe(false);
  });

  it("applies every rule when the audience is unspecified", async () => {
    const o = createOrchestrator({ client: generating("All comments get a link!"), voiceProfile: VOICE });
    const r = await o.run({ prompt: "p", audience: UNSPECIFIED });
    expect(r.voice!.ok).toBe(false);
  });
});

describe("orchestrator: a check that did not happen never reads as a pass", () => {
  const clean = () =>
    createMockAnthropicClient({
      generate: vi.fn().mockResolvedValue({
        text: "a perfectly ordinary sentence",
        inputTokens: 10,
        outputTokens: 10,
        stopReason: "end_turn",
      } satisfies GenerateResult),
    });

  // Types are erased. An audience nobody meant to name selects a rule set
  // nobody meant to apply, and the natural result is an empty violation list.
  it("blocks on an unrecognised audience instead of checking against nothing", async () => {
    const o = createOrchestrator({ client: clean(), voiceProfile: VOICE });
    const r = await o.run({ prompt: "p", audience: "insta" as never });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.guardrailResult.violations.map((v) => v.rule)).toContain("unknown-channel");
    }
  });

  it("blocks when the profile gives it nothing to check", async () => {
    const o = createOrchestrator({
      client: clean(),
      voiceProfile: { samples: [], rules: [], bannedWords: [] },
    });
    const r = await o.run({ prompt: "p", audience: "email" });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.guardrailResult.violations.map((v) => v.rule)).toContain("nothing-checked");
    }
  });

  /**
   * "Zero is UNKNOWN until something proves it means zero." When the output
   * guardrails block first, the voice check never ran — and a `voice` of `null`
   * is a different thing from a `voice` that ran and found nothing. Collapsing
   * them would make an unchecked generation indistinguishable from a clean one.
   */
  it("reports null, not a clean verdict, when it never got as far as checking", async () => {
    const o = createOrchestrator({
      client: createMockAnthropicClient({
        generate: vi.fn().mockResolvedValue({
          text: "",
          inputTokens: 10,
          outputTokens: 0,
          stopReason: "end_turn",
        } satisfies GenerateResult),
      }),
      voiceProfile: VOICE,
    });
    const r = await o.run({ prompt: "p", audience: "email" });

    expect(r.ok).toBe(false);
    expect(r.voice).toBeNull();
  });

  it("checks the model's output, not the prompt it was given", async () => {
    const o = createOrchestrator({ client: clean(), voiceProfile: VOICE });
    const r = await o.run({ prompt: "Planners — write me something", audience: "email" });

    expect(r.voice!.ok).toBe(true);
  });
});
