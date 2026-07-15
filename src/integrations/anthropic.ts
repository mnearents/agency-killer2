/**
 * Anthropic API client — the seam between our code and the Claude API.
 * Tests mock this interface; production uses the real SDK.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface GenerateOptions {
  model?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export interface AnthropicClient {
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult>;
}

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 4096;

export function createAnthropicClient(apiKey: string): AnthropicClient {
  const sdk = new Anthropic({ apiKey });

  return {
    async generate(prompt, options = {}) {
      const response = await sdk.messages.create({
        model: options.model ?? DEFAULT_MODEL,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options.temperature,
        system: options.system,
        messages: [{ role: "user", content: prompt }],
      });

      // Extract text from content blocks
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stopReason: response.stop_reason ?? "unknown",
      };
    },
  };
}
