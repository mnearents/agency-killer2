import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchTool, type McpToolContext } from "@/mcp/tools";
import * as calendar from "@/domain/calendar/queries";
import * as shopify from "@/domain/shopify/queries";
import * as strategy from "@/domain/strategy/products";
import * as goals from "@/domain/strategy/goals";
import * as economics from "@/domain/economics/queries";

vi.mock("@/domain/calendar/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/calendar/queries")>()),
  getEntriesByWeek: vi.fn(),
}));
vi.mock("@/domain/shopify/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/shopify/queries")>()),
  getProductSales: vi.fn(),
}));
vi.mock("@/domain/strategy/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/strategy/products")>()),
  getCurrentStrategies: vi.fn(),
}));
vi.mock("@/domain/strategy/goals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/strategy/goals")>()),
  getCurrentGoals: vi.fn(),
}));
vi.mock("@/domain/economics/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/economics/queries")>()),
  getRevenueByLine: vi.fn(),
}));

const NOW = new Date("2026-11-05T12:00:00Z");
// No database behind most sections: they must fail one at a time, named.
const ctx: McpToolContext = { db: {} as never, now: () => NOW };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(calendar.getEntriesByWeek).mockResolvedValue([]);
  vi.mocked(shopify.getProductSales).mockResolvedValue([
    { productId: "p1", title: "Wall Calendar", handle: "wall-calendar", status: "ACTIVE", productType: "Calendar", units: 40, orders: 38, revenueCents: 99_900 },
    { productId: "p2", title: "Friendship Journal", handle: "friendship-journal", status: "ACTIVE", productType: "Journal", units: 0, orders: 0, revenueCents: 0 },
  ]);
  vi.mocked(strategy.getCurrentStrategies).mockResolvedValue(new Map());
  vi.mocked(goals.getCurrentGoals).mockResolvedValue([]);
  vi.mocked(economics.getRevenueByLine).mockResolvedValue({ subscription: 0, physical: 0, digital: 0 });
});

describe("marketing_context", () => {
  const SECTIONS = ["goalsPace", "products", "metaCampaigns", "emailSms", "calendar", "strategyNotes", "rejectedDrafts", "freshness"];

  // The weekly agent starts here, so one broken feed must not cost it the rest.
  it("returns every section, each its answer or a named error, without failing as a whole", async () => {
    const r = (await dispatchTool(ctx, "marketing_context", {})) as Record<string, any>;
    for (const key of SECTIONS) expect(r, key).toHaveProperty(key);
    expect(r.metaCampaigns).toHaveProperty("error");
    expect(r.goalsPace).not.toHaveProperty("error");
  });

  it("gives the top and bottom products with their roles", async () => {
    const r = (await dispatchTool(ctx, "marketing_context", {})) as Record<string, any>;
    expect(r.products.top[0]).toMatchObject({ title: "Wall Calendar", roleDecided: false });
    expect(r.products.bottom[0]).toMatchObject({ title: "Friendship Journal", revenueDollars: 0 });
  });

  it("reads the calendar twelve weeks ahead", async () => {
    await dispatchTool(ctx, "marketing_context", {});
    const [, start, end] = vi.mocked(calendar.getEntriesByWeek).mock.calls[0];
    expect(Math.round((end.getTime() - start.getTime()) / 86_400_000)).toBeGreaterThanOrEqual(84);
    expect(start.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });
});
