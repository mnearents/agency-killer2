import { describe, it, expect } from "vitest";
import {
  buildBlogRequest,
  buildBlogGuardrails,
  type BlogTopic,
  type BlogPromptInput,
} from "@/domain/blog/prompt";
import {
  AI_WRITING_BANNED_WORDS,
  mergeAiWritingBannedWords,
} from "@/domain/blog/ai-writing-rules";
import { assembleVoicePrompt, type VoiceProfile } from "@/domain/voice/voice";
import { validateOutput } from "@/ai/guardrails";

const VOICE_PROFILE: VoiceProfile = {
  samples: [
    { id: "1", title: "Test", content: "So excited about planners!", tags: [] },
  ],
  rules: ["No vulgarity"],
  bannedWords: ["shenanigans"], // brand-specific
};

const BASIC_TOPIC: BlogTopic = {
  title: "10 Ways to Use Your Planner for Meal Planning",
  description: "SEO article targeting 'planner meal planning' keyword",
  tags: ["planning", "organization", "meals"],
};

// ─── AI writing banned words ──────────────────────────────────────────

describe("AI_WRITING_BANNED_WORDS", () => {
  it("contains the core AI-sounding words from Wikipedia guidelines", () => {
    expect(AI_WRITING_BANNED_WORDS).toContain("delve");
    expect(AI_WRITING_BANNED_WORDS).toContain("tapestry");
    expect(AI_WRITING_BANNED_WORDS).toContain("leverage");
    expect(AI_WRITING_BANNED_WORDS).toContain("furthermore");
    expect(AI_WRITING_BANNED_WORDS).toContain("it's important to note");
  });

  it("has at least 20 entries", () => {
    expect(AI_WRITING_BANNED_WORDS.length).toBeGreaterThanOrEqual(20);
  });
});

describe("mergeAiWritingBannedWords", () => {
  it("merges voice banned words with AI-writing banned words", () => {
    const merged = mergeAiWritingBannedWords(["shenanigans"]);
    expect(merged).toContain("shenanigans");
    expect(merged).toContain("delve");
    expect(merged).toContain("tapestry");
  });

  it("deduplicates when voice profile already contains an AI word", () => {
    const merged = mergeAiWritingBannedWords(["delve", "shenanigans"]);
    const delveCount = merged.filter((w) => w === "delve").length;
    expect(delveCount).toBe(1);
  });

  it("is case-insensitive for dedup", () => {
    const merged = mergeAiWritingBannedWords(["DELVE"]);
    const delveCount = merged.filter((w) => w === "delve").length;
    expect(delveCount).toBe(1);
  });
});

// ─── Blog guardrails ──────────────────────────────────────────────────

describe("buildBlogGuardrails", () => {
  const voice = assembleVoicePrompt(VOICE_PROFILE);

  it("includes AI-writing banned words merged with voice banned words", () => {
    const guardrails = buildBlogGuardrails(voice.guardrailOptions);
    expect(guardrails.bannedWords).toContain("shenanigans"); // voice
    expect(guardrails.bannedWords).toContain("delve"); // AI
    expect(guardrails.bannedWords).toContain("tapestry"); // AI
    expect(guardrails.bannedWords).toContain("furthermore"); // AI
  });

  it("enables fabricated-stats check (blog must not invent numbers)", () => {
    const guardrails = buildBlogGuardrails(voice.guardrailOptions);
    expect(guardrails.checkFabricatedStats).toBe(true);
  });

  it("enables PII check", () => {
    const guardrails = buildBlogGuardrails(voice.guardrailOptions);
    expect(guardrails.checkPii).toBe(true);
  });

  it("sets a generous max length for articles", () => {
    const guardrails = buildBlogGuardrails(voice.guardrailOptions);
    expect(guardrails.maxLength).toBeGreaterThanOrEqual(10000);
  });
});

// ─── Blog guardrails actually catch AI writing ────────────────────────

describe("blog guardrails catch AI-sounding output", () => {
  const voice = assembleVoicePrompt(VOICE_PROFILE);
  const guardrails = buildBlogGuardrails(voice.guardrailOptions);

  it("blocks output containing 'delve'", () => {
    const result = validateOutput(
      "Let's delve into the world of planner organization.",
      guardrails
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "banned-word")).toBe(true);
  });

  it("blocks output containing 'it's important to note'", () => {
    const result = validateOutput(
      "It's important to note that planners help with organization.",
      guardrails
    );
    expect(result.passed).toBe(false);
  });

  it("blocks output containing 'furthermore'", () => {
    const result = validateOutput(
      "Furthermore, using a planner helps you stay on track.",
      guardrails
    );
    expect(result.passed).toBe(false);
  });

  it("passes clean, human-sounding blog content", () => {
    const result = validateOutput(
      "Here's the thing about meal planning — it doesn't have to be complicated. Grab your planner, flip to this week, and let's figure out dinner.",
      guardrails
    );
    expect(result.passed).toBe(true);
  });
});

// ─── Full request assembly ────────────────────────────────────────────

describe("buildBlogRequest", () => {
  const voice = assembleVoicePrompt(VOICE_PROFILE);

  it("includes AI-writing avoidance instructions in system prompt", () => {
    const req = buildBlogRequest({ topic: BASIC_TOPIC, voice });
    expect(req.system).toContain("AI Writing Avoidance");
    expect(req.system).toContain("No filler transitions");
  });

  it("includes the voice system prompt", () => {
    const req = buildBlogRequest({ topic: BASIC_TOPIC, voice });
    expect(req.system).toContain("Rad & Happy");
  });

  it("includes topic title in the prompt", () => {
    const req = buildBlogRequest({ topic: BASIC_TOPIC, voice });
    expect(req.prompt).toContain("10 Ways to Use Your Planner for Meal Planning");
  });

  it("includes topic description when present", () => {
    const req = buildBlogRequest({ topic: BASIC_TOPIC, voice });
    expect(req.prompt).toContain("planner meal planning");
  });

  it("includes tags when present", () => {
    const req = buildBlogRequest({ topic: BASIC_TOPIC, voice });
    expect(req.prompt).toContain("planning");
    expect(req.prompt).toContain("organization");
  });

  it("includes brand context when provided", () => {
    const req = buildBlogRequest({
      topic: BASIC_TOPIC,
      voice,
      brandContext: "We focus on minimalist design and functional products.",
    });
    expect(req.prompt).toContain("minimalist design");
  });

  it("sets blog-specific guardrails with AI-writing words", () => {
    const req = buildBlogRequest({ topic: BASIC_TOPIC, voice });
    expect(req.guardrails?.bannedWords).toContain("delve");
    expect(req.guardrails?.bannedWords).toContain("shenanigans");
    expect(req.guardrails?.checkFabricatedStats).toBe(true);
  });

  it("instructs the model to write SEO-optimized HTML content", () => {
    const req = buildBlogRequest({ topic: BASIC_TOPIC, voice });
    expect(req.prompt.toLowerCase()).toMatch(/seo|html|article/);
  });
});
