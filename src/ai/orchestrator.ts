/**
 * AI orchestrator — routes tasks to the model and validates every output
 * through guardrails before returning it. No unguarded output leaves this layer.
 *
 * ## Why the voice check lives here
 *
 * `voiceCheck` shipped in #59 with exactly one caller, `/api/generate`. The
 * worker's five generators — ad analysis, social analysis, the weekly report,
 * email creative, the blog — assembled a voice prompt and never checked what
 * came back. A guardrail wired to one of six callers is not far from one wired
 * to none, which is the failure it was built to fix.
 *
 * Wiring it at six call sites would reproduce that: six can drift to five and
 * nothing goes red. It is wired here instead, at the one function every
 * generation already passes through, and `audience` is a **required** field on
 * the request. A call site cannot omit a required field, so every request
 * builder has to state who its copy is for — and each of those builders is a
 * pure function with its own unit test, which is where that statement is
 * asserted.
 *
 * The docstring above already claimed this property before the code held it.
 * A claim in a docstring is a claim about code that must exist.
 *
 * ## What blocks, and what travels with the text
 *
 * A **structural** failure of the check blocks. An unrecognised audience, an
 * empty output, or a profile with nothing to check all mean the check did not
 * happen, and "we did not look" must never read as "we looked and it was fine".
 * These surface as ordinary guardrail violations so there is one failure
 * channel, not two.
 *
 * A **style** violation does not withhold the text. Nothing in this system
 * auto-publishes — every generation lands in Slack or a Figma panel for a human
 * to accept — so withholding a draft over an em dash leaves that human with
 * nothing instead of something to fix, and a guardrail that blocks correct copy
 * gets turned off. The violations travel on `result.voice` instead, which is
 * present on success and failure alike.
 *
 * That balance changes when #26 starts saving drafts: a saved draft is a
 * commitment, and #27 requires one to pass the check before it is written.
 */

import type { AnthropicClient, GenerateOptions } from "@/integrations/anthropic";
import {
  validateOutput,
  type GuardrailOptions,
  type GuardrailResult,
} from "@/ai/guardrails";
import { voiceCheck, type VoiceCheckResult } from "@/domain/voice/voice-check";
import type { VoiceProfile } from "@/domain/voice/voice";
import type { RuleAudience } from "@/domain/voice/rules";

export interface OrchestratorConfig {
  client: AnthropicClient;
  defaultModel?: string;
  defaultGuardrails?: GuardrailOptions;
  /**
   * The rules and banned words every generation is checked against. Required:
   * an optional profile would make "this orchestrator was built without one"
   * indistinguishable from "the copy was clean".
   */
  voiceProfile: VoiceProfile;
}

export interface OrchestratorRequest {
  prompt: string;
  system?: string;
  /**
   * Who this copy is for. Required, and there is no default — #61 shipped one
   * and it applied Instagram's exclusions to email. A caller that genuinely
   * does not know passes `UNSPECIFIED`, which is excused from nothing.
   *
   * Where the request carries an assembled voice prompt, this must be that
   * prompt's own `audience`, so the rules the model was steered by and the
   * rules it is graded against cannot drift apart.
   */
  audience: RuleAudience;
  guardrails?: GuardrailOptions;
  maxTokens?: number;
  temperature?: number;
}

/**
 * The voice verdict, or `null` when the check never ran because the output
 * guardrails blocked first.
 *
 * `null` and a clean result are deliberately different values. Zero violations
 * over a check that did not happen is the shape of every silent failure in this
 * codebase; the type forces a caller to tell them apart.
 */
export type VoiceVerdict = VoiceCheckResult | null;

export interface OrchestratorSuccess {
  ok: true;
  text: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Always present on success. `voice.ok === false` here means the copy broke a
   * style rule and is being returned anyway for a human to fix — read it.
   */
  voice: VoiceCheckResult;
}

export interface OrchestratorFailure {
  ok: false;
  guardrailResult: GuardrailResult;
  voice: VoiceVerdict;
}

export type OrchestratorResult = OrchestratorSuccess | OrchestratorFailure;

/**
 * Violations that mean the check itself did not run, as opposed to copy that
 * broke a rule. These are the sentinels `voiceCheck` returns for its
 * fail-closed cases.
 */
const STRUCTURAL_FAILURES = new Set(["unknown-channel", "empty-output", "nothing-checked"]);

function isStructuralFailure(result: VoiceCheckResult): boolean {
  return result.violations.some((v) => STRUCTURAL_FAILURES.has(v.rule));
}

export function createOrchestrator(config: OrchestratorConfig) {
  const { client, defaultModel, defaultGuardrails, voiceProfile } = config;

  async function run(request: OrchestratorRequest): Promise<OrchestratorResult> {
    const guardrailOptions: GuardrailOptions = {
      ...defaultGuardrails,
      ...request.guardrails,
    };

    const generateOptions: GenerateOptions = {
      model: defaultModel,
      system: request.system,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
    };

    const result = await client.generate(request.prompt, generateOptions);

    const guardrailResult = validateOutput(result.text, guardrailOptions);

    if (!guardrailResult.passed) {
      // The voice check did not run. `null` rather than a fabricated clean
      // verdict — see VoiceVerdict.
      return { ok: false, guardrailResult, voice: null };
    }

    const voice = voiceCheck(result.text, request.audience, voiceProfile);

    if (isStructuralFailure(voice)) {
      return {
        ok: false,
        guardrailResult: { passed: false, violations: voice.violations },
        voice,
      };
    }

    return {
      ok: true,
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      voice,
    };
  }

  return { run };
}
