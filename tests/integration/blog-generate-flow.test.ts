import { describe, it, expect, vi } from "vitest";
import { parseMessage, routeCommand, type ParsedCommand } from "@/worker/slack/router";
import { assembleVoicePrompt, type VoiceProfile } from "@/domain/voice/voice";
import { handleBlogGenerate, type BlogGenerateDeps } from "@/worker/slack/handlers/blog-generate";
import { AI_WRITING_BANNED_WORDS } from "@/domain/blog/ai-writing-rules";
import type { OrchestratorResult } from "@/ai/orchestrator";

const VOICE_PROFILE: VoiceProfile = {
  samples: [
    { id: "1", title: "Test", content: "So excited about planners!", tags: [] },
  ],
  rules: ["No vulgarity"],
  bannedWords: ["shenanigans"],
};

const MOCK_ARTICLE = `<h2>10 Ways to Use Your Planner for Meal Planning</h2>
<p>Here's the thing about meal planning — it doesn't have to be complicated.</p>
<p>Grab your planner, flip to this week, and let's figure out dinner.</p>`;

// ─── Routing ──────────────────────────────────────────────────────────

describe("blog generate: routing", () => {
  it("parses '!blog create meal planning tips' correctly", () => {
    const parsed = parseMessage("!blog create meal planning tips");
    expect(parsed.type).toBe("command");
    const cmd = parsed as ParsedCommand;
    expect(cmd.category).toBe("blog");
    expect(cmd.action).toBe("create");
    expect(cmd.args).toBe("meal planning tips");
  });

  it("routes to blog:create handler", () => {
    const parsed = parseMessage("!blog create") as ParsedCommand;
    const route = routeCommand(parsed);
    expect(route.handler).toBe("blog:create");
  });
});

// ─── Full vertical slice ──────────────────────────────────────────────

