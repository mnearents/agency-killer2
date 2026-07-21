/**
 * Knowledge base retrieval — finds relevant context for AI prompts.
 *
 * Uses hybrid retrieval: optional category filter + vector similarity.
 * Returns formatted context blocks ready to inject into prompts.
 */

import type { Db } from "@/db/client";
import type { EmbeddingClient } from "@/integrations/openai";
import { retrieveByVector } from "./storage";

export interface RetrievalDeps {
  db: Db;
  embeddingClient: EmbeddingClient;
}

export interface RetrievalOptions {
  category?: string;
  limit?: number;
}

/**
 * Retrieve relevant knowledge base context for a query.
 * Returns a formatted string ready to inject into a prompt.
 */
export async function retrieveContext(
  deps: RetrievalDeps,
  query: string,
  options: RetrievalOptions = {}
): Promise<string> {
  const { db, embeddingClient } = deps;
  const limit = options.limit ?? 5;

  try {
    // Embed the query
    const { embedding } = await embeddingClient.embed(query);

    // Retrieve similar chunks
    const results = await retrieveByVector(db, embedding, {
      category: options.category,
      limit,
    });

    if (results.length === 0) {
      return "";
    }

    // Format as a context block
    const contextParts = results.map((r, i) => {
      return `[${r.category}] ${r.content}`;
    });

    return `## Relevant Knowledge Base Context\n\n${contextParts.join("\n\n---\n\n")}`;
  } catch (err) {
    console.error("[retrieval] Failed to retrieve context:", err instanceof Error ? err.message : err);
    return ""; // Fail open — missing context is better than crashing
  }
}
