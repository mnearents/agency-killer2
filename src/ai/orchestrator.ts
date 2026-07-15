/**
 * AI orchestrator — routes tasks to the model and validates every output
 * through guardrails before returning it. No unguarded output leaves this layer.
 */

import type { AnthropicClient, GenerateOptions } from "@/integrations/anthropic";
import {
  validateOutput,
  type GuardrailOptions,
  type GuardrailResult,
} from "@/ai/guardrails";

export interface OrchestratorConfig {
  client: AnthropicClient;
  defaultModel?: string;
  defaultGuardrails?: GuardrailOptions;
}

export interface OrchestratorRequest {
  prompt: string;
  system?: string;
  guardrails?: GuardrailOptions;
  maxTokens?: number;
  temperature?: number;
}

export interface OrchestratorSuccess {
  ok: true;
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface OrchestratorFailure {
  ok: false;
  guardrailResult: GuardrailResult;
}

export type OrchestratorResult = OrchestratorSuccess | OrchestratorFailure;

export function createOrchestrator(config: OrchestratorConfig) {
  const { client, defaultModel, defaultGuardrails } = config;

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
      return { ok: false, guardrailResult };
    }

    return {
      ok: true,
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }

  return { run };
}
