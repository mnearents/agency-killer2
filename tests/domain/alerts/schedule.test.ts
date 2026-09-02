import { describe, it, expect } from "vitest";
import { prioritizeAlerts, MAX_ALERTS_PER_RUN } from "@/domain/alerts/schedule";
import type { Alert } from "@/domain/alerts/checks";

function alert(severity: Alert["severity"], type = "some-alert"): Alert {
  return { type, severity, message: `${type} message` };
}

describe("prioritizeAlerts", () => {
  it("puts the most severe alerts first", () => {
    const out = prioritizeAlerts([alert("info"), alert("urgent"), alert("warning")]);
    expect(out.map((a) => a.severity)).toEqual(["urgent", "warning", "info"]);
  });

  it("caps the number of alerts per run", () => {
    const out = prioritizeAlerts(Array.from({ length: 10 }, () => alert("warning")));
    expect(out).toHaveLength(MAX_ALERTS_PER_RUN);
  });

  it("never drops a check-failure notice to make room — a broken check is not noise", () => {
    const out = prioritizeAlerts([
      alert("urgent", "a"),
      alert("urgent", "b"),
      alert("urgent", "c"),
      alert("urgent", "d"),
      alert("warning", "check-failed"),
    ]);
    expect(out.some((a) => a.type === "check-failed")).toBe(true);
  });

  it("still reports the most severe alerts alongside a check failure", () => {
    const out = prioritizeAlerts([
      alert("info", "low"),
      alert("urgent", "high"),
      alert("warning", "check-failed"),
    ]);
    expect(out.some((a) => a.type === "high")).toBe(true);
    expect(out.some((a) => a.type === "check-failed")).toBe(true);
  });
});
