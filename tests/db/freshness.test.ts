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

/**
 * "Empty" is not a diagnosis. These tests assert that an empty or stale source
 * now carries the reason it is that way, so nobody has to go reading worker logs
 * to find out whether a sync errored, found nothing, or never ran at all.
 */
describe("classifyFreshness with last-run outcomes", () => {
  it("distinguishes an empty table that was never configured from one that found nothing", () => {
    const [neverRan] = classifyFreshness(
      [raw({ rows: 0, lastAt: null, lastRun: { outcome: "not-configured", at: null, errorMessage: "Not configured: META_AD_ACCOUNT_ID is not set" } })],
      NOW
    );
    const [foundNothing] = classifyFreshness(
      [raw({ rows: 0, lastAt: null, lastRun: { outcome: "no-data", at: "2026-09-02T06:00:00.000Z", errorMessage: null } })],
      NOW
    );

    expect(neverRan.stale).toBe(true);
    expect(foundNothing.stale).toBe(true);
    // Same emptiness, different explanation — that is the whole point.
    expect(neverRan.lastRun?.outcome).not.toBe(foundNothing.lastRun?.outcome);
    expect(neverRan.lastRun?.errorMessage).toContain("META_AD_ACCOUNT_ID");
  });

  it("marks a source stale when its last run failed, even if the data looks recent", () => {
    // Six-hour-old rows read as healthy on age alone. But if this morning's run
    // died on a dead token, the data is frozen and about to rot silently.
    const [result] = classifyFreshness(
      [raw({ lastRun: { outcome: "auth-failed", at: "2026-09-02T13:00:00.000Z", errorMessage: "Session expired" } })],
      NOW
    );
    expect(result.stale).toBe(true);
    expect(result.lastRun?.outcome).toBe("auth-failed");
  });

  it("leaves a healthy source fresh when its last run succeeded", () => {
    const [result] = classifyFreshness(
      [raw({ lastRun: { outcome: "ok", at: "2026-09-02T06:00:00.000Z", errorMessage: null } })],
      NOW
    );
    expect(result.stale).toBe(false);
  });

  it("does not mark a fresh source stale merely because it has no run records", () => {
    // Only Meta writes sync_runs today. Sources without them must not regress.
    const [result] = classifyFreshness([raw()], NOW);
    expect(result.stale).toBe(false);
    expect(result.lastRun).toBeNull();
  });
});
