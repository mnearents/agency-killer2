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
