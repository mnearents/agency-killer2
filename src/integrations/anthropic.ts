/**
 * Anthropic API client — the seam between our code and the Claude API.
 * Tests mock this interface; production uses the real SDK.
 */

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

export function createAnthropicClient(apiKey: string): AnthropicClient {
  // Real implementation will use the Anthropic SDK.
  // For now, this exists to define the seam.
  throw new Error(
    "Real Anthropic client not yet implemented — use createMockAnthropicClient in tests"
  );
}
