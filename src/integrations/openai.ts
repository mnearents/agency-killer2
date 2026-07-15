/**
 * OpenAI API client — the seam. Used ONLY for embeddings.
 * All generation uses Anthropic. This client exists solely for
 * text-embedding-3-small calls.
 */

export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

export interface EmbeddingClient {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
}

export function createEmbeddingClient(_apiKey: string): EmbeddingClient {
  throw new Error(
    "Real OpenAI embedding client not yet implemented — use createMockEmbeddingClient in tests"
  );
}
