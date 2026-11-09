import { describe, it, expect } from "vitest";
import { parseReviewText } from "@/lib/review-text";

describe("parseReviewText", () => {
  it("splits paragraphs on blank lines", () => {
    expect(parseReviewText("One.\n\nTwo\nlines.")).toEqual([
      { type: "p", parts: [{ text: "One.", bold: false }] },
      { type: "p", parts: [{ text: "Two lines.", bold: false }] },
    ]);
  });

  it("reads `- ` and `* ` lines as a list", () => {
    expect(parseReviewText("Try:\n- Open with a question\n* Post at 7pm")).toEqual([
      { type: "p", parts: [{ text: "Try:", bold: false }] },
      { type: "ul", items: [[{ text: "Open with a question", bold: false }], [{ text: "Post at 7pm", bold: false }]] },
    ]);
  });

  it("reads numbered lines as an ordered list", () => {
    expect(parseReviewText("1. First\n2. Second")[0]).toMatchObject({ type: "ol", items: [[{ text: "First" }], [{ text: "Second" }]] });
  });

  it("bolds **marked** text and nothing else", () => {
    expect(parseReviewText("The **planner flip** reel")[0]).toEqual({
      type: "p",
      parts: [{ text: "The ", bold: false }, { text: "planner flip", bold: true }, { text: " reel", bold: false }],
    });
  });

  // It is rendered as React text, so markup in a review is shown, never run.
  it("passes HTML through as plain text", () => {
    expect(parseReviewText("<script>x</script>")[0]).toEqual({ type: "p", parts: [{ text: "<script>x</script>", bold: false }] });
  });

  it("returns nothing for blank input", () => {
    expect(parseReviewText("  \n\n ")).toEqual([]);
  });
});

describe("parseReviewText — emphasis", () => {
  it("italicises *single-starred* text", () => {
    expect(parseReviewText("what *you* have")[0]).toEqual({
      type: "p",
      parts: [{ text: "what ", bold: false }, { text: "you", bold: false, italic: true }, { text: " have", bold: false }],
    });
  });

  it("leaves a lone star alone", () => {
    expect(parseReviewText("5 * 3 stars")[0]).toEqual({ type: "p", parts: [{ text: "5 * 3 stars", bold: false }] });
  });
});
