import { describe, it, expect } from "vitest";
import {
  contentHash,
  ingestDocument,
  ingestDocuments,
  type IngestionResult,
} from "@/domain/knowledge/ingestion";
import type { DocumentInput } from "@/domain/knowledge/chunking";

const BRAND_DOC: DocumentInput = {
  title: "Brand Philosophy",
  content: "## Our Values\n\nQuality over quantity.\n\n## Our Voice\n\nCasual and warm.",
  category: "brand",
  sourceFile: "00-brand/philosophy.md",
};

const MEETING_DOC: DocumentInput = {
  title: "CTC Meeting Notes",
  content: "## Revenue\n\nUp 15% QoQ.\n\n## Ad Strategy\n\nMore creative diversity.",
  category: "meeting-notes",
  sourceFile: "01-strategy/ctc-2025-06.md",
  documentDate: new Date("2025-06-15"),
};

// ─── Content hashing ──────────────────────────────────────────────────

describe("contentHash", () => {
  it("produces a hex string", () => {
    const hash = contentHash("test content");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("same content produces same hash (deterministic)", () => {
    const a = contentHash("hello world");
    const b = contentHash("hello world");
    expect(a).toBe(b);
  });

  it("different content produces different hash", () => {
    const a = contentHash("hello");
    const b = contentHash("world");
    expect(a).not.toBe(b);
  });
});

// ─── Single document ingestion ────────────────────────────────────────

describe("ingestDocument: basic ingestion", () => {
  it("produces rows from chunked document", () => {
    const result = ingestDocument(BRAND_DOC);
    expect(result.totalChunks).toBeGreaterThan(0);
    expect(result.rows).toHaveLength(result.totalChunks);
  });

  it("sets all chunks as needsEmbedding when no existing hashes", () => {
    const result = ingestDocument(BRAND_DOC);
    expect(result.newChunks).toBe(result.totalChunks);
    expect(result.unchangedChunks).toBe(0);
    for (const chunk of result.rows) {
      expect(chunk.needsEmbedding).toBe(true);
    }
  });

  it("each row has a content hash", () => {
    const result = ingestDocument(BRAND_DOC);
    for (const chunk of result.rows) {
      expect(chunk.row.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("each row has the correct category", () => {
    const result = ingestDocument(BRAND_DOC);
    for (const chunk of result.rows) {
      expect(chunk.row.category).toBe("brand");
    }
  });

  it("each row has the source file", () => {
    const result = ingestDocument(BRAND_DOC);
    for (const chunk of result.rows) {
      expect(chunk.row.sourceFile).toBe("00-brand/philosophy.md");
    }
  });

  it("each row has the document title", () => {
    const result = ingestDocument(BRAND_DOC);
    for (const chunk of result.rows) {
      expect(chunk.row.title).toBe("Brand Philosophy");
    }
  });

  it("each row has embedding set to null (not yet embedded)", () => {
    const result = ingestDocument(BRAND_DOC);
    for (const chunk of result.rows) {
      expect(chunk.row.embedding).toBeNull();
    }
  });

  it("preserves chunk index and total chunks", () => {
    const result = ingestDocument(BRAND_DOC);
    for (let i = 0; i < result.rows.length; i++) {
      expect(result.rows[i].row.chunkIndex).toBe(i);
      expect(result.rows[i].row.totalChunks).toBe(result.totalChunks);
    }
  });

  it("preserves document date for meeting notes", () => {
    const result = ingestDocument(MEETING_DOC);
    for (const chunk of result.rows) {
      expect(chunk.row.documentDate).toEqual(new Date("2025-06-15"));
    }
  });
});

// ─── Change detection ─────────────────────────────────────────────────

describe("ingestDocument: change detection", () => {
  it("marks chunks as unchanged when their hash exists", () => {
    // First ingestion — get the hashes
    const first = ingestDocument(BRAND_DOC);
    const existingHashes = new Set(first.rows.map((r) => r.row.contentHash));

    // Second ingestion with same content — all unchanged
    const second = ingestDocument(BRAND_DOC, existingHashes);
    expect(second.newChunks).toBe(0);
    expect(second.unchangedChunks).toBe(second.totalChunks);
    for (const chunk of second.rows) {
      expect(chunk.needsEmbedding).toBe(false);
    }
  });

  it("detects changed content as new chunks needing embedding", () => {
    const first = ingestDocument(BRAND_DOC);
    const existingHashes = new Set(first.rows.map((r) => r.row.contentHash));

    // Modify the content
    const modified: DocumentInput = {
      ...BRAND_DOC,
      content: "## Our Values\n\nQuality AND quantity now!\n\n## Our Voice\n\nCasual and warm.",
    };
    const second = ingestDocument(modified, existingHashes);
    expect(second.newChunks).toBeGreaterThan(0);
  });

  it("returns summary counts", () => {
    const result = ingestDocument(BRAND_DOC);
    expect(result.documentTitle).toBe("Brand Philosophy");
    expect(result.sourceFile).toBe("00-brand/philosophy.md");
    expect(result.totalChunks).toBe(result.newChunks + result.unchangedChunks);
  });
});

// ─── Empty document ───────────────────────────────────────────────────

describe("ingestDocument: empty content", () => {
  it("produces zero rows for empty document", () => {
    const empty: DocumentInput = {
      title: "Empty",
      content: "",
      category: "brand",
    };
    const result = ingestDocument(empty);
    expect(result.totalChunks).toBe(0);
    expect(result.rows).toHaveLength(0);
  });
});

// ─── Multiple documents ──────────────────────────────────────────────

describe("ingestDocuments: batch ingestion", () => {
  it("ingests multiple documents and returns results for each", () => {
    const results = ingestDocuments([BRAND_DOC, MEETING_DOC]);
    expect(results).toHaveLength(2);
    expect(results[0].documentTitle).toBe("Brand Philosophy");
    expect(results[1].documentTitle).toBe("CTC Meeting Notes");
  });

  it("shares existing hashes across documents", () => {
    // First pass
    const first = ingestDocuments([BRAND_DOC, MEETING_DOC]);
    const allHashes = new Set(
      first.flatMap((r) => r.rows.map((row) => row.row.contentHash))
    );

    // Second pass with same content
    const second = ingestDocuments([BRAND_DOC, MEETING_DOC], allHashes);
    for (const result of second) {
      expect(result.newChunks).toBe(0);
    }
  });
});

// ─── Determinism ──────────────────────────────────────────────────────

describe("ingestDocument: determinism", () => {
  it("same document produces identical hashes every time", () => {
    const a = ingestDocument(BRAND_DOC);
    const b = ingestDocument(BRAND_DOC);
    const hashesA = a.rows.map((r) => r.row.contentHash);
    const hashesB = b.rows.map((r) => r.row.contentHash);
    expect(hashesA).toEqual(hashesB);
  });
});
