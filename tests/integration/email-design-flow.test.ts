import { describe, it, expect, vi } from "vitest";
import { parseMessage, routeCommand, type ParsedCommand } from "@/worker/slack/router";
import { assembleVoicePrompt, type VoiceProfile } from "@/domain/voice/voice";
import { handleEmailDesign, type EmailDesignDeps } from "@/worker/slack/handlers/email-design";
import type { OrchestratorResult } from "@/ai/orchestrator";
import type { ProductInfo } from "@/domain/email/creative";

const VOICE_PROFILE: VoiceProfile = {
  samples: [
    { id: "1", title: "Test", content: "So excited about planners!", tags: [] },
  ],
  rules: ["No vulgarity"],
  bannedWords: ["synergy", "delve"],
};

const MOCK_PRODUCTS: ProductInfo[] = [
  {
    title: "Daily Planner - Rose Gold",
    description: "Our best-selling planner.",
    priceCents: 2999,
    imageUrl: "https://cdn.radandhappy.com/planner-rg.jpg",
    productType: "Planner",
  },
  {
    title: "Mindful Coloring Book",
    description: "36 hand-drawn illustrations.",
    priceCents: 1499,
    productType: "Coloring Book",
  },
];

const VALID_CREATIVE_JSON = JSON.stringify({
  subjectLine: "Summer is here and so are our planners!",
  previewText: "New arrivals you'll love",
  headline: "Plan Your Best Summer Yet",
  bodyCopy: "Our new collection just dropped and it's so good.",
  ctaText: "Shop Now",
  ctaUrl: "https://radandhappy.com/collections/summer",
  altText: "Rad & Happy summer planner collection with rose gold daily planner",
  imageTemplateData: {
    headline: "Plan Your Best Summer Yet",
    subheadline: "New arrivals",
    ctaText: "Shop Now",
    heroImageUrl: "https://cdn.radandhappy.com/planner-rg.jpg",
  },
});

// ─── Routing ──────────────────────────────────────────────────────────

describe("email design: routing", () => {
  it("parses '!email design summer sale' correctly", () => {
    const parsed = parseMessage("!email design summer sale");
    expect(parsed.type).toBe("command");
    const cmd = parsed as ParsedCommand;
    expect(cmd.category).toBe("email");
    expect(cmd.action).toBe("design");
    expect(cmd.args).toBe("summer sale");
  });

  it("routes to email:design handler", () => {
    const parsed = parseMessage("!email design summer sale") as ParsedCommand;
    const route = routeCommand(parsed);
    expect(route.handler).toBe("email:design");
    expect(route.params.brief).toBe("summer sale");
  });
});

// ─── Full vertical slice ──────────────────────────────────────────────

