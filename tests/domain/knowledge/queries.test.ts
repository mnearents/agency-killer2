import { describe, it, expect } from "vitest";
import { searchableShare, type KbCoverage } from "@/domain/knowledge/queries";

/** The live shape: social-transcript is mostly unembedded. */
const COVERAGE: KbCoverage[] = [
  { category: "social-transcript", chunks: 134, embedded: 49, files: 134 },
  { category: "strategy", chunks: 19, embedded: 19, files: 9 },
  { category: "brand", chunks: 3, embedded: 3, files: 2 },
];

describe("searchableShare", () => {
  // A chunk with no embedding is present, listed, and can never be returned by
  // a vector search — which reports success either way.
  it("reports how much of the whole base a semantic search can reach", () => {
    expect(searchableShare(COVERAGE)).toEqual({ chunks: 156, embedded: 71, share: 0.4551 });
  });

  it("narrows to one category when the search is scoped", () => {
    expect(searchableShare(COVERAGE, "strategy")).toEqual({ chunks: 19, embedded: 19, share: 1 });
  });

  it("shows a mostly-unsearchable category as such", () => {
    const share = searchableShare(COVERAGE, "social-transcript");
    expect(share.share).toBeLessThan(0.4);
    expect(share.chunks - share.embedded).toBe(85);
  });

  // Zero over zero must not become a confident 1.0 — an empty category is not
  // a fully searchable one.
  it("reports zero rather than dividing by zero for an unknown category", () => {
    expect(searchableShare(COVERAGE, "nope")).toEqual({ chunks: 0, embedded: 0, share: 0 });
  });

  it("reports zero for an empty knowledge base", () => {
    expect(searchableShare([])).toEqual({ chunks: 0, embedded: 0, share: 0 });
  });

  it("reports a fully embedded base as fully searchable", () => {
    expect(searchableShare([{ category: "brand", chunks: 5, embedded: 5, files: 1 }]).share).toBe(1);
  });
});

import { judgeRelevance, WEAK_MATCH_SIMILARITY, type KbHit } from "@/domain/knowledge/queries";

const hit = (over: Partial<KbHit> = {}): KbHit => ({
  id: "c1", title: "philosophy", category: "brand", subcategory: null,
  sourceFile: "/rad/agency/00-brand/philosophy.md", chunkIndex: 0, totalChunks: 1,
  documentDate: null, content: "…", similarity: 0.42, ...over,
});

describe("judgeRelevance", () => {
  it("calls a good match strong", () => {
    const v = judgeRelevance([hit({ similarity: 0.49 })]);
    expect(v.relevance).toBe("strong");
    expect(v.topSimilarity).toBe(0.49);
  });

  // A vector search always returns its limit, so an off-topic query produces a
  // full, confident-looking result set. Measured: real questions top out at
  // 0.39-0.49 here, deliberately absurd ones at 0.15-0.20.
  it("calls an off-topic result set weak", () => {
    const v = judgeRelevance([
      hit({ similarity: 0.2026 }), hit({ similarity: 0.1745, sourceFile: "/b.md" }),
    ]);
    expect(v.relevance).toBe("weak");
    expect(v.note).toMatch(/closest chunks rather than relevant/);
  });

  it("warns against quoting a weak result as what the brand says", () => {
    expect(judgeRelevance([hit({ similarity: 0.1 })]).note).toMatch(/Do not quote/);
  });

  it("judges on the best hit, not the worst", () => {
    const v = judgeRelevance([hit({ similarity: 0.45 }), hit({ similarity: 0.05, sourceFile: "/b.md" })]);
    expect(v.relevance).toBe("strong");
    expect(v.topSimilarity).toBe(0.45);
  });

  it("treats the threshold as exclusive, so exactly at it is strong", () => {
    expect(judgeRelevance([hit({ similarity: WEAK_MATCH_SIMILARITY })]).relevance).toBe("strong");
  });

  // Empty and irrelevant are different states needing different responses.
  it("calls an empty result set none, not weak", () => {
    const v = judgeRelevance([]);
    expect(v).toMatchObject({ relevance: "none", topSimilarity: null, distinctDocuments: 0 });
  });

  // Three chunks of one file is one source dressed as three, and a caller
  // counting results would overstate how much supports an answer.
  it("counts distinct documents, not chunks", () => {
    const v = judgeRelevance([
      hit({ chunkIndex: 0 }), hit({ chunkIndex: 1 }), hit({ chunkIndex: 2 }),
    ]);
    expect(v.distinctDocuments).toBe(1);
    expect(v.note).toMatch(/one source, not 3/);
  });

  it("does not warn about one source when the hits come from several", () => {
    const v = judgeRelevance([hit(), hit({ sourceFile: "/b.md" })]);
    expect(v.distinctDocuments).toBe(2);
    expect(v.note).toBeUndefined();
  });

  it("does not warn about one source for a single hit", () => {
    expect(judgeRelevance([hit()]).note).toBeUndefined();
  });

  // A text search has no score; absence of one must not read as irrelevance.
  it("does not call an unscored text result weak", () => {
    const v = judgeRelevance([hit({ similarity: null })]);
    expect(v.relevance).toBe("strong");
    expect(v.topSimilarity).toBeNull();
  });
});
