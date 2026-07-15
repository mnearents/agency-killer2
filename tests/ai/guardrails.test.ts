import { describe, it, expect } from "vitest";
import { validateOutput } from "@/ai/guardrails";

describe("guardrails: fail-closed on empty/missing output", () => {
  it("blocks null output", () => {
    const result = validateOutput(null);
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "empty-output" })
    );
  });

  it("blocks undefined output", () => {
    const result = validateOutput(undefined);
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "empty-output" })
    );
  });

  it("blocks empty string", () => {
    const result = validateOutput("");
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "empty-output" })
    );
  });

  it("blocks whitespace-only string", () => {
    const result = validateOutput("   \n\t  ");
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "empty-output" })
    );
  });
});

describe("guardrails: PII detection", () => {
  it("blocks output containing an email address", () => {
    const result = validateOutput(
      "Contact us at tara@radandhappy.com for details!",
      { checkPii: true }
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "pii-detected" })
    );
  });

  it("blocks output containing a phone number", () => {
    const result = validateOutput(
      "Call us at (555) 123-4567 to learn more!",
      { checkPii: true }
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "pii-detected" })
    );
  });

  it("blocks output containing a credit card number", () => {
    const result = validateOutput(
      "Your card ending in 4111 1111 1111 1111 has been charged.",
      { checkPii: true }
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "pii-detected" })
    );
  });

  it("passes clean output when PII check is enabled", () => {
    const result = validateOutput(
      "Check out our new planner collection this spring!",
      { checkPii: true }
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe("guardrails: banned words (off-brand)", () => {
  const bannedWords = ["synergy", "delve", "leverage", "shenanigans"];

  it("blocks output containing a banned word", () => {
    const result = validateOutput(
      "Let's delve into our latest collection of planners!",
      { bannedWords }
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "banned-word" })
    );
  });

  it("blocks banned word regardless of case", () => {
    const result = validateOutput(
      "We LEVERAGE our community to drive growth.",
      { bannedWords }
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "banned-word" })
    );
  });

  it("catches multiple banned words and reports all of them", () => {
    const result = validateOutput(
      "Let's delve into the synergy of our brand leverage.",
      { bannedWords }
    );
    expect(result.passed).toBe(false);
    const bannedViolations = result.violations.filter(
      (v) => v.rule === "banned-word"
    );
    expect(bannedViolations.length).toBeGreaterThanOrEqual(3);
  });

  it("passes clean output with no banned words", () => {
    const result = validateOutput(
      "Our new planner collection is here and it's so good!",
      { bannedWords }
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe("guardrails: fabricated statistics", () => {
  it("blocks output claiming a specific ROAS number", () => {
    const result = validateOutput(
      "Our Meta campaigns achieved a 4.7x ROAS last quarter.",
      { checkFabricatedStats: true }
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "fabricated-stat" })
    );
  });

  it("blocks output claiming specific revenue", () => {
    const result = validateOutput(
      "We generated $127,500 in revenue from email campaigns.",
      { checkFabricatedStats: true }
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "fabricated-stat" })
    );
  });

  it("blocks output claiming specific percentage growth", () => {
    const result = validateOutput(
      "Organic traffic increased by 340% after implementing our SEO strategy.",
      { checkFabricatedStats: true }
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "fabricated-stat" })
    );
  });

  it("passes output with no specific statistics", () => {
    const result = validateOutput(
      "Consider testing different ad creative to see what resonates with your audience.",
      { checkFabricatedStats: true }
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe("guardrails: JSON validation", () => {
  it("blocks malformed JSON when expectJson is true", () => {
    const result = validateOutput(
      '{"title": "New Planner", "description": broken}',
      { expectJson: true }
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "invalid-json" })
    );
  });

  it("blocks non-JSON text when expectJson is true", () => {
    const result = validateOutput(
      "Here is your blog post about planners...",
      { expectJson: true }
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "invalid-json" })
    );
  });

  it("passes valid JSON when expectJson is true", () => {
    const result = validateOutput(
      '{"title": "New Planner", "description": "A great planner"}',
      { expectJson: true }
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe("guardrails: max length", () => {
  it("blocks output exceeding maxLength", () => {
    const longOutput = "a".repeat(10001);
    const result = validateOutput(longOutput, { maxLength: 10000 });
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ rule: "too-long" })
    );
  });

  it("passes output within maxLength", () => {
    const result = validateOutput("Short and sweet.", { maxLength: 10000 });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe("guardrails: multiple rules compound", () => {
  it("reports all violations when multiple rules fail", () => {
    const result = validateOutput(
      "Let's delve into our 4.7x ROAS and contact tara@radandhappy.com",
      {
        bannedWords: ["delve"],
        checkPii: true,
        checkFabricatedStats: true,
      }
    );
    expect(result.passed).toBe(false);
    const rules = result.violations.map((v) => v.rule);
    expect(rules).toContain("banned-word");
    expect(rules).toContain("pii-detected");
    expect(rules).toContain("fabricated-stat");
  });
});
