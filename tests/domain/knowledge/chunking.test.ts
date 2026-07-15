import { describe, it, expect } from "vitest";
import {
  chunkDocument,
  estimateTokens,
  type DocumentInput,
  type Chunk,
} from "@/domain/knowledge/chunking";

// ─── Token estimation ─────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("estimates roughly 1 token per 4 characters for English", () => {
    const text = "This is a simple test sentence with some words.";
    const estimate = estimateTokens(text);
    // ~48 chars → ~12 tokens. Allow ±30% tolerance.
    expect(estimate).toBeGreaterThan(8);
    expect(estimate).toBeLessThan(20);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

// ─── Small documents: kept whole ──────────────────────────────────────

describe("chunkDocument: small documents stay as one chunk", () => {
  it("keeps a short document as a single chunk", () => {
    const doc: DocumentInput = {
      title: "Brand Colors",
      content: "Primary: #F5F0EB. Accent: #2C2C2C. Background: pastel warm.",
      category: "style",
      sourceFile: "00-brand/colors.md",
    };
    const chunks = chunkDocument(doc, { maxChunkTokens: 500 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("#F5F0EB");
  });

  it("includes context prefix in every chunk", () => {
    const doc: DocumentInput = {
      title: "Brand Colors",
      content: "Primary: #F5F0EB",
      category: "style",
      sourceFile: "00-brand/colors.md",
    };
    const chunks = chunkDocument(doc);
    expect(chunks[0].metadata.contextPrefix).toContain("Brand Colors");
    expect(chunks[0].content).toMatch(/^From/); // starts with context
  });
});

// ─── Heading-based splitting ──────────────────────────────────────────

describe("chunkDocument: splits long docs by markdown headings", () => {
  const longDoc: DocumentInput = {
    title: "Brand Philosophy",
    content: [
      "# Brand Philosophy",
      "",
      "Rad & Happy is about joy in the everyday.",
      "",
      "## Our Values",
      "",
      "We believe in quality over quantity. Every planner is designed with intention.",
      "We don't chase trends. We make things that last.",
      "",
      "## Our Voice",
      "",
      "Casual, warm, enthusiastic. We talk like friends, not corporations.",
      "Emoji are welcome. Exclamation marks are welcome. Corporate jargon is not.",
      "",
      "## Our Aesthetic",
      "",
      "Pastel colors, clean typography, playful illustrations.",
      "Nothing cluttered. White space is our friend.",
    ].join("\n"),
    category: "brand",
  };

  it("splits into multiple chunks at heading boundaries", () => {
    const chunks = chunkDocument(longDoc, { maxChunkTokens: 50 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("each chunk contains content from one section", () => {
    const chunks = chunkDocument(longDoc, { maxChunkTokens: 50 });
    // At least one chunk should contain "Our Values" content
    const valuesChunk = chunks.find((c) => c.content.includes("quality over quantity"));
    expect(valuesChunk).toBeDefined();
  });

  it("sets correct chunkIndex and totalChunks metadata", () => {
    const chunks = chunkDocument(longDoc, { maxChunkTokens: 50 });
    expect(chunks[0].metadata.chunkIndex).toBe(0);
    expect(chunks[0].metadata.totalChunks).toBe(chunks.length);
    expect(chunks[chunks.length - 1].metadata.chunkIndex).toBe(chunks.length - 1);
  });

  it("preserves document title in all chunk metadata", () => {
    const chunks = chunkDocument(longDoc, { maxChunkTokens: 50 });
    for (const chunk of chunks) {
      expect(chunk.metadata.documentTitle).toBe("Brand Philosophy");
      expect(chunk.metadata.category).toBe("brand");
    }
  });
});

// ─── Meeting notes: prepend date ──────────────────────────────────────

describe("chunkDocument: meeting notes include date in context", () => {
  const meetingDoc: DocumentInput = {
    title: "CTC Meeting - Q2 Review",
    content: [
      "## Revenue Update",
      "",
      "Revenue is up 15% QoQ. Subscription revenue growing faster than one-time.",
      "",
      "## Ad Strategy",
      "",
      "CTC recommends increasing creative diversity. Less targeting, more creative.",
      "Test 3 new concepts this month. Focus on UGC-style content.",
    ].join("\n"),
    category: "meeting-notes",
    documentDate: new Date("2025-06-15"),
  };

  it("includes the meeting date in the context prefix", () => {
    const chunks = chunkDocument(meetingDoc, { maxChunkTokens: 50 });
    for (const chunk of chunks) {
      expect(chunk.metadata.contextPrefix).toContain("2025-06-15");
    }
  });

  it("includes the meeting title in context prefix", () => {
    const chunks = chunkDocument(meetingDoc, { maxChunkTokens: 50 });
    expect(chunks[0].metadata.contextPrefix).toContain("CTC Meeting");
  });
});

// ─── Testimonials: one per chunk ──────────────────────────────────────

describe("chunkDocument: testimonials kept atomic", () => {
  const testimonialDoc: DocumentInput = {
    title: "Customer Testimonials",
    content: [
      "## Sarah M.",
      "",
      '"This planner changed my life! I finally feel organized."',
      "",
      "## Jake P.",
      "",
      '"Best quality paper I\'ve ever seen in a planner. Worth every penny."',
      "",
      "## Lisa R.",
      "",
      '"I bought one for every member of my team. They all love them!"',
    ].join("\n"),
    category: "testimonials",
  };

  it("splits each testimonial into its own chunk", () => {
    const chunks = chunkDocument(testimonialDoc, { maxChunkTokens: 500 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it("each chunk contains one testimonial", () => {
    const chunks = chunkDocument(testimonialDoc, { maxChunkTokens: 500 });
    const sarahChunk = chunks.find((c) => c.content.includes("Sarah M."));
    expect(sarahChunk).toBeDefined();
    // Sarah's chunk should not contain Jake's quote
    expect(sarahChunk!.content).not.toContain("Jake P.");
  });
});

// ─── Determinism ──────────────────────────────────────────────────────

describe("chunkDocument: determinism", () => {
  it("same document produces identical chunks every time", () => {
    const doc: DocumentInput = {
      title: "Test",
      content: "## Section A\nContent A\n\n## Section B\nContent B",
      category: "brand",
    };
    const a = chunkDocument(doc, { maxChunkTokens: 30 });
    const b = chunkDocument(doc, { maxChunkTokens: 30 });
    expect(a).toEqual(b);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────

describe("chunkDocument: edge cases", () => {
  it("handles empty content", () => {
    const doc: DocumentInput = {
      title: "Empty",
      content: "",
      category: "brand",
    };
    const chunks = chunkDocument(doc);
    expect(chunks).toHaveLength(0);
  });

  it("handles content with no headings", () => {
    const doc: DocumentInput = {
      title: "Flat Text",
      content: "Just a paragraph of text with no markdown headings at all. ".repeat(20),
      category: "brand",
    };
    const chunks = chunkDocument(doc, { maxChunkTokens: 50 });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // All content should be present across chunks
    const allContent = chunks.map((c) => c.content).join(" ");
    expect(allContent).toContain("Just a paragraph");
  });
});