describe("email design: full flow", () => {
  it("parses → routes → fetches products → builds prompt → generates → formats", async () => {
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    const deps: EmailDesignDeps = {
      getProducts: vi.fn().mockResolvedValue(MOCK_PRODUCTS),
      runOrchestrator: vi.fn().mockResolvedValue({
        ok: true,
        text: VALID_CREATIVE_JSON,
        inputTokens: 1000,
        outputTokens: 300,
      } satisfies OrchestratorResult),
      voice,
    };

    const response = await handleEmailDesign(deps, {
      brief: "summer sale promo",
    });

    // Response should be successful
    expect(response.isError).toBe(false);
    expect(response.text).toContain("Summer is here");

    // Verify orchestrator was called with correct config
    const call = (deps.runOrchestrator as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Prompt should contain product data
    expect(call.prompt).toContain("Daily Planner - Rose Gold");
    expect(call.prompt).toContain("$29.99");
    expect(call.prompt).toContain("summer sale promo");

    // System prompt should have voice
    expect(call.system).toContain("Rad & Happy");

    // Guardrails must be set for CREATIVE output (opposite of analysis)
    expect(call.guardrails.checkFabricatedStats).toBe(true);
    expect(call.guardrails.checkPii).toBe(true);
    expect(call.guardrails.expectJson).toBe(true);
    expect(call.guardrails.bannedWords).toContain("synergy");
  });

  it("includes discount info when provided", async () => {
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    const deps: EmailDesignDeps = {
      getProducts: vi.fn().mockResolvedValue(MOCK_PRODUCTS),
      runOrchestrator: vi.fn().mockResolvedValue({
        ok: true,
        text: VALID_CREATIVE_JSON,
        inputTokens: 1000,
        outputTokens: 300,
      } satisfies OrchestratorResult),
      voice,
    };

    await handleEmailDesign(deps, {
      brief: "summer sale",
      discount: { code: "SUMMER25", percentOff: 25 },
    });

    const call = (deps.runOrchestrator as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.prompt).toContain("SUMMER25");
    expect(call.prompt).toContain("25%");
  });

  it("returns error when orchestrator blocks (e.g. invalid JSON from model)", async () => {
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    const deps: EmailDesignDeps = {
      getProducts: vi.fn().mockResolvedValue(MOCK_PRODUCTS),
      runOrchestrator: vi.fn().mockResolvedValue({
        ok: false,
        guardrailResult: {
          passed: false,
          violations: [
            { rule: "invalid-json", detail: "Output is not valid JSON" },
          ],
        },
      } satisfies OrchestratorResult),
      voice,
    };

    const response = await handleEmailDesign(deps, { brief: "test" });
    expect(response.isError).toBe(true);
    expect(response.text).toContain("blocked");
  });
});

// ─── Cross-check: ads vs email guardrail configs are opposites ────────

describe("guardrail config cross-check: ads vs email", () => {
  it("ads report uses fabricated-stats OFF, email uses ON", async () => {
    const voice = assembleVoicePrompt(VOICE_PROFILE);

    // Capture what each handler sends to the orchestrator
    const adsCalls: unknown[] = [];
    const emailCalls: unknown[] = [];

    // Import ads handler
    const { handleAdsReport } = await import("@/worker/slack/handlers/ads-report");

    const adsDeps = {
      getInsightRows: vi.fn().mockResolvedValue([{
        spendCents: 1000, impressions: 100, clicks: 10, reach: 80,
        purchases: 1, purchaseValueCents: 3000, addToCart: 5, initiateCheckout: 3,
      }]),
      getCampaignName: vi.fn().mockResolvedValue("Test"),
      runOrchestrator: vi.fn().mockImplementation((req: unknown) => {
        adsCalls.push(req);
        return { ok: true, text: "OK", inputTokens: 100, outputTokens: 10 };
      }),
      voice,
    };

    const emailDeps: EmailDesignDeps = {
      getProducts: vi.fn().mockResolvedValue(MOCK_PRODUCTS),
      runOrchestrator: vi.fn().mockImplementation((req: unknown) => {
        emailCalls.push(req);
        return { ok: true, text: VALID_CREATIVE_JSON, inputTokens: 100, outputTokens: 10 };
      }),
      voice,
    };

    await handleAdsReport(adsDeps, { dateRange: { start: "2025-06-01", end: "2025-06-30" } });
    await handleEmailDesign(emailDeps, { brief: "test" });

    const adsGuardrails = (adsCalls[0] as { guardrails: Record<string, unknown> }).guardrails;
    const emailGuardrails = (emailCalls[0] as { guardrails: Record<string, unknown> }).guardrails;

    // These MUST be opposite
    expect(adsGuardrails.checkFabricatedStats).toBe(false);
    expect(emailGuardrails.checkFabricatedStats).toBe(true);

    // Both must have PII on
    expect(adsGuardrails.checkPii).toBe(true);
    expect(emailGuardrails.checkPii).toBe(true);

    // Email must require JSON, ads must not
    expect(emailGuardrails.expectJson).toBe(true);
    expect(adsGuardrails.expectJson).toBeUndefined();
  });
});
