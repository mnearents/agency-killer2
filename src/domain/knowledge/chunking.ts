/**
 * Knowledge base document chunking — splits documents into embeddable chunks.
 *
 * Different document types need different strategies:
 * - Brand docs: split by heading, keep sections intact
 * - Meeting notes: split by agenda item, prepend date + source
 * - Testimonials: one chunk per testimonial (usually small)
 * - Product info: one chunk per product
 *
 * Every chunk must be self-contained: a reader seeing only that chunk
 * must understand what it's about and where it came from.
 */

export type DocumentCategory =
  | "brand"
  | "strategy"
  | "creative"
  | "meeting-notes"
  | "product"
  | "testimonials"
  | "email-sms"
  | "video"
  | "style"
  | "voice";

export interface DocumentInput {
  title: string;
  content: string;
  category: DocumentCategory;
  sourceFile?: string;
  documentDate?: Date;
}

export interface Chunk {
  content: string;
  metadata: {
    documentTitle: string;
    category: DocumentCategory;
    chunkIndex: number;
    totalChunks: number;
    sourceFile?: string;
    documentDate?: Date;
    contextPrefix: string;
  };
}

export interface ChunkingOptions {
  maxChunkTokens?: number; // default 500
  overlapTokens?: number; // default 75
}

const DEFAULT_MAX_TOKENS = 500;

/**
 * Estimate token count from text. Rough heuristic: ~1 token per 4 chars
 * for English text. Good enough for chunking decisions.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Build a context prefix so each chunk is self-contained.
 */
function buildContextPrefix(doc: DocumentInput): string {
  let prefix = `From "${doc.title}"`;
  if (doc.documentDate) {
    prefix += ` (${doc.documentDate.toISOString().split("T")[0]})`;
  }
  if (doc.sourceFile) {
    prefix += ` [${doc.sourceFile}]`;
  }
  return prefix + ":";
}

/**
 * Split markdown text into sections by heading boundaries.
 * Each section includes its heading and all content until the next heading.
 */
function splitByHeadings(content: string): string[] {
  // Split on lines that start with # (any level)
  const parts = content.split(/(?=^#{1,3}\s)/m);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Split a long section into smaller chunks by paragraph,
 * respecting the token limit.
 */
function splitByParagraph(
  text: string,
  maxTokens: number
): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const combined = current ? current + "\n\n" + para : para;
    if (estimateTokens(combined) > maxTokens && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = combined;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks;
}

export function chunkDocument(
  doc: DocumentInput,
  options?: ChunkingOptions
): Chunk[] {
  const maxTokens = options?.maxChunkTokens ?? DEFAULT_MAX_TOKENS;

  if (!doc.content || doc.content.trim() === "") {
    return [];
  }

  const contextPrefix = buildContextPrefix(doc);

  // Split by headings first
  let sections = splitByHeadings(doc.content);

  // If no headings found, treat whole content as one section
  if (sections.length === 0) {
    sections = [doc.content.trim()];
  }

  // For testimonials, each heading = one chunk (don't merge)
  // For other types, merge small sections, split large ones
  const rawChunks: string[] = [];

  if (doc.category === "testimonials") {
    // Each section is its own chunk
    for (const section of sections) {
      rawChunks.push(section);
    }
  } else {
    // Merge small adjacent sections, split large ones
    let current = "";
    for (const section of sections) {
      const combined = current ? current + "\n\n" + section : section;
      if (estimateTokens(combined) > maxTokens && current) {
        rawChunks.push(current.trim());
        // If this section alone exceeds the limit, split it further
        if (estimateTokens(section) > maxTokens) {
          rawChunks.push(...splitByParagraph(section, maxTokens));
        } else {
          current = section;
        }
      } else {
        current = combined;
      }
    }
    if (current.trim()) {
      // Final section might exceed limit
      if (estimateTokens(current) > maxTokens) {
        rawChunks.push(...splitByParagraph(current, maxTokens));
      } else {
        rawChunks.push(current.trim());
      }
    }
  }

  // Build final chunks with metadata and context prefix
  const totalChunks = rawChunks.length;
  return rawChunks.map((content, i) => ({
    content: `${contextPrefix}\n\n${content}`,
    metadata: {
      documentTitle: doc.title,
      category: doc.category,
      chunkIndex: i,
      totalChunks,
      sourceFile: doc.sourceFile,
      documentDate: doc.documentDate,
      contextPrefix,
    },
  }));
}
