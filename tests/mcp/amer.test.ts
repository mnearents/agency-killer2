/**
 * `amer` at its call site.
 *
 * The arithmetic is covered in `tests/domain/economics/amer.test.ts`. What is
 * asserted here is that the tool is registered, that the numerator comes from
 * first-ever orders rather than every order in the window, and that a zero
 * denominator reaches the caller as "undefined" rather than as a number.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ALL_TOOLS, dispatchTool, type McpToolContext } from "@/mcp/tools";
import * as economicsQueries from "@/domain/economics/queries";

vi.mock("@/domain/economics/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/economics/queries")>();
  return {
    ...actual,
    getRateSettings: vi.fn(),
    getAdSpend: vi.fn(),
    getNewCustomerOrders: vi.fn(),
    getOrdersForEconomics: vi.fn(),
  };
});

const NOW = new Date("2026-09-17T12:00:00Z");
const ctx = { db: {} as never, now: () => NOW } as unknown as McpToolContext;

const costed = (cents: number, costCents: number) => ({
  totalPriceCents: cents,
  totalTaxCents: 0,
  productCostCents: costCents,
  lineRevenueCents: cents,
  costedLineRevenueCents: cents,
});

beforeEach(() => {
  // Cleared so `mock.calls[0]` is this test's call and not the previous test's.
  vi.clearAllMocks();
  vi.mocked(economicsQueries.getRateSettings).mockResolvedValue({
    paymentPctRate: 0.027,
    paymentFixedCents: 30,
  });
  vi.mocked(economicsQueries.getAdSpend).mockResolvedValue([
    { channel: "meta", spendCents: 100_000, daysWithSpend: 30 },
  ]);
  vi.mocked(economicsQueries.getNewCustomerOrders).mockResolvedValue({
    byLine: [
      { line: "physical", orders: [costed(150_000, 40_000)] },
      { line: "subscription", orders: [] },
      { line: "digital", orders: [] },
    ],
    undecidableOrders: 0,
  });
});

describe("amer is reachable", () => {
  it("is in the tool list", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toContain("amer");
  });
});

describe("amer: the numerator", () => {
  /**
   * `getOrdersForEconomics` returns every order in the window; aMER needs the
   * first-ever ones. Reading the wrong function would inflate the numerator by
   * roughly the whole subscription book — 42,243 orders against 1,491 — and
   * produce an aMER that looks spectacular.
   */
  it("reads first-ever orders, not every order in the window", async () => {
    await dispatchTool(ctx, "amer", {});
    expect(economicsQueries.getNewCustomerOrders).toHaveBeenCalled();
    expect(economicsQueries.getOrdersForEconomics).not.toHaveBeenCalled();
  });

  it("divides that revenue by the ad spend", async () => {
    const r = (await dispatchTool(ctx, "amer", {})) as { amer: number; newCustomers: { revenue: number } };
    expect(r.newCustomers.revenue).toBe(1500);
    expect(r.amer).toBeCloseTo(1.5, 3);
  });

  it("passes the same window to spend and to orders", async () => {
    await dispatchTool(ctx, "amer", { days: 30 });
    const [, spendStart, spendEnd] = vi.mocked(economicsQueries.getAdSpend).mock.calls[0];
    const [, orderStart, orderEnd] = vi.mocked(economicsQueries.getNewCustomerOrders).mock.calls[0];
    expect(spendStart).toBe(orderStart);
    expect(spendEnd).toBe(orderEnd);
    expect(spendStart).toBe("2026-08-18");
  });

  // Counted as neither new nor repeat, and never silently dropped.
  it("surfaces orders whose customer history cannot be decided", async () => {
    vi.mocked(economicsQueries.getNewCustomerOrders).mockResolvedValue({
      byLine: [{ line: "physical", orders: [costed(150_000, 40_000)] }],
      undecidableOrders: 12,
    });
    const r = (await dispatchTool(ctx, "amer", {})) as {
      newCustomers: { undecidableOrders?: number };
    };
    expect(r.newCustomers.undecidableOrders).toBe(12);
  });
});

describe("amer: the denominator", () => {
  /**
   * Meta spend has been exactly zero since 2026-03-29, so this is the branch
   * every default window hits today. An Infinity here is a number someone
   * quotes.
   */
  it("returns a null aMER when nothing was spent", async () => {
    vi.mocked(economicsQueries.getAdSpend).mockResolvedValue([
      { channel: "meta", spendCents: 0, daysWithSpend: 0 },
    ]);
    const r = (await dispatchTool(ctx, "amer", {})) as {
      amer: number | null;
      verdict: string;
      reason: string;
    };
    expect(r.amer).toBeNull();
    expect(r.verdict).toBe("undecidable");
    expect(r.reason).toMatch(/no ad spend/i);
  });

  // Meta is the only synced channel, and an unnamed channel must not read as
  // "every channel we run".
  it("says which channels the denominator actually covers", async () => {
    const r = (await dispatchTool(ctx, "amer", {})) as {
      spend: { coverage: string; byChannel: Array<{ channel: string; daysWithSpend: number }> };
    };
    expect(r.spend.coverage).toMatch(/Meta only/i);
    expect(r.spend.byChannel[0].channel).toBe("meta");
    expect(r.spend.byChannel[0].daysWithSpend).toBe(30);
  });

  it("passes a named channel through to the spend read", async () => {
    await dispatchTool(ctx, "amer", { channel: "meta" });
    expect(vi.mocked(economicsQueries.getAdSpend).mock.calls[0][3]).toBe("meta");
  });

  it("rejects a channel we do not sync rather than returning Meta's spend under its name", async () => {
    await expect(dispatchTool(ctx, "amer", { channel: "google" })).rejects.toThrow(/channel/);
  });

  it("errors rather than defaulting when no payment rate is in effect", async () => {
    vi.mocked(economicsQueries.getRateSettings).mockResolvedValue(null);
    const r = (await dispatchTool(ctx, "amer", {})) as { error?: string; amer?: unknown };
    expect(r.error).toMatch(/No payment rates are in effect/);
    expect(r.amer).toBeUndefined();
  });
});

describe("amer: the verdict reaches the caller", () => {
  it("withholds an above-break-even verdict while a cost category is missing", async () => {
    vi.mocked(economicsQueries.getAdSpend).mockResolvedValue([
      { channel: "meta", spendCents: 10_000, daysWithSpend: 30 },
    ]);
    const r = (await dispatchTool(ctx, "amer", {})) as {
      verdict: string;
      breakEvenBound: string;
      missing: string[];
    };
    expect(r.verdict).toBe("undecidable");
    expect(r.breakEvenBound).toBe("floor");
    expect(r.missing.join(" ")).toMatch(/Fulfilment/);
  });

  it("reports each line's share of the new-customer revenue", async () => {
    vi.mocked(economicsQueries.getNewCustomerOrders).mockResolvedValue({
      byLine: [
        { line: "physical", orders: [costed(75_000, 20_000)] },
        { line: "subscription", orders: [costed(25_000, 0)] },
      ],
      undecidableOrders: 0,
    });
    const r = (await dispatchTool(ctx, "amer", {})) as {
      lines: Array<{ businessLine: string; shareOfNewRevenuePct: number }>;
    };
    expect(r.lines.find((l) => l.businessLine === "physical")!.shareOfNewRevenuePct).toBe(75);
  });
});
