import { describe, it, expect } from "vitest";
import {
  formatOrchestratorResult,
  formatGuardrailError,
  formatUnknownCommand,
} from "@/worker/slack/formatter";
import type { OrchestratorResult } from "@/ai/orchestrator";

describe("formatOrchestratorResult", () => {
  it("formats successful result as non-error", () => {
    const result: OrchestratorResult = {
      ok: true,
      text: "Your ads are doing great!",
      inputTokens: 500,
      outputTokens: 100,
    };
    const response = formatOrchestratorResult(result);
    expect(response.isError).toBe(false);
    expect(response.text).toContain("doing great");
  });

  it("includes context label when provided", () => {
    const result: OrchestratorResult = {
      ok: true,
      text: "Analysis here.",
      inputTokens: 100,
      outputTokens: 50,
    };
    const response = formatOrchestratorResult(result, "Ads Report");
    expect(response.text).toContain("*Ads Report*");
    expect(response.text).toContain("Analysis here.");
  });

  it("formats guardrail failure as error", () => {
    const result: OrchestratorResult = {
      ok: false,
      guardrailResult: {
        passed: false,
        violations: [
          { rule: "pii-detected", detail: "Output contains email address" },
        ],
      },
    };
    const response = formatOrchestratorResult(result);
    expect(response.isError).toBe(true);
    expect(response.text).toContain("blocked");
    expect(response.text).toContain("email address");
  });

  it("formats multiple violations", () => {
    const result: OrchestratorResult = {
      ok: false,
      guardrailResult: {
        passed: false,
        violations: [
          { rule: "banned-word", detail: 'Contains "synergy"' },
          { rule: "pii-detected", detail: "Contains phone number" },
        ],
      },
    };
    const response = formatOrchestratorResult(result);
    expect(response.text).toContain("synergy");
    expect(response.text).toContain("phone number");
  });
});

describe("formatGuardrailError", () => {
  it("lists each violation", () => {
    const text = formatGuardrailError([
      { rule: "banned-word", detail: 'Contains "delve"' },
      { rule: "pii-detected", detail: "Contains email" },
    ]);
    expect(text).toContain("delve");
    expect(text).toContain("email");
  });

  it("returns empty string for no violations", () => {
    expect(formatGuardrailError([])).toBe("");
  });
});

describe("formatUnknownCommand", () => {
  it("includes the attempted command word", () => {
    const response = formatUnknownCommand("!foobar stuff");
    expect(response.isError).toBe(true);
    expect(response.text).toContain("foobar");
  });

  it("suggests !help", () => {
    const response = formatUnknownCommand("!xyz");
    expect(response.text).toContain("!help");
  });

  it("handles command with no args", () => {
    const response = formatUnknownCommand("!unknown");
    expect(response.isError).toBe(true);
    expect(response.text).toContain("unknown");
  });
});
