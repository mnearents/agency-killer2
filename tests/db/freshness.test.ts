import { describe, it, expect } from "vitest";
import { classifyFreshness, type RawFreshness } from "@/db/freshness";

const NOW = new Date("2026-09-02T12:00:00Z");

function raw(overrides: Partial<RawFreshness> = {}): RawFreshness {
  return {
    source: "Meta ads",
    table: "meta_insights",
    basis: "synced",
    staleAfterHours: 36,
    rows: 1200,
    lastAt: new Date("2026-09-02T06:00:00Z"),
    ...overrides,
  };
}

describe("classifyFreshness", () => {
  it("reports how many hours old the data is", () => {
    const [result] = classifyFreshness([raw()], NOW);
    expect(result.ageHours).toBe(6);
  });

  it("marks a source synced within its window as fresh", () => {
    const [result] = classifyFreshness([raw()], NOW);
    expect(result.stale).toBe(false);
  });

  it("marks a source past its window as stale", () => {
    const [result] = classifyFreshness(
      [raw({ lastAt: new Date("2026-08-31T00:00:00Z") })],
      NOW
    );
    expect(result.stale).toBe(true);
  });

  it("respects a longer window for manually imported sources", () => {
    const [result] = classifyFreshness(
      [raw({ staleAfterHours: 336, lastAt: new Date("2026-08-25T12:00:00Z") })],
      NOW
    );
    expect(result.stale).toBe(false);
  });

  // A source that has never synced is the most important thing to surface —
  // it must never read as "fine, just no data".
  it("treats a source that has never synced as stale", () => {
    const [result] = classifyFreshness([raw({ lastAt: null, rows: 0 })], NOW);
    expect(result.stale).toBe(true);
    expect(result.ageHours).toBeNull();
    expect(result.lastAt).toBeNull();
  });

  it("treats an empty table as stale even if something wrote a timestamp", () => {
    const [result] = classifyFreshness([raw({ rows: 0 })], NOW);
    expect(result.stale).toBe(true);
  });

  it("says whether a timestamp means 'last synced' or 'latest data point'", () => {
    const results = classifyFreshness(
      [raw(), raw({ source: "Email/SMS", basis: "latest-data" })],
      NOW
    );
    expect(results[0].basis).toBe("synced");
    expect(results[1].basis).toBe("latest-data");
  });
});
