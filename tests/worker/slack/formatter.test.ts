import { describe, it, expect } from "vitest";
import {
  formatOrchestratorResult,
  formatGuardrailError,
  formatUnknownCommand,
  formatVoiceNote,
} from "@/worker/slack/formatter";
import type { OrchestratorResult } from "@/ai/orchestrator";
import type { VoiceCheckResult } from "@/domain/voice/voice-check";

/** A verdict that ran and found nothing — not the same as a check that did not run. */
const CLEAN: VoiceCheckResult = {
  ok: true,
  channel: "unspecified",
  violations: [],
  enforced: ["Never use em dashes"],
  unenforced: [],
};

describe("formatOrchestratorResult", () => {
  it("formats successful result as non-error", () => {
    const result: OrchestratorResult = {
      ok: true,
      text: "Your ads are doing great!",
      inputTokens: 500,
      outputTokens: 100,
      voice: CLEAN,
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
      voice: CLEAN,
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
      voice: null,
    };
    const response = formatOrchestratorResult(result);
    expect(response.isError).toBe(true);
    expect(response.text).toContain("blocked");
    expect(response.text).toContain("email address");
  });

  it("formats multiple violations", () => {
    const result: OrchestratorResult = {
      ok: false,
      voice: null,
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

/**
 * ─── The voice verdict has to reach the human ─────────────────────────
 *
 * A style violation does not withhold the draft — nothing here auto-publishes,
 * and a blocked draft is not a better draft. But a draft that broke a rule and
 * a draft that did not must not arrive looking the same, or the check is a log
 * line nobody reads and the rules are wishes again.
 *
 * This is the single point where every orchestrator result becomes a Slack
 * message, so it is the one place that has to say so. Tara reads these: the
 * note names the rule in her words, never a regex or a channel constant.
 */
describe("formatOrchestratorResult: voice violations are visible, not logged", () => {
  const verdict = (over: Partial<VoiceCheckResult> = {}): VoiceCheckResult => ({
    ok: true,
    channel: "email",
    violations: [],
    enforced: ["Never use em dashes"],
    unenforced: [],
    ...over,
  });

  const success = (voice: VoiceCheckResult): OrchestratorResult => ({
    ok: true,
    text: "Planners are here.",
    inputTokens: 1,
    outputTokens: 1,
    voice,
  });

  it("says nothing extra when the copy is clean", () => {
    const r = formatOrchestratorResult(success(verdict()));
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Planners are here.");
  });

  it("returns the draft AND flags the rule it broke", () => {
    const r = formatOrchestratorResult(
      success(
        verdict({
          ok: false,
          violations: [{ rule: "Never use em dashes", detail: 'Text matches /[—–]/ on channel "email".' }],
        })
      )
    );
    expect(r.text).toContain("Planners are here.");
    expect(r.text).toContain("Never use em dashes");
  });

  // Tara reads this. The raw detail is `Text matches /[—–]|(?<=\s)--(?=\s)/ on
  // channel "email".` — a regex and a channel constant, which is terminal
  // output wearing a sentence.
  it("does not put a regex or a channel constant in front of Tara", () => {
    const r = formatOrchestratorResult(
      success(
        verdict({
          ok: false,
          violations: [{ rule: "Never use em dashes", detail: 'Text matches /[—–]|(?<=\\s)--(?=\\s)/ on channel "email".' }],
        })
      )
    );
    expect(r.text).not.toContain("?<=");
    expect(r.text).not.toMatch(/channel "email"/);
  });

  it("names the banned word rather than the sentinel", () => {
    const r = formatOrchestratorResult(
      success(
        verdict({
          ok: false,
          violations: [{ rule: "banned-word", detail: 'Text contains the banned word "synergy".' }],
        })
      )
    );
    expect(r.text).toContain("synergy");
    expect(r.text).not.toContain("banned-word");
  });

  it("reports several broken rules, not just the first", () => {
    const r = formatOrchestratorResult(
      success(
        verdict({
          ok: false,
          violations: [
            { rule: "Never use em dashes", detail: "d1" },
            { rule: "No vulgarity", detail: "d2" },
          ],
        })
      )
    );
    expect(r.text).toContain("Never use em dashes");
    expect(r.text).toContain("No vulgarity");
  });

  // A flagged draft is still a draft. Marking it an error would send it down
  // the failure path and hide the copy Tara asked for.
  it("does not turn a flagged draft into an error", () => {
    const r = formatOrchestratorResult(
      success(verdict({ ok: false, violations: [{ rule: "No vulgarity", detail: "d" }] }))
    );
    expect(r.isError).toBe(false);
  });

  it("keeps the context heading alongside the flag", () => {
    const r = formatOrchestratorResult(
      success(verdict({ ok: false, violations: [{ rule: "No vulgarity", detail: "d" }] })),
      "Email Creative"
    );
    expect(r.text).toContain("*Email Creative*");
    expect(r.text).toContain("Planners are here.");
    expect(r.text).toContain("No vulgarity");
  });
});

/**
 * The no-AI stub used to return `ok: true` with an apology as its `text` — a
 * failure wearing a success's clothes, which is the shape this codebase has
 * produced nine times. It is a failure now, and it must not be rendered as
 * "blocked by safety checks": nothing was blocked, the key is not set.
 */
describe("formatOrchestratorResult: AI unavailable is its own thing", () => {
  it("says the key is missing rather than blaming a safety check", () => {
    const r = formatOrchestratorResult({
      ok: false,
      voice: null,
      guardrailResult: {
        passed: false,
        violations: [
          { rule: "ai-unavailable", detail: "AI responses are not available. ANTHROPIC_API_KEY is not set." },
        ],
      },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ANTHROPIC_API_KEY");
    expect(r.text).not.toMatch(/blocked by safety checks/i);
  });
});

describe("formatVoiceNote: the note obeys the rules it is reporting", () => {
  // A message about not using em dashes that uses one is not a message anyone
  // takes seriously. The first draft of this note did exactly that.
  it("contains no em dash of its own", () => {
    const note = formatVoiceNote({
      ok: false,
      channel: "email",
      violations: [
        { rule: "Never use em dashes", detail: "d1" },
        { rule: "No vulgarity", detail: "d2" },
      ],
      enforced: [],
      unenforced: [],
    });
    expect(note).not.toMatch(/[—–]/);
  });

  it("returns nothing at all for a clean verdict, so nothing is appended", () => {
    expect(
      formatVoiceNote({ ok: true, channel: "email", violations: [], enforced: ["r"], unenforced: [] })
    ).toBe("");
  });
});
