import { vi } from "vitest";
import type { EmbeddingClient, EmbeddingResult } from "@/integrations/openai";

/** Generate a deterministic fake embedding of the right dimension. */
function fakeEmbedding(seed: number = 0): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed + i) * 0.01);
}

export function createMockEmbeddingClient(
  overrides?: Partial<EmbeddingClient>
): EmbeddingClient {
  let callCount = 0;
  return {
    embed: vi.fn().mockImplementation(async (_text: string) => ({
      embedding: fakeEmbedding(callCount++),
      tokenCount: 50,
    } satisfies EmbeddingResult)),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map((_, i) => ({
        embedding: fakeEmbedding(callCount + i),
        tokenCount: 50,
      } satisfies EmbeddingResult))
    ),
    ...overrides,
  };
}
