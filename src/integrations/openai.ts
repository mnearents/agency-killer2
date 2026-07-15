/**
 * OpenAI API client — the seam. Used ONLY for embeddings.
 * All generation uses Anthropic. This client exists solely for
 * text-embedding-3-small calls.
 */

import OpenAI from "openai";

export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

export interface EmbeddingClient {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
}

const EMBEDDING_MODEL = "text-embedding-3-small";

export function createEmbeddingClient(apiKey: string): EmbeddingClient {
  const sdk = new OpenAI({ apiKey });

  return {
    async embed(text) {
      const response = await sdk.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
      });

      return {
        embedding: response.data[0].embedding,
        tokenCount: response.usage.total_tokens,
      };
    },

    async embedBatch(texts) {
      const response = await sdk.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
      });

      return response.data.map((item, i) => ({
        embedding: item.embedding,
        tokenCount: Math.ceil(response.usage.total_tokens / texts.length),
      }));
    },
  };
}
