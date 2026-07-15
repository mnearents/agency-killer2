/**
 * Knowledge base ingestion — transforms raw documents into DB-ready rows.
 *
 * Pipeline: raw document → chunk → hash → NewKbDocument rows.
 *
 * Change detection: each chunk gets a SHA-256 hash of its content.
 * On re-ingestion, only chunks with changed hashes need re-embedding.
 * This avoids re-embedding unchanged documents (saving API cost).
 */

import { createHash } from "crypto";
import {
  chunkDocument,
  type DocumentInput,
  type ChunkingOptions,
} from "./chunking";
import type { NewKbDocument } from "@/db/schema";

export interface IngestedChunk {
  row: NewKbDocument;
  needsEmbedding: boolean;
}

export interface IngestionResult {
  documentTitle: string;
  sourceFile: string | undefined;
  totalChunks: number;
  newChunks: number;
  unchangedChunks: number;
  rows: IngestedChunk[];
}

/**
 * Compute SHA-256 hash of content for change detection.
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Ingest a single document: chunk it, hash each chunk, and produce
 * DB-ready rows. Compare against existing hashes to determine which
 * chunks need re-embedding.
 *
 * @param doc - The raw document to ingest
 * @param existingHashes - Set of content hashes already in the DB for this source
 * @param options - Chunking options
 */
export function ingestDocument(
  doc: DocumentInput,
  existingHashes: Set<string> = new Set(),
  options?: ChunkingOptions
): IngestionResult {
  const chunks = chunkDocument(doc, options);

  let newChunks = 0;
  let unchangedChunks = 0;

  const rows: IngestedChunk[] = chunks.map((chunk) => {
    const hash = contentHash(chunk.content);
    const isNew = !existingHashes.has(hash);

    if (isNew) {
      newChunks++;
    } else {
      unchangedChunks++;
    }

    const row: NewKbDocument = {
      title: chunk.metadata.documentTitle,
      content: chunk.content,
      category: chunk.metadata.category,
      sourceFile: chunk.metadata.sourceFile ?? null,
      contentHash: hash,
      chunkIndex: chunk.metadata.chunkIndex,
      totalChunks: chunk.metadata.totalChunks,
      contextPrefix: chunk.metadata.contextPrefix,
      documentDate: chunk.metadata.documentDate ?? null,
      embedding: null, // filled after embedding API call
    };

    return { row, needsEmbedding: isNew };
  });

  return {
    documentTitle: doc.title,
    sourceFile: doc.sourceFile,
    totalChunks: chunks.length,
    newChunks,
    unchangedChunks,
    rows,
  };
}

/**
 * Ingest multiple documents, returning all results.
 */
export function ingestDocuments(
  docs: DocumentInput[],
  existingHashes: Set<string> = new Set(),
  options?: ChunkingOptions
): IngestionResult[] {
  return docs.map((doc) => ingestDocument(doc, existingHashes, options));
}
