/**
 * Slack response formatter — turns orchestrator results into
 * human-readable Slack messages.
 *
 * Two users: Matt (technical) and Tara (non-technical).
 * Error messages must be clear and actionable, not stack traces.
 */

import type { OrchestratorResult } from "@/ai/orchestrator";
import type { GuardrailViolation } from "@/ai/guardrails";

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
      text: `${prefix}${result.text}`,
      isError: false,
    };
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
