import { describe, it, expect } from "vitest";
import { buildPhotoPrompt, parsePhotoDescription, matchProducts, visionCost, UNKNOWN_PRODUCT } from "@/domain/photos/vision";

const TITLES = ["2027 Planner - 8x10 Dated", "2027 Planner - 5x8 Undated", "Really Awesome Doodles"];

const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    description: "An open planner on a wooden desk beside a mug.",
    products: ["2027 Planner - 8x10 Dated"],
    shotType: "inside pages",
    people: ["hands only"],
    background: "warm neutral",
    visibleText: "NOVEMBER",
    subjectPosition: "left",
    headlineSpace: "right",
    qualityFlags: ["sharp", "shallow focus"],
    suggestedUses: ["email hero", "ad static"],
    ...over,
  });

describe("buildPhotoPrompt", () => {
  it("gives the model the file's place and every product title to choose from", () => {
    const prompt = buildPhotoPrompt({ folder: "Planners/2027 planner pictures/8x10 dated", name: "x.jpg", productTitles: TITLES });
    expect(prompt).toContain('"Planners/2027 planner pictures/8x10 dated/x.jpg"');
    for (const t of TITLES) expect(prompt).toContain(`- ${t}`);
    expect(prompt).toMatch(/Never guess/);
  });
});

describe("parsePhotoDescription", () => {
  it("reads a complete answer", () => {
    expect(parsePhotoDescription(`Here it is:\n${answer()}`, TITLES)).toEqual({
      description: "An open planner on a wooden desk beside a mug.",
      products: ["2027 Planner - 8x10 Dated"],
      shotType: "inside pages",
      people: ["hands only"],
      background: "warm neutral",
      visibleText: "NOVEMBER",
      subjectPosition: "left",
      headlineSpace: "right",
      qualityFlags: ["sharp", "shallow focus"],
      suggestedUses: ["email hero", "ad static"],
    });
  });

  it("fails closed on anything that is not a usable answer", () => {
    for (const bad of [
      "no json here",
      "{not json}",
      "[1,2]",
      answer({ description: "" }),
      answer({ shotType: "portrait" }),
      answer({ background: "blue" }),
      answer({ subjectPosition: "everywhere" }),
      answer({ people: [] }),
      answer({ headlineSpace: "middle" }),
      answer({ headlineSpace: undefined }),
    ]) {
      expect(parsePhotoDescription(bad, TITLES)).toBeNull();
    }
  });

  it("keeps a picture with no headline space and no text", () => {
    const parsed = parsePhotoDescription(answer({ headlineSpace: null, visibleText: null }), TITLES)!;
    expect(parsed.headlineSpace).toBeNull();
    expect(parsed.visibleText).toBeNull();
  });

  it("drops none when someone is also there, and unknown quality or use words", () => {
    const parsed = parsePhotoDescription(answer({ people: ["none", "child"], qualityFlags: ["sharp", "gorgeous"], suggestedUses: ["billboard"] }), TITLES)!;
    expect(parsed.people).toEqual(["child"]);
    expect(parsed.qualityFlags).toEqual(["sharp"]);
    expect(parsed.suggestedUses).toEqual([]);
  });
});

describe("matchProducts", () => {
  it("returns titles exactly as Shopify has them, whatever the case", () => {
    expect(matchProducts(["really awesome doodles"], TITLES)).toEqual(["Really Awesome Doodles"]);
  });

  it("keeps an empty list: no product in the picture", () => {
    expect(matchProducts([], TITLES)).toEqual([]);
  });

  // Never guess: a name that is not a title, even beside a real one, makes the list unknown.
  it("records unknown for a name that is not one of the titles", () => {
    expect(matchProducts(["2027 Planner"], TITLES)).toEqual([UNKNOWN_PRODUCT]);
    expect(matchProducts(["Really Awesome Doodles", "Doodle Kit"], TITLES)).toEqual([UNKNOWN_PRODUCT]);
    expect(matchProducts(["unknown"], TITLES)).toEqual([UNKNOWN_PRODUCT]);
    expect(matchProducts("Really Awesome Doodles", TITLES)).toEqual([UNKNOWN_PRODUCT]);
  });
});

describe("visionCost", () => {
  it("prices tokens at the model's rate, in dollars", () => {
    expect(visionCost(1_000_000, 100_000)).toBe(4.5);
  });
});
