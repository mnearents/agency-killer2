import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchTool, type McpToolContext } from "@/mcp/tools";
import { McpArgumentError } from "@/mcp/args";
import * as seo from "@/domain/seo/queries";
import * as attribution from "@/domain/shopify/attribution";

vi.mock("@/domain/seo/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/seo/queries")>()),
  getSessionTotals: vi.fn(),
  getSessionsVsClicks: vi.fn(),
  getSessionsByDimension: vi.fn(),
}));
vi.mock("@/domain/shopify/attribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/shopify/attribution")>()),
  getRevenueByLandingPage: vi.fn(),
}));

const ctx: McpToolContext = { db: {} as never, now: () => new Date("2026-11-05T12:00:00Z") };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(seo.getSessionTotals).mockResolvedValue({ sessions: 1000, days: 30, firstDate: "2026-10-06", lastDate: "2026-11-04" });
  vi.mocked(seo.getSessionsVsClicks).mockResolvedValue({ ratio: 1.1 } as never);
  vi.mocked(seo.getSessionsByDimension).mockResolvedValue({ rows: [{ value: "/blogs/news/homeschool-planner-guide", sessions: 42 }], matched: 1 });
  vi.mocked(attribution.getRevenueByLandingPage).mockResolvedValue({
    rows: [{ landingPath: "/blogs/news/homeschool-planner-guide", orders: 3, revenueCents: 13_500 }],
    matched: 1,
    coverage: { orders: 400, withJourney: 380 },
  });
});

describe("web_traffic page filter", () => {
  // It capped at 200 rows and could not be asked about one page.
  it("looks up one landing page exactly", async () => {
    const r = (await dispatchTool(ctx, "web_traffic", { page: "/blogs/news/homeschool-planner-guide/" })) as Record<string, any>;
    expect(seo.getSessionsByDimension).toHaveBeenCalledWith(ctx.db, "landing_page", expect.anything(), expect.any(Number), { exact: "/blogs/news/homeschool-planner-guide" });
    expect(r.dimension).toBe("landing_page");
    expect(r.rows).toEqual([{ value: "/blogs/news/homeschool-planner-guide", sessions: 42 }]);
  });

  it("filters to every page under a prefix", async () => {
    await dispatchTool(ctx, "web_traffic", { pagePrefix: "/blogs/" });
    expect(seo.getSessionsByDimension).toHaveBeenCalledWith(ctx.db, "landing_page", expect.anything(), expect.any(Number), { prefix: "/blogs/" });
  });

  it("refuses a page filter on a dimension that is not landing pages", async () => {
    await expect(dispatchTool(ctx, "web_traffic", { dimension: "referrer_source", page: "/x" })).rejects.toBeInstanceOf(McpArgumentError);
  });
});

describe("revenue_by_landing_page", () => {
  it("returns revenue per first landing page in dollars, with how many orders carry a journey", async () => {
    const r = (await dispatchTool(ctx, "revenue_by_landing_page", { pagePrefix: "/blogs/" })) as Record<string, any>;
    expect(attribution.getRevenueByLandingPage).toHaveBeenCalledWith(ctx.db, expect.objectContaining({ touch: "first", prefix: "/blogs/", excludeRecurring: true }));
    expect(r.rows[0]).toEqual({ landingPath: "/blogs/news/homeschool-planner-guide", orders: 3, revenueDollars: 135 });
    expect(r.coverage).toMatchObject({ orders: 400, withJourney: 380, sharePct: 95 });
  });

  // Orders synced before journeys were requested have none. A page that
  // shows no revenue over that history is unmeasured, not unprofitable.
  it("warns when too few orders carry a journey to read an absence as zero", async () => {
    vi.mocked(attribution.getRevenueByLandingPage).mockResolvedValue({ rows: [], matched: 0, coverage: { orders: 400, withJourney: 40 } });
    const r = (await dispatchTool(ctx, "revenue_by_landing_page", {})) as Record<string, any>;
    expect(r.coverage.warning).toMatch(/10%.*not zero/);
  });
});
