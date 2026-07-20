/**
 * Knowledge base storage — saves embedded chunks to Postgres and
 * provides retrieval for RAG queries.
 */

import { eq, sql, and, gte } from "drizzle-orm";
import type { Db } from "@/db/client";
import { kbDocuments } from "@/db/schema";
import type { EmbeddedChunk } from "./embedding";

export interface StorageResult {
  stored: number;
  skipped: number;
  failed: number;
}

/**
 * Save successfully embedded chunks to the database.
 * Uses content hash for dedup — same hash = same content, skip insert.
 */
export async function storeChunks(
  db: Db,
  chunks: EmbeddedChunk[]
): Promise<StorageResult> {
  let stored = 0;
  let skipped = 0;
  let failed = 0;

  for (const chunk of chunks) {
    if (chunk.status === "skipped") {
      skipped++;
      continue;
    }

    if (chunk.status === "failed") {
      failed++;
      continue;
    }

    // Only store successfully embedded chunks
    try {
      await db
        .insert(kbDocuments)
        .values(chunk.chunk.row)
        .onConflictDoUpdate({
          target: kbDocuments.id,
          set: {
            content: chunk.chunk.row.content,
            contentHash: chunk.chunk.row.contentHash,
            embedding: chunk.chunk.row.embedding,
            updatedAt: new Date(),
          },
        });
      stored++;
    } catch (err) {
      console.error(
        `[kb-storage] Failed to store chunk: ${err instanceof Error ? err.message : err}`
      );
      failed++;
    }
  }

  return { stored, skipped, failed };
}

/**
 * Get all content hashes currently in the DB for a given source file.
 * Used for change detection during sync.
 */
export async function getExistingHashes(
  db: Db,
  sourceFile?: string
): Promise<Set<string>> {
  const query = sourceFile
    ? db
        .select({ hash: kbDocuments.contentHash })
        .from(kbDocuments)
        .where(eq(kbDocuments.sourceFile, sourceFile))
    : db.select({ hash: kbDocuments.contentHash }).from(kbDocuments);

  const rows = await query;
  return new Set(rows.map((r) => r.hash));
}

/**
 * Get last synced revision for each Dropbox source file.
 * Returns a Map of path → contentHash (we use the hash of the first chunk
 * as a proxy for "has this file changed since last sync").
 */
export async function getLastSyncedFiles(
  db: Db
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      sourceFile: kbDocuments.sourceFile,
      hash: kbDocuments.contentHash,
    })
    .from(kbDocuments)
    .where(sql`${kbDocuments.sourceFile} IS NOT NULL AND ${kbDocuments.chunkIndex} = 0`);

  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.sourceFile) {
      map.set(row.sourceFile, row.hash);
    }
  }
  return map;
}

/**
 * Retrieve chunks by vector similarity for RAG.
 * Optionally filter by category first (hybrid retrieval).
 */
export async function retrieveByVector(
  db: Db,
  queryEmbedding: number[],
  options: {
    category?: string;
    limit?: number;
  } = {}
): Promise<Array<{ content: string; category: string; similarity: number }>> {
  const limit = options.limit ?? 5;
  const vectorStr = `[${queryEmbedding.join(",")}]`;

  let query;
  if (options.category) {
    query = sql`
      SELECT content, category,
             1 - (embedding <=> ${vectorStr}::vector) AS similarity
      FROM kb_documents
      WHERE category = ${options.category}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorStr}::vector
      LIMIT ${limit}
    `;
  } else {
    query = sql`
      SELECT content, category,
             1 - (embedding <=> ${vectorStr}::vector) AS similarity
      FROM kb_documents
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorStr}::vector
      LIMIT ${limit}
    `;
  }

  const rows = await db.execute(query);
  return rows as unknown as Array<{
    content: string;
    category: string;
    similarity: number;
  }>;
}
