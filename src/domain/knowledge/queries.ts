/**
 * Reads over the knowledge base, for the MCP surface.
 *
 * Deliberately not `retrieveContext`, which fails open and returns `""` on
 * error. That is right for prompt injection — missing context beats a crash —
 * and wrong for a tool, where "the knowledge base has nothing on this" and
 * "the embedding call failed" need opposite responses from the caller. Here
 * the two are different return values.
 *
 * ## Only some chunks are searchable
 *
 * Vector search filters on `embedding IS NOT NULL`, and against production 85
 * of 174 chunks have no embedding — `social-transcript` alone holds 134 chunks
 * with 49 embedded. Those chunks exist, are listed, and can never be found by
 * a search, which reports success either way. So every search returns how much
 * of its scope was actually searchable.
 */

import { sql, eq, and, desc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { kbDocuments } from "@/db/schema";

export interface KbCoverage {
  category: string;
  chunks: number;
  /** Chunks a vector search can reach. The rest are invisible to it. */
  embedded: number;
  files: number;
}

export async function getKbCoverage(db: Db): Promise<KbCoverage[]> {
  return db
    .select({
      category: kbDocuments.category,
      chunks: sql<number>`count(*)::int`,
      embedded: sql<number>`count(${kbDocuments.embedding})::int`,
      files: sql<number>`count(distinct ${kbDocuments.sourceFile})::int`,
    })
    .from(kbDocuments)
    .groupBy(kbDocuments.category)
    .orderBy(sql`count(*) desc`);
}

export interface KbHit {
  id: string;
  title: string;
  category: string;
  subcategory: string | null;
  sourceFile: string | null;
  chunkIndex: number;
  totalChunks: number;
  documentDate: string | null;
  content: string;
  /** Cosine similarity, 0-1. Null on a text match, where there is no score. */
  similarity: number | null;
}

/** Vector search. Only reaches chunks that have an embedding. */
export async function searchKbByVector(
  db: Db,
  queryEmbedding: number[],
  options: { category?: string; limit: number },
): Promise<KbHit[]> {
  const vector = `[${queryEmbedding.join(",")}]`;
  const rows = await db.execute(sql`
    select id, title, category, subcategory,
           source_file as "sourceFile",
           chunk_index as "chunkIndex", total_chunks as "totalChunks",
           document_date::text as "documentDate",
           content,
           round((1 - (embedding <=> ${vector}::vector))::numeric, 4) as similarity
    from kb_documents
    where embedding is not null
      ${options.category ? sql`and category = ${options.category}` : sql``}
    order by embedding <=> ${vector}::vector
    limit ${options.limit}
  `);
  return (rows as unknown as KbHit[]).map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

/**
 * Literal text search, for when no embedding client is configured.
 *
 * A worse search returning plausible results under the same name as the good
 * one is the failure this exists to avoid, so callers must label which they
 * used. It finds nothing a vector search would have found by meaning, and it
 * does reach the 85 chunks that have no embedding.
 */
export async function searchKbByText(
  db: Db,
  text: string,
  options: { category?: string; limit: number },
): Promise<KbHit[]> {
  const needle = `%${text}%`;
  const where = options.category
    ? and(
        eq(kbDocuments.category, options.category),
        sql`(${kbDocuments.content} ilike ${needle} or ${kbDocuments.title} ilike ${needle})`,
      )
    : sql`(${kbDocuments.content} ilike ${needle} or ${kbDocuments.title} ilike ${needle})`;

  const rows = await db
    .select({
      id: kbDocuments.id,
      title: kbDocuments.title,
      category: kbDocuments.category,
      subcategory: kbDocuments.subcategory,
      sourceFile: kbDocuments.sourceFile,
      chunkIndex: kbDocuments.chunkIndex,
      totalChunks: kbDocuments.totalChunks,
      documentDate: sql<string | null>`${kbDocuments.documentDate}::text`,
      content: kbDocuments.content,
    })
    .from(kbDocuments)
    .where(where)
    .limit(options.limit);

  return rows.map((r) => ({ ...r, similarity: null }));
}

export interface KbDocumentSummary {
  title: string;
  category: string;
  subcategory: string | null;
  sourceFile: string | null;
  chunks: number;
  embedded: number;
  documentDate: string | null;
  updatedAt: string;
}

export async function listKbDocuments(
  db: Db,
  options: { category?: string; limit: number },
): Promise<{ rows: KbDocumentSummary[]; matched: number }> {
  const where = options.category ? eq(kbDocuments.category, options.category) : undefined;

  const [{ matched }] = await db
    .select({ matched: sql<number>`count(distinct ${kbDocuments.title})::int` })
    .from(kbDocuments)
    .where(where);

  const rows = await db
    .select({
      title: kbDocuments.title,
      category: kbDocuments.category,
      subcategory: sql<string | null>`min(${kbDocuments.subcategory})`,
      sourceFile: sql<string | null>`min(${kbDocuments.sourceFile})`,
      chunks: sql<number>`count(*)::int`,
      embedded: sql<number>`count(${kbDocuments.embedding})::int`,
      documentDate: sql<string | null>`max(${kbDocuments.documentDate})::text`,
      updatedAt: sql<string>`max(${kbDocuments.updatedAt})::text`,
    })
    .from(kbDocuments)
    .where(where)
    .groupBy(kbDocuments.title, kbDocuments.category)
    .orderBy(desc(sql`max(${kbDocuments.updatedAt})`))
    .limit(options.limit);

  return { rows, matched };
}

/** How much of a search's scope a vector search could actually reach. */
export function searchableShare(
  coverage: KbCoverage[],
  category?: string,
): { chunks: number; embedded: number; share: number } {
  const scope = category ? coverage.filter((c) => c.category === category) : coverage;
  const chunks = scope.reduce((s, c) => s + c.chunks, 0);
  const embedded = scope.reduce((s, c) => s + c.embedded, 0);
  return { chunks, embedded, share: chunks === 0 ? 0 : Number((embedded / chunks).toFixed(4)) };
}
