import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchTool, type McpToolContext } from "@/mcp/tools";
import { McpArgumentError } from "@/mcp/args";
import * as goalsDomain from "@/domain/strategy/goals";
import * as economics from "@/domain/economics/queries";

vi.mock("@/domain/strategy/goals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/strategy/goals")>()),
  getCurrentGoals: vi.fn(),
  getGoalHistory: vi.fn(),
  recordGoal: vi.fn(),
  getCurrentGoal: vi.fn(),
}));
vi.mock("@/domain/economics/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/economics/queries")>()),
  getRevenueByLine: vi.fn(),
}));

const NOW = new Date("2027-03-16T12:00:00Z");
const ctx: McpToolContext = { db: {} as never, now: () => NOW, actor: "Matt" };
const SET_AT = new Date("2026-11-05T00:00:00Z");
const row = (over: Partial<goalsDomain.GoalRow>): goalsDomain.GoalRow => ({
  kind: "target", period: "2027", line: "total", targetCents: 100_000_000, priorities: null, notes: null,
  author: "Matt", requestedBy: null, setAt: SET_AT, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(goalsDomain.getCurrentGoals).mockResolvedValue([
    row({}),
    row({ period: "2027-03", line: "subscription", targetCents: 3_100_000 }),
    row({ kind: "priorities", period: "2027-Q1", line: null, targetCents: null, priorities: ["Grow SMS list", "Planner ads"] }),
  ]);
  vi.mocked(goalsDomain.recordGoal).mockImplementation(async (_db, r) => ({ id: "g1", createdAt: SET_AT, ...r }) as never);
  vi.mocked(economics.getRevenueByLine).mockResolvedValue({ subscription: 1_500_000, physical: 0, digital: 0 });
});

describe("goals", () => {
  it("returns the year's targets in dollars and the current quarter's ranked priorities", async () => {
    const r = (await dispatchTool(ctx, "goals", {})) as Record<string, any>;
    expect(r.year).toBe(2027);
    expect(r.annualTargets).toEqual([expect.objectContaining({ line: "total", targetDollars: 1_000_000, setBy: "Matt" })]);
    expect(r.monthlyTargets).toEqual([expect.objectContaining({ period: "2027-03", line: "subscription", targetDollars: 31_000 })]);
    expect(r.priorities).toEqual({ quarter: "2027-Q1", ranked: ["Grow SMS list", "Planner ads"], setBy: "Matt", setAt: SET_AT.toISOString() });
  });
});

describe("goals_set", () => {
  it("records a monthly line target in cents, as Claude for the person asking", async () => {
    await dispatchTool(ctx, "goals_set", { period: "2027-04", line: "physical", targetDollars: 25_000.5 });
    expect(goalsDomain.recordGoal).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
      kind: "target", period: "2027-04", line: "physical", targetCents: 2_500_050, author: "claude", requestedBy: "Matt",
    }));
  });

  it("records a quarter's priorities as a ranked list", async () => {
    await dispatchTool(ctx, "goals_set", { period: "2027-q2", priorities: "1. Wholesale pilot\n2. SMS list to 20k" });
    expect(goalsDomain.recordGoal).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
      kind: "priorities", period: "2027-Q2", line: null, priorities: ["Wholesale pilot", "SMS list to 20k"],
    }));
  });

  it("refuses a target without a line, and priorities on a month", async () => {
    await expect(dispatchTool(ctx, "goals_set", { period: "2027-04", targetDollars: 5 })).rejects.toBeInstanceOf(McpArgumentError);
    await expect(dispatchTool(ctx, "goals_set", { period: "2027-04", priorities: "x" })).rejects.toThrow(/quarter/);
    await expect(dispatchTool(ctx, "goals_set", { period: "2027", line: "total" })).rejects.toThrow(/targetDollars or clear/);
    expect(goalsDomain.recordGoal).not.toHaveBeenCalled();
  });

  it("clears a target with clear:true, kept as history", async () => {
    await dispatchTool(ctx, "goals_set", { period: "2027-04", line: "physical", clear: true });
    expect(goalsDomain.recordGoal).toHaveBeenCalledWith(ctx.db, expect.objectContaining({ targetCents: null }));
  });
});

describe("goals_pace", () => {
  it("reads month-to-date and year-to-date revenue by line and measures it against the plan", async () => {
    const r = (await dispatchTool(ctx, "goals_pace", {})) as Record<string, any>;
    const [[, mStart, mEnd], [, yStart, yEnd]] = vi.mocked(economics.getRevenueByLine).mock.calls;
    expect([mStart.toISOString(), mEnd.toISOString()]).toEqual(["2027-03-01T00:00:00.000Z", "2027-03-17T00:00:00.000Z"]);
    expect([yStart.toISOString(), yEnd.toISOString()]).toEqual(["2027-01-01T00:00:00.000Z", "2027-03-17T00:00:00.000Z"]);
    const sub = r.lines.find((l: { line: string }) => l.line === "subscription");
    expect(sub.monthToDate).toEqual({ actualDollars: 15_000, targetDollars: 31_000, targetToDateDollars: 16_000, gapToDateDollars: -1_000 });
    expect(r.revenueDefinition).toMatch(/store_performance/);
  });
});
