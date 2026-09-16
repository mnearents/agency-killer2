/**
 * Slack response formatter — turns orchestrator results into
 * human-readable Slack messages.
 *
 * Two users: Matt (technical) and Tara (non-technical).
 * Error messages must be clear and actionable, not stack traces.
 */

import type { OrchestratorResult } from "@/ai/orchestrator";
import type { GuardrailViolation } from "@/ai/guardrails";
import type { VoiceCheckResult } from "@/domain/voice/voice-check";

/** Set by the worker when ANTHROPIC_API_KEY is missing. Not a blocked output. */
export const AI_UNAVAILABLE = "ai-unavailable";

/**
 * The voice note appended to a draft that broke a style rule.
 *
 * The draft is still returned — nothing here auto-publishes, and withholding it
 * over an em dash leaves Tara with nothing instead of something to fix. But a
 * flagged draft and a clean one must not arrive looking identical, or the check
 * is a log line nobody reads.
 *
 * Tara reads these messages, so the note names the rule in her words. The raw
 * violation detail is `Text matches /[—–]|(?<=\s)--(?=\s)/ on channel "email".`
 * — a regex and a channel constant, which is terminal output wearing a
 * sentence. Banned words are the one case where the detail carries the fact
 * (which word), so that one is quoted and the `banned-word` sentinel dropped.
 */
export function formatVoiceNote(voice: VoiceCheckResult): string {
  const advisories = voice.advisories ?? [];

  // A preference is worth mentioning and not worth a warning. Presenting both
  // in the same register is what made "delight" read like a failure (#60).
  if (voice.ok || voice.violations.length === 0) {
    if (advisories.length === 0) return "";
    const words = advisories.map((a) => `"${a.word}"`).join(", ");
    return `\n\n_Worth a look: uses ${words}, which Tara tends to avoid. Fine to leave if it reads well._`;
  }

  const reasons = voice.violations.map((v) =>
    v.rule === "banned-word"
      ? (v.detail.match(/"([^"]+)"/)?.[1] ?? v.detail)
      : v.rule
  );

  const heading =
    reasons.length === 1
      ? "this breaks a brand voice rule:"
      : `this breaks ${reasons.length} brand voice rules:`;
  const list = reasons.map((r) => `\n• ${r}`).join("");

  // No em dash in the note itself. A message about not using em dashes that
  // uses one is not a message anyone takes seriously.
  const note = `\n\n*Voice check:* ${heading}${list}\nWorth a quick edit before this goes out.`;
  if (advisories.length === 0) return note;
  return `${note}\nAlso uses ${advisories.map((a) => `"${a.word}"`).join(", ")}, which Tara tends to avoid.`;
}

export interface SlackResponse {
  text: string;
  isError: boolean;
}

export function formatGuardrailError(violations: GuardrailViolation[]): string {
  if (violations.length === 0) return "";

  return violations
    .map((v) => `- ${v.detail}`)
    .join("\n");
}

export function formatOrchestratorResult(
  result: OrchestratorResult,
  context?: string
): SlackResponse {
  if (result.ok) {
    const prefix = context ? `*${context}*\n\n` : "";
    return {
      text: `${prefix}${result.text}${formatVoiceNote(result.voice)}`,
      isError: false,
    };
  }

  // Nothing was blocked — the key is not set. Rendering it as a safety block
  // would describe a check that never ran as a check that fired.
  const unavailable = result.guardrailResult.violations.find((v) => v.rule === AI_UNAVAILABLE);
  if (unavailable) {
    return { text: unavailable.detail, isError: true };
  }

  const violationText = formatGuardrailError(result.guardrailResult.violations);
  return {
    text: `The response was blocked by safety checks:\n${violationText}`,
    isError: true,
  };
}

export function formatUnknownCommand(raw: string): SlackResponse {
  // Extract the attempted command word
  const attempted = raw.replace(/^!/, "").split(/\s+/)[0] || "unknown";
  return {
    text: `I don't recognize the command "${attempted}". Try \`!help\` for available commands.`,
    isError: true,
  };
}