describe("blog generate: full flow", () => {
  it("selects topic → builds prompt with AI-writing rules → generates → formats", async () => {
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    const deps: BlogGenerateDeps = {
      getNextTopic: vi.fn().mockResolvedValue({
        title: "10 Ways to Use Your Planner for Meal Planning",
        description: "SEO article targeting 'planner meal planning'",
        tags: ["planning", "meals"],
      }),
      getBrandContext: vi.fn().mockResolvedValue(
        "We focus on minimalist design and functional products."
      ),
      runOrchestrator: vi.fn().mockResolvedValue({
        ok: true,
        text: MOCK_ARTICLE,
        inputTokens: 2000,
        outputTokens: 800,
      } satisfies OrchestratorResult),
      voice,
    };

    const response = await handleBlogGenerate(deps, {});

    expect(response.isError).toBe(false);
    expect(response.text).toContain("Meal Planning");

    // Verify orchestrator received correct data
    const call = (deps.runOrchestrator as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Prompt should contain topic
    expect(call.prompt).toContain("10 Ways to Use Your Planner");
    expect(call.prompt).toContain("planner meal planning");

    // System prompt should have voice AND AI-writing avoidance
    expect(call.system).toContain("Rad & Happy");
    expect(call.system).toContain("AI Writing Avoidance");
    expect(call.system).toContain("No filler transitions");

    // Brand context should be in the prompt
    expect(call.prompt).toContain("minimalist design");

    // Guardrails must include AI-writing banned words
    expect(call.guardrails.bannedWords).toContain("delve");
    expect(call.guardrails.bannedWords).toContain("tapestry");
    expect(call.guardrails.bannedWords).toContain("furthermore");
    // Plus the voice-specific banned word
    expect(call.guardrails.bannedWords).toContain("shenanigans");
    // Fabricated stats ON for blog (creative content)
    expect(call.guardrails.checkFabricatedStats).toBe(true);
  });

  it("uses topic override from Slack command when provided", async () => {
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    const deps: BlogGenerateDeps = {
      getNextTopic: vi.fn(), // should NOT be called
      getBrandContext: vi.fn().mockResolvedValue("Brand context."),
      runOrchestrator: vi.fn().mockResolvedValue({
        ok: true,
        text: MOCK_ARTICLE,
        inputTokens: 1000,
        outputTokens: 500,
      } satisfies OrchestratorResult),
      voice,
    };

    await handleBlogGenerate(deps, { topic: "Best Pens for Journaling" });

    // getNextTopic should not be called when topic is provided
    expect(deps.getNextTopic).not.toHaveBeenCalled();

    const call = (deps.runOrchestrator as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.prompt).toContain("Best Pens for Journaling");
  });

  it("returns helpful message when no topics are pending", async () => {
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    const deps: BlogGenerateDeps = {
      getNextTopic: vi.fn().mockResolvedValue(null),
      getBrandContext: vi.fn(),
      runOrchestrator: vi.fn(),
      voice,
    };

    const response = await handleBlogGenerate(deps, {});

    expect(response.isError).toBe(false);
    expect(response.text.toLowerCase()).toMatch(/no.*topic/);
    // Should NOT call the orchestrator if there's nothing to generate
    expect(deps.runOrchestrator).not.toHaveBeenCalled();
  });

  it("returns error when orchestrator blocks (AI-sounding content)", async () => {
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    const deps: BlogGenerateDeps = {
      getNextTopic: vi.fn().mockResolvedValue({
        title: "Test Topic",
      }),
      getBrandContext: vi.fn().mockResolvedValue(""),
      runOrchestrator: vi.fn().mockResolvedValue({
        ok: false,
        guardrailResult: {
          passed: false,
          violations: [
            { rule: "banned-word", detail: 'Output contains banned word: "delve"' },
          ],
        },
      } satisfies OrchestratorResult),
      voice,
    };

    const response = await handleBlogGenerate(deps, {});
    expect(response.isError).toBe(true);
    expect(response.text).toContain("blocked");
  });
});

// ─── Three-way guardrail cross-check ──────────────────────────────────

describe("guardrail config three-way cross-check", () => {
  it("ads, email, and blog all have distinct guardrail configs", async () => {
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    const captureCalls = () => {
      const calls: Record<string, unknown>[] = [];
      return {
        calls,
        fn: vi.fn().mockImplementation((req: Record<string, unknown>) => {
          calls.push(req);
          return { ok: true, text: '{"subjectLine":"test"}', inputTokens: 100, outputTokens: 10 };
        }),
      };
    };

    // Run all three handlers
    const { handleAdsReport } = await import("@/worker/slack/handlers/ads-report");
    const { handleEmailDesign } = await import("@/worker/slack/handlers/email-design");

    const adsCapture = captureCalls();
    const emailCapture = captureCalls();
    const blogCapture = captureCalls();

    await handleAdsReport(
      {
        getInsightRows: vi.fn().mockResolvedValue([{
          spendCents: 1000, impressions: 100, clicks: 10, reach: 80,
          purchases: 1, purchaseValueCents: 3000, addToCart: 5, initiateCheckout: 3,
        }]),
        getCampaignName: vi.fn().mockResolvedValue("Test"),
        runOrchestrator: adsCapture.fn,
        voice,
      },
      { dateRange: { start: "2025-06-01", end: "2025-06-30" } }
    );

    await handleEmailDesign(
      {
        getProducts: vi.fn().mockResolvedValue([{
          title: "Planner", description: "A planner", priceCents: 2999,
        }]),
        runOrchestrator: emailCapture.fn,
        voice,
      },
      { brief: "test" }
    );

    await handleBlogGenerate(
      {
        getNextTopic: vi.fn().mockResolvedValue({ title: "Test" }),
        getBrandContext: vi.fn().mockResolvedValue(""),
        runOrchestrator: blogCapture.fn,
        voice,
      },
      {}
    );

    const adsG = (adsCapture.calls[0] as { guardrails: Record<string, unknown> }).guardrails;
    const emailG = (emailCapture.calls[0] as { guardrails: Record<string, unknown> }).guardrails;
    const blogG = (blogCapture.calls[0] as { guardrails: Record<string, unknown> }).guardrails;

    // Fabricated stats: OFF for analysis, ON for creative/blog
    expect(adsG.checkFabricatedStats).toBe(false);
    expect(emailG.checkFabricatedStats).toBe(true);
    expect(blogG.checkFabricatedStats).toBe(true);

    // JSON: only email requires it
    expect(emailG.expectJson).toBe(true);
    expect(adsG.expectJson).toBeUndefined();
    expect(blogG.expectJson).toBeUndefined();

    // AI-writing words: only blog has them
    const blogBanned = blogG.bannedWords as string[];
    const adsBanned = adsG.bannedWords as string[];
    expect(blogBanned).toContain("tapestry");
    expect(blogBanned).toContain("furthermore");
    expect(adsBanned).not.toContain("tapestry");
    expect(adsBanned).not.toContain("furthermore");

    // All three have PII check
    expect(adsG.checkPii).toBe(true);
    expect(emailG.checkPii).toBe(true);
    expect(blogG.checkPii).toBe(true);
  });
});
