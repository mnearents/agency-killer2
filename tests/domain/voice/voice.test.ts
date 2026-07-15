import { describe, it, expect } from "vitest";
import {
  assembleVoicePrompt,
  validateVoiceProfile,
  type VoiceProfile,
  type WritingSample,
} from "@/domain/voice/voice";

const SAMPLE_PROFILES: WritingSample[] = [
  {
    id: "1",
    title: "Planner Launch",
    content:
      "Y'all our new daily planner is HERE and I'm so dang excited!! It's got all the things you've been asking for ✨",
    tags: ["product-launch", "planner"],
  },
  {
    id: "2",
    title: "Thank You Post",
    content:
      "I just want to say thank you from the bottom of my heart. You guys are the reason we get to do this every single day 💛",
    tags: ["gratitude", "community"],
  },
  {
    id: "3",
    title: "Sale Announcement",
    content:
      "Okay friends, this is not a drill — 25% off EVERYTHING in the shop this weekend only! Use code RADWEEKEND 🎉",
    tags: ["sale", "promo"],
  },
];

const BASIC_PROFILE: VoiceProfile = {
  samples: SAMPLE_PROFILES,
  rules: ["Never use em dashes", "No vulgarity"],
  bannedWords: ["synergy", "delve", "leverage", "shenanigans"],
};

describe("assembleVoicePrompt: system prompt construction", () => {
  it("includes all writing samples in the system prompt", () => {
    const { systemPrompt } = assembleVoicePrompt(BASIC_PROFILE);
    for (const sample of SAMPLE_PROFILES) {
      expect(systemPrompt).toContain(sample.content);
    }
  });

  it("labels each sample with a number for clarity", () => {
    const { systemPrompt } = assembleVoicePrompt(BASIC_PROFILE);
    expect(systemPrompt).toContain("Example 1:");
    expect(systemPrompt).toContain("Example 2:");
    expect(systemPrompt).toContain("Example 3:");
  });

  it("includes all brand rules in the system prompt", () => {
    const { systemPrompt } = assembleVoicePrompt(BASIC_PROFILE);
    expect(systemPrompt).toContain("Never use em dashes");
    expect(systemPrompt).toContain("No vulgarity");
  });

  it("includes banned words as an explicit prohibition list", () => {
    const { systemPrompt } = assembleVoicePrompt(BASIC_PROFILE);
    expect(systemPrompt).toContain("synergy");
    expect(systemPrompt).toContain("delve");
    expect(systemPrompt).toContain("leverage");
    expect(systemPrompt).toContain("shenanigans");
  });

  it("instructs the model to match the voice of the examples", () => {
    const { systemPrompt } = assembleVoicePrompt(BASIC_PROFILE);
    // The prompt must contain instruction to study and match the examples
    expect(systemPrompt.toLowerCase()).toMatch(
      /voice|tone|style|match|study|examples/
    );
  });
});

describe("assembleVoicePrompt: guardrail options", () => {
  it("passes banned words to guardrail options", () => {
    const { guardrailOptions } = assembleVoicePrompt(BASIC_PROFILE);
    expect(guardrailOptions.bannedWords).toEqual([
      "synergy",
      "delve",
      "leverage",
      "shenanigans",
    ]);
  });

  it("enables PII checking by default", () => {
    const { guardrailOptions } = assembleVoicePrompt(BASIC_PROFILE);
    expect(guardrailOptions.checkPii).toBe(true);
  });

  it("enables fabricated stats checking by default", () => {
    const { guardrailOptions } = assembleVoicePrompt(BASIC_PROFILE);
    expect(guardrailOptions.checkFabricatedStats).toBe(true);
  });
});

describe("assembleVoicePrompt: determinism", () => {
  it("same profile produces identical prompt every time", () => {
    const result1 = assembleVoicePrompt(BASIC_PROFILE);
    const result2 = assembleVoicePrompt(BASIC_PROFILE);
    expect(result1.systemPrompt).toBe(result2.systemPrompt);
    expect(result1.guardrailOptions).toEqual(result2.guardrailOptions);
  });
});

describe("assembleVoicePrompt: custom template", () => {
  it("uses custom prompt template when provided", () => {
    const profile: VoiceProfile = {
      ...BASIC_PROFILE,
      promptTemplate:
        "You write for Rad & Happy. {{SAMPLES}} Follow these rules: {{RULES}} Never use: {{BANNED_WORDS}}",
    };
    const { systemPrompt } = assembleVoicePrompt(profile);
    expect(systemPrompt).toContain("You write for Rad & Happy");
    // Samples should be interpolated
    expect(systemPrompt).toContain(SAMPLE_PROFILES[0].content);
  });
});

describe("validateVoiceProfile: rejects incomplete profiles", () => {
  it("rejects a profile with zero samples", () => {
    const result = validateVoiceProfile({
      samples: [],
      rules: ["No vulgarity"],
      bannedWords: ["delve"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a profile with an empty-content sample", () => {
    const result = validateVoiceProfile({
      samples: [{ id: "1", title: "Empty", content: "", tags: [] }],
      rules: [],
      bannedWords: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("accepts a valid profile", () => {
    const result = validateVoiceProfile(BASIC_PROFILE);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
