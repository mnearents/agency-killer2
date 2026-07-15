import { describe, it, expect } from "vitest";
import {
  buildEmailCreativeRequest,
  formatProductBlock,
  buildEmailGuardrails,
  type EmailBrief,
  type ProductInfo,
} from "@/domain/email/creative";
import { assembleVoicePrompt, type VoiceProfile } from "@/domain/voice/voice";
import type { GuardrailOptions } from "@/ai/guardrails";

const VOICE_PROFILE: VoiceProfile = {
  samples: [
    { id: "1", title: "Test", content: "So excited about planners!", tags: [] },
  ],
  rules: ["No vulgarity"],
  bannedWords: ["synergy", "delve", "leverage"],
};

const PLANNER: ProductInfo = {
  title: "Daily Planner - Rose Gold",
  description: "Our best-selling planner with monthly, weekly, and daily views.",
  priceCents: 2999,
  imageUrl: "https://cdn.radandhappy.com/planner-rg.jpg",
  productType: "Planner",
};

const COLORING_BOOK: ProductInfo = {
  title: "Mindful Coloring Book",
  description: "36 hand-drawn illustrations for stress relief.",
  priceCents: 1499,
  imageUrl: "https://cdn.radandhappy.com/coloring.jpg",
  productType: "Coloring Book",
};

const BASIC_BRIEF: EmailBrief = {
  campaignName: "Summer Sale",
  goal: "drive sales",
  products: [PLANNER],
};

// ─── Guardrails for email creative ────────────────────────────────────

describe("buildEmailGuardrails: creative output protection", () => {
  const voiceGuardrails: GuardrailOptions = {
    bannedWords: ["synergy", "delve"],
    checkPii: true,
    checkFabricatedStats: false, // voice default might be off
  };

  it("enables fabricated-stats check (creative must not invent numbers)", () => {
    const result = buildEmailGuardrails(voiceGuardrails);
    expect(result.checkFabricatedStats).toBe(true);
  });

  it("keeps PII check enabled", () => {
    const result = buildEmailGuardrails(voiceGuardrails);
    expect(result.checkPii).toBe(true);
  });

  it("keeps banned words from voice profile", () => {
    const result = buildEmailGuardrails(voiceGuardrails);
    expect(result.bannedWords).toEqual(["synergy", "delve"]);
  });

  it("requires JSON output (email creative is structured)", () => {
    const result = buildEmailGuardrails(voiceGuardrails);
    expect(result.expectJson).toBe(true);
  });
});

// ─── Product block formatting ─────────────────────────────────────────

describe("formatProductBlock: product data for prompts", () => {
  it("includes product title and price in dollars", () => {
    const block = formatProductBlock([PLANNER]);
    expect(block).toContain("Daily Planner - Rose Gold");
    expect(block).toContain("$29.99");
  });

  it("includes product description", () => {
    const block = formatProductBlock([PLANNER]);
    expect(block).toContain("best-selling planner");
  });

  it("formats multiple products", () => {
    const block = formatProductBlock([PLANNER, COLORING_BOOK]);
    expect(block).toContain("Daily Planner");
    expect(block).toContain("Mindful Coloring Book");
    expect(block).toContain("$14.99");
  });

  it("includes image URL when present", () => {
    const block = formatProductBlock([PLANNER]);
    expect(block).toContain("https://cdn.radandhappy.com/planner-rg.jpg");
  });

  it("handles product with no image gracefully", () => {
    const noImage: ProductInfo = { ...PLANNER, imageUrl: undefined };
    const block = formatProductBlock([noImage]);
    expect(block).toContain("Daily Planner");
    // Should not crash or contain "undefined"
    expect(block).not.toContain("undefined");
  });
});

// ─── Full request assembly ────────────────────────────────────────────

describe("buildEmailCreativeRequest: ties everything together", () => {
  const voice = assembleVoicePrompt(VOICE_PROFILE);

  it("includes the voice system prompt", () => {
    const req = buildEmailCreativeRequest(BASIC_BRIEF, voice);
    expect(req.system).toContain("Rad & Happy");
  });

  it("includes campaign name and goal in the prompt", () => {
    const req = buildEmailCreativeRequest(BASIC_BRIEF, voice);
    expect(req.prompt).toContain("Summer Sale");
    expect(req.prompt).toContain("drive sales");
  });

  it("includes product data in the prompt", () => {
    const req = buildEmailCreativeRequest(BASIC_BRIEF, voice);
    expect(req.prompt).toContain("Daily Planner - Rose Gold");
    expect(req.prompt).toContain("$29.99");
  });

  it("includes discount info when present", () => {
    const brief: EmailBrief = {
      ...BASIC_BRIEF,
      discount: { code: "SUMMER25", percentOff: 25 },
    };
    const req = buildEmailCreativeRequest(brief, voice);
    expect(req.prompt).toContain("SUMMER25");
    expect(req.prompt).toContain("25%");
  });

  it("includes segment info when present", () => {
    const brief: EmailBrief = {
      ...BASIC_BRIEF,
      segment: "VIP customers",
    };
    const req = buildEmailCreativeRequest(brief, voice);
    expect(req.prompt).toContain("VIP customers");
  });

  it("sets guardrails for creative output", () => {
    const req = buildEmailCreativeRequest(BASIC_BRIEF, voice);
    expect(req.guardrails?.checkFabricatedStats).toBe(true);
    expect(req.guardrails?.checkPii).toBe(true);
    expect(req.guardrails?.expectJson).toBe(true);
    expect(req.guardrails?.bannedWords).toContain("synergy");
  });

  it("instructs the model to return structured JSON", () => {
    const req = buildEmailCreativeRequest(BASIC_BRIEF, voice);
    expect(req.prompt.toLowerCase()).toMatch(/json/);
  });
});
