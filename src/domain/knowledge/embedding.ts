/**
 * Embedding orchestrator — takes ingested chunks, embeds the ones that
 * need it, and returns updated rows with vectors filled in.
 *
 * Fail closed: if the embedding API errors on a chunk, that chunk is
 * marked as failed (not silently skipped with null embedding).
 * A chunk with null embedding should never be stored — it would be
 * invisible to vector search.
 */

import type { EmbeddingClient } from "@/integrations/openai";
import type { IngestedChunk } from "./ingestion";

export interface EmbeddedChunk {
  chunk: IngestedChunk;
  status: "embedded" | "skipped" | "failed";
  error?: string;
}

export interface EmbeddingResult {
  total: number;
  embedded: number;
  skipped: number;
  failed: number;
  chunks: EmbeddedChunk[];
}

export async function embedChunks(
  chunks: IngestedChunk[],
  client: EmbeddingClient
): Promise<EmbeddingResult> {
  const results: EmbeddedChunk[] = [];
  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (const chunk of chunks) {
    if (!chunk.needsEmbedding) {
      results.push({ chunk, status: "skipped" });
      skipped++;
      continue;
    }

    try {
      const embeddingResult = await client.embed(chunk.row.content);
      // Mutate the row to fill in the embedding vector
      chunk.row.embedding = embeddingResult.embedding;
      results.push({ chunk, status: "embedded" });
      embedded++;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ chunk, status: "failed", error });
      failed++;
    }
  }

  return {
    total: chunks.length,
    embedded,
    skipped,
    failed,
    chunks: results,
  };
}
