import { describe, it, expect } from "vitest";
import { SURFACES } from "@/lib/env-manifest";
import { checkEnv } from "@/lib/env-check";
import {
  classifyEnvStatus,
  ENV_STALE_HOURS,
  type RecordedEnvCheck,
} from "@/db/env-status";

const NOW = new Date("2026-09-08T12:00:00Z");

function record(over: Partial<RecordedEnvCheck> = {}): RecordedEnvCheck {
  return {
    surface: "worker",
    checkedAt: new Date("2026-09-08T06:00:00Z"),
    ok: true,
    expected: 18,
    missingRequired: [],
    missingDegraded: [],
    ...over,
  };
}

describe("classifyEnvStatus", () => {
  it("reports every surface, so one that never checks in is still visible", () => {
    const statuses = classifyEnvStatus([], null, NOW);
    expect(statuses.map((s) => s.surface).sort()).toEqual([...SURFACES].sort());
  });

  // The rule that this whole issue turns on. A surface with no record has not
  // told us it is healthy — it has told us nothing. Reporting `ok: true` here
  // would be a success signal with no work behind it, which is the exact bug
  // shape that let three variables ship unset.
  it("reports a surface that has never recorded as unknown, never as ok", () => {
    const [worker] = classifyEnvStatus([], null, NOW).filter((s) => s.surface === "worker");
    expect(worker.basis).toBe("never-recorded");
    expect(worker.ok).toBeNull();
    expect(worker.ok).not.toBe(true);
    expect(worker.stale).toBe(true);
  });

  it("reports a recent clean record as ok and fresh", () => {
    const [worker] = classifyEnvStatus([record()], null, NOW).filter(
      (s) => s.surface === "worker"
    );
    expect(worker.basis).toBe("recorded");
    expect(worker.ok).toBe(true);
    expect(worker.stale).toBe(false);
    expect(worker.ageHours).toBe(6);
  });

  // The worker records at startup and then daily. If the record stops arriving
  // the process is gone, and a stored `ok: true` from a week ago would keep
  // reporting a healthy environment for a service that is not running.
  it("marks a record older than the window stale even when it says ok", () => {
    const [worker] = classifyEnvStatus(
      [record({ checkedAt: new Date("2026-09-01T00:00:00Z") })],
      null,
      NOW
    ).filter((s) => s.surface === "worker");
    expect(worker.ok).toBe(true);
    expect(worker.stale).toBe(true);
    expect(worker.ageHours).toBeGreaterThan(ENV_STALE_HOURS);
  });

  // A process running an older deploy checks an older manifest. Its record can
  // say "nothing missing" quite truthfully while being blind to a variable
  // added since — so the count it checked against is part of the answer.
  it("reports how many variables the recording process expected", () => {
    const [worker] = classifyEnvStatus([record({ expected: 12 })], null, NOW).filter(
      (s) => s.surface === "worker"
    );
    expect(worker.expected).toBe(12);
  });

  it("has no expectation to report for a surface that never recorded", () => {
    const [web] = classifyEnvStatus([], null, NOW).filter((s) => s.surface === "web");
    expect(web.expected).toBeNull();
  });

  it("carries the missing names through", () => {
    const [worker] = classifyEnvStatus(
      [record({ ok: false, missingDegraded: ["SEAL_API_TOKEN"] })],
      null,
      NOW
    ).filter((s) => s.surface === "worker");
    expect(worker.ok).toBe(false);
    expect(worker.missingDegraded).toEqual(["SEAL_API_TOKEN"]);
  });

  // A name alone sends the reader off to find out what it was for. The
  // consequence is the part that gets it fixed.
  it("says what each missing variable breaks", () => {
    const [worker] = classifyEnvStatus(
      [record({ ok: false, missingDegraded: ["SEAL_API_TOKEN"] })],
      null,
      NOW
    ).filter((s) => s.surface === "worker");
    const seal = worker.consequences.find((c) => c.name === "SEAL_API_TOKEN");
    expect(seal).toBeDefined();
    expect(seal!.breaks).toContain("subscription sync");
    expect(seal!.severity).toBe("degraded");
  });

  // The MCP reads its own process.env at the moment the tool is called, so its
  // answer cannot be out of date. A stored record for it would be the stale one.
  it("prefers a live check over a stored record for the same surface", () => {
    const live = checkEnv("mcp", { DATABASE_URL: "set", ANALYTICS_DATABASE_URL: "set" }, NOW);
    const stale = record({
      surface: "mcp",
      checkedAt: new Date("2026-01-01T00:00:00Z"),
      ok: false,
      missingDegraded: ["ANALYTICS_DATABASE_URL"],
    });
    const [mcp] = classifyEnvStatus([stale], live, NOW).filter((s) => s.surface === "mcp");
    expect(mcp.basis).toBe("live");
    expect(mcp.ok).toBe(true);
    expect(mcp.stale).toBe(false);
    expect(mcp.missingDegraded).toEqual([]);
  });

  it("reports a live check that is missing something as not ok", () => {
    const live = checkEnv("mcp", { DATABASE_URL: "set" }, NOW);
    const [mcp] = classifyEnvStatus([], live, NOW).filter((s) => s.surface === "mcp");
    expect(mcp.basis).toBe("live");
    expect(mcp.ok).toBe(false);
    expect(mcp.missingDegraded).toContain("ANALYTICS_DATABASE_URL");
    // The real bug this issue was filed for, now visible through a tool call.
    expect(mcp.consequences.find((c) => c.name === "ANALYTICS_DATABASE_URL")).toBeDefined();
  });

  it("never carries a value", () => {
    const secret = "sk-live-NEVER";
    const live = checkEnv("mcp", { DATABASE_URL: secret, ANALYTICS_DATABASE_URL: secret }, NOW);
    const statuses = classifyEnvStatus([record()], live, NOW);
    expect(JSON.stringify(statuses)).not.toContain(secret);
  });
});
