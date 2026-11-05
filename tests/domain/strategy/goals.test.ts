import { describe, it, expect } from "vitest";
import { computePace, parsePeriod, parsePriorities, type GoalTarget } from "@/domain/strategy/goals";

const AS_OF = new Date("2027-03-16T12:00:00Z"); // day 16 of 31 in March; day 75 of 365

const t = (period: string, line: GoalTarget["line"], dollars: number): GoalTarget => ({ period, line, targetCents: dollars * 100 });

describe("computePace", () => {
  const targets = [
    t("2027", "total", 1_000_000),
    t("2027-01", "subscription", 30_000), t("2027-02", "subscription", 30_000), t("2027-03", "subscription", 31_000),
  ];
  const actuals = {
    monthToDate: { subscription: 15_000_00, physical: 20_000_00, digital: 5_000_00 },
    yearToDate: { subscription: 75_000_00, physical: 90_000_00, digital: 20_000_00 },
  };

  it("measures a line against its monthly plan, pro rata through the month", () => {
    const pace = computePace(targets, actuals, AS_OF);
    const sub = pace.lines.find((l) => l.line === "subscription")!;
    // 31,000 × 16/31 = 16,000 due by the 16th; 15,000 done.
    expect(sub.monthToDate).toEqual({ actualDollars: 15_000, targetDollars: 31_000, targetToDateDollars: 16_000, gapToDateDollars: -1_000 });
    // Jan + Feb in full, then 16/31 of March: 76,000 due; 75,000 done.
    expect(sub.yearToDate).toMatchObject({ actualDollars: 75_000, targetToDateDollars: 76_000, gapToDateDollars: -1_000 });
  });

  // A line nobody planned has no target — not a target of zero it is beating.
  it("leaves a line with no plan unmeasured and says so", () => {
    const physical = computePace(targets, actuals, AS_OF).lines.find((l) => l.line === "physical")!;
    expect(physical.monthToDate.targetDollars).toBeNull();
    expect(physical.monthToDate.gapToDateDollars).toBeNull();
    expect(physical.note).toMatch(/No monthly targets/);
  });

  // Total has only an annual figure here, so it is spread evenly and labelled as such.
  it("spreads an annual-only total evenly across the year, and labels it straight-line", () => {
    const total = computePace(targets, actuals, AS_OF).lines.find((l) => l.line === "total")!;
    expect(total.yearToDate.actualDollars).toBe(185_000);
    // 1,000,000 × 75/365 = 205,479.45
    expect(total.yearToDate.targetToDateDollars).toBeCloseTo(205_479.45, 2);
    expect(total.yearToDate.annualTargetDollars).toBe(1_000_000);
    expect(total.basis).toBe("straight-line from the annual target");
  });

  it("projects the year from the run rate so far", () => {
    const total = computePace(targets, actuals, AS_OF).lines.find((l) => l.line === "total")!;
    // 185,000 over 75 days, × 365.
    expect(total.yearToDate.projectedYearDollars).toBeCloseTo(900_333.33, 2);
  });

  // Wholesale has no classifier in the order data, so its actual is unknown, not zero.
  it("reports a line it cannot measure as unknown rather than zero", () => {
    const w = computePace([...targets, t("2027-03", "wholesale", 5_000)], actuals, AS_OF).lines.find((l) => l.line === "wholesale")!;
    expect(w.monthToDate.actualDollars).toBeNull();
    expect(w.note).toMatch(/cannot be told apart/);
  });
});

describe("parsePeriod", () => {
  it("accepts a year, a month and a quarter", () => {
    expect(parsePeriod("2027")).toEqual({ kind: "year", period: "2027" });
    expect(parsePeriod("2027-03")).toEqual({ kind: "month", period: "2027-03" });
    expect(parsePeriod("2026-q4")).toEqual({ kind: "quarter", period: "2026-Q4" });
  });

  it("refuses anything else", () => {
    expect(() => parsePeriod("March 2027")).toThrow(/YYYY, YYYY-MM or YYYY-Qn/);
    expect(() => parsePeriod("2027-13")).toThrow();
  });
});

describe("parsePriorities", () => {
  it("reads one priority per line in rank order, ignoring list markers", () => {
    expect(parsePriorities("1. Grow SMS list\n2) Launch planner ads\n- Fix wall calendar shipping\n\n")).toEqual([
      "Grow SMS list", "Launch planner ads", "Fix wall calendar shipping",
    ]);
  });

  it("refuses an empty list", () => {
    expect(() => parsePriorities(" \n ")).toThrow(/at least one/);
  });
});
