import { describe, it, expect, vi } from "vitest";
import { embedChunks } from "@/domain/knowledge/embedding";
import { createMockEmbeddingClient } from "../../mocks/openai";
import type { IngestedChunk } from "@/domain/knowledge/ingestion";
import type { NewKbDocument } from "@/db/schema";

function makeChunk(id: string, needsEmbedding: boolean): IngestedChunk {
  return {
    needsEmbedding,
    row: {
      title: `Doc ${id}`,
      content: `Content for ${id}`,
      category: "brand",
      contentHash: `hash_${id}`,
      chunkIndex: 0,
      totalChunks: 1,
      contextPrefix: `From Doc ${id}:`,
      embedding: null,
    } as NewKbDocument,
  };
}

// ─── Basic embedding ──────────────────────────────────────────────────

describe("embedChunks: embeds chunks that need it", () => {
  it("embeds chunks with needsEmbedding=true", async () => {
    const client = createMockEmbeddingClient();
    const chunks = [makeChunk("a", true), makeChunk("b", true)];

    const result = await embedChunks(chunks, client);

    expect(result.embedded).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    // Each embedded chunk should have a vector
    for (const ec of result.chunks) {
      if (ec.status === "embedded") {
        expect(ec.chunk.row.embedding).not.toBeNull();
        expect((ec.chunk.row.embedding as number[]).length).toBe(1536);
      }
    }
  });

  it("skips chunks with needsEmbedding=false", async () => {
    const client = createMockEmbeddingClient();
    const chunks = [makeChunk("a", false), makeChunk("b", false)];

    const result = await embedChunks(chunks, client);

    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(2);
    expect(client.embed).not.toHaveBeenCalled();
  });

  it("handles mix of needs-embedding and skip", async () => {
    const client = createMockEmbeddingClient();
    const chunks = [
      makeChunk("new", true),
      makeChunk("existing", false),
      makeChunk("also-new", true),
    ];

    const result = await embedChunks(chunks, client);

    expect(result.total).toBe(3);
    expect(result.embedded).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it("calls the embedding client with chunk content", async () => {
    const client = createMockEmbeddingClient();
    const chunks = [makeChunk("test", true)];

    await embedChunks(chunks, client);

    expect(client.embed).toHaveBeenCalledWith("Content for test");
  });
});

// ─── Error handling (fail closed) ─────────────────────────────────────

describe("embedChunks: fail closed on API errors", () => {
  it("marks chunk as failed when embed throws", async () => {
    const client = createMockEmbeddingClient({
      embed: vi.fn().mockRejectedValue(new Error("Rate limit exceeded")),
    });
    const chunks = [makeChunk("a", true)];

    const result = await embedChunks(chunks, client);

    expect(result.failed).toBe(1);
    expect(result.embedded).toBe(0);
    expect(result.chunks[0].status).toBe("failed");
    expect(result.chunks[0].error).toContain("Rate limit");
  });

  it("does NOT leave embedding as null on success", async () => {
    const client = createMockEmbeddingClient();
    const chunks = [makeChunk("a", true)];

    const result = await embedChunks(chunks, client);

    // A successfully embedded chunk must have a vector, never null
    const embedded = result.chunks.find((c) => c.status === "embedded");
    expect(embedded).toBeDefined();
    expect(embedded!.chunk.row.embedding).not.toBeNull();
  });

  it("continues processing after a single chunk fails", async () => {
    let callCount = 0;
    const client = createMockEmbeddingClient({
      embed: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("Transient error");
        return { embedding: Array(1536).fill(0.01), tokenCount: 50 };
      }),
    });

    const chunks = [makeChunk("fail", true), makeChunk("succeed", true)];
    const result = await embedChunks(chunks, client);

    expect(result.failed).toBe(1);
    expect(result.embedded).toBe(1);
  });
});

// ─── Empty input ──────────────────────────────────────────────────────

describe("embedChunks: edge cases", () => {
  it("handles empty chunks array", async () => {
    const client = createMockEmbeddingClient();
    const result = await embedChunks([], client);

    expect(result.total).toBe(0);
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.chunks).toHaveLength(0);
  });
});
