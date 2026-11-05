import { describe, it, expect } from "vitest";
import { describeAttentiveCoverage, ATTENTIVE_UNAVAILABLE } from "@/domain/attentive/coverage";

const RANGE_END = new Date("2026-11-05T00:00:00Z");
const failedRun = { outcome: "api-error", finishedAt: new Date("2026-11-05T17:20:20Z"), errorMessage: "No 2FA code received from Slack" };

describe("describeAttentiveCoverage", () => {
  // The brief read an empty October as a quiet October. The data stopped on
  // 2026-09-22 and nothing in the tool's answer said so.
  it("says the data stops short of the window, when, and why the sync is failing", () => {
    const c = describeAttentiveCoverage({
      dataThrough: new Date("2026-09-22T00:00:00Z"),
      lastRun: failedRun,
      lastSuccessAt: new Date("2026-09-23T17:05:00Z"),
    }, RANGE_END);
    expect(c.current).toBe(false);
    expect(c.dataThrough).toBe("2026-09-22");
    expect(c.lastSync).toEqual({ outcome: "api-error", at: "2026-11-05T17:20:20.000Z", error: "No 2FA code received from Slack" });
    expect(c.lastSuccessfulSync).toBe("2026-09-23T17:05:00.000Z");
    expect(c.warning).toMatch(/2026-09-22.*44 days.*NOT a quiet period/);
  });

  // Attentive reports run a day behind, so yesterday's data counts as current.
  it("counts data through the day before the window ends as current", () => {
    const c = describeAttentiveCoverage({
      dataThrough: new Date("2026-11-04T00:00:00Z"),
      lastRun: { ...failedRun, outcome: "ok", errorMessage: null },
      lastSuccessAt: failedRun.finishedAt,
    }, RANGE_END);
    expect(c.current).toBe(true);
    expect(c).not.toHaveProperty("warning");
  });

  it("says nothing has ever been collected when the table is empty", () => {
    const c = describeAttentiveCoverage({ dataThrough: null, lastRun: null, lastSuccessAt: null }, RANGE_END);
    expect(c.current).toBe(false);
    expect(c.warning).toMatch(/No Attentive data has been collected/);
  });

  // A window entirely in the past is answered by old data, so old data is fine.
  it("does not call a past window stale", () => {
    const c = describeAttentiveCoverage({
      dataThrough: new Date("2026-09-22T00:00:00Z"),
      lastRun: failedRun,
      lastSuccessAt: null,
    }, new Date("2026-09-15T00:00:00Z"));
    expect(c.current).toBe(true);
  });

  // Asked for, and not obtainable: saying so beats an empty list.
  it("names what Attentive cannot provide at all", () => {
    expect(ATTENTIVE_UNAVAILABLE.scheduledSends).toMatch(/not available/i);
    expect(ATTENTIVE_UNAVAILABLE.subscriberCounts).toMatch(/not available/i);
  });
});
