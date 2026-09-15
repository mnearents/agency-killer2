/**
 * Canned orchestrator results for tests that stub `runOrchestrator`.
 *
 * Every result carries a voice verdict, because the real one does. The two
 * helpers here exist so a test has to pick between them:
 *
 * - `orchestratorOk` — the check ran and found nothing.
 * - `orchestratorBlocked` — the output guardrails blocked first, so the voice
 *   check never ran and the verdict is `null`.
 *
 * A `null` verdict and a clean verdict are different facts. Defaulting either
 * one would let a test assert behaviour over a state production never produces.
 */

import type { OrchestratorResult } from "@/ai/orchestrator";
import type { VoiceCheckResult } from "@/domain/voice/voice-check";
import type { GuardrailViolation } from "@/ai/guardrails";
import { UNSPECIFIED } from "@/domain/voice/rules";

export function cleanVoiceVerdict(
  overrides: Partial<VoiceCheckResult> = {}
): VoiceCheckResult {
  return {
    ok: true,
    channel: UNSPECIFIED,
    violations: [],
    enforced: ["Never use em dashes"],
    unenforced: [],
    ...overrides,
  };
}

export function orchestratorOk(
  text: string,
  opts: { inputTokens?: number; outputTokens?: number; voice?: VoiceCheckResult } = {}
): OrchestratorResult {
  return {
    ok: true,
    text,
    inputTokens: opts.inputTokens ?? 100,
    outputTokens: opts.outputTokens ?? 50,
    voice: opts.voice ?? cleanVoiceVerdict(),
  };
}

export function orchestratorBlocked(violations: GuardrailViolation[]): OrchestratorResult {
  return {
    ok: false,
    guardrailResult: { passed: false, violations },
    // The guardrails blocked before the voice check ran. Not a clean verdict.
    voice: null,
  };
}
