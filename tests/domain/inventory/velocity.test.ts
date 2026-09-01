import { describe, it, expect } from "vitest";
import { computeDailyVelocity, computeDaysOfCover } from "@/domain/inventory/velocity";

describe("computeDailyVelocity", () => {
  it("divides units sold by the window length", () => {
    expect(computeDailyVelocity(60, 30)).toBe(2);
  });

  it("returns 0 when nothing sold", () => {
    expect(computeDailyVelocity(0, 30)).toBe(0);
  });

  it("returns 0 for a zero-length window rather than dividing by zero", () => {
    expect(computeDailyVelocity(60, 0)).toBe(0);
  });
});

describe("computeDaysOfCover", () => {
  it("divides stock on hand by daily velocity", () => {
    expect(computeDaysOfCover(20, 2)).toBe(10);
  });

  it("returns null when there is no velocity — cover is effectively infinite", () => {
    expect(computeDaysOfCover(20, 0)).toBeNull();
  });

  it("returns 0 when out of stock", () => {
    expect(computeDaysOfCover(0, 2)).toBe(0);
  });

  it("treats negative stock (oversold) as 0 days of cover", () => {
    expect(computeDaysOfCover(-5, 2)).toBe(0);
  });
});
