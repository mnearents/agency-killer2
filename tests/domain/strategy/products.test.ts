import { describe, it, expect } from "vitest";
import {
  mergeStrategy,
  parseAudiences,
  isInSeason,
  EMPTY_STRATEGY,
  type StrategyFields,
} from "@/domain/strategy/products";

const current: StrategyFields = {
  role: "grow",
  audiences: ["teachers", "homeschool"],
  seasonStartMonth: 7,
  seasonEndMonth: 9,
  priorityRank: 3,
  notes: "Back to school",
};

describe("mergeStrategy", () => {
  // A call that changes the role must not wipe the audiences someone set.
  it("carries forward every field the change does not name", () => {
    expect(mergeStrategy(current, { role: "hero" })).toEqual({ ...current, role: "hero" });
  });

  it("starts from nothing for a product with no strategy yet", () => {
    expect(mergeStrategy(null, { role: "sunset" })).toEqual({ ...EMPTY_STRATEGY, role: "sunset" });
  });

  it("clears the fields it is told to clear", () => {
    expect(mergeStrategy(current, { clear: ["seasonStartMonth", "seasonEndMonth", "notes"] })).toEqual({
      ...current, seasonStartMonth: null, seasonEndMonth: null, notes: null,
    });
  });

  it("refuses a change that changes nothing", () => {
    expect(() => mergeStrategy(current, { role: "grow" })).toThrow(/changes nothing/);
  });

  // Half a season is not a season: an end with no start cannot be placed.
  it("refuses a season with only one end", () => {
    expect(() => mergeStrategy(null, { seasonStartMonth: 11 })).toThrow(/both seasonStartMonth and seasonEndMonth/);
  });

  it("refuses an unknown role", () => {
    expect(() => mergeStrategy(null, { role: "cash-cow" })).toThrow(/role must be one of/);
  });
});

describe("parseAudiences", () => {
  it("reads a comma-separated list, trimmed and deduplicated", () => {
    expect(parseAudiences(" teachers, homeschool ,teachers")).toEqual(["teachers", "homeschool"]);
  });

  // A misspelled audience silently dropped would leave the product unfindable
  // by the audience it was meant for.
  it("refuses an audience that is not in the vocabulary, naming it", () => {
    expect(() => parseAudiences("teachers, moms")).toThrow(/"moms".*one of/);
  });

  it("reads an empty string as no audiences", () => {
    expect(parseAudiences("")).toEqual([]);
  });
});

describe("isInSeason", () => {
  it("is in season inside the window", () => {
    expect(isInSeason({ seasonStartMonth: 7, seasonEndMonth: 9 }, 8)).toBe(true);
    expect(isInSeason({ seasonStartMonth: 7, seasonEndMonth: 9 }, 10)).toBe(false);
  });

  // Holiday products run November to January.
  it("handles a window that wraps the year", () => {
    expect(isInSeason({ seasonStartMonth: 11, seasonEndMonth: 1 }, 12)).toBe(true);
    expect(isInSeason({ seasonStartMonth: 11, seasonEndMonth: 1 }, 1)).toBe(true);
    expect(isInSeason({ seasonStartMonth: 11, seasonEndMonth: 1 }, 6)).toBe(false);
  });

  it("is null, not true, when no season was set", () => {
    expect(isInSeason({ seasonStartMonth: null, seasonEndMonth: null }, 6)).toBeNull();
  });
});
