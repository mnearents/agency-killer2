import { vi } from "vitest";
import type { AnthropicClient, GenerateResult } from "@/integrations/anthropic";

export function createMockAnthropicClient(
  overrides?: Partial<AnthropicClient>
): AnthropicClient {
  return {
    generate: vi.fn().mockResolvedValue({
      text: "Mock response",
      inputTokens: 100,
      outputTokens: 50,
      stopReason: "end_turn",
    } satisfies GenerateResult),
    ...overrides,
  };
}
