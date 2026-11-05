import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchTool, ALL_TOOLS, type McpToolContext } from "@/mcp/tools";
import { McpArgumentError } from "@/mcp/args";
import * as assets from "@/domain/meta/ad-assets";
import * as metaQueries from "@/domain/meta/queries";

vi.mock("@/domain/meta/ad-assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/meta/ad-assets")>()),
  listAdAssets: vi.fn(),
  getAdAsset: vi.fn(),
  saveAdAsset: vi.fn(),
}));
vi.mock("@/domain/meta/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/meta/queries")>()),
  getInsightsByAdCreative: vi.fn(),
}));

const ctx: McpToolContext = { db: {} as never, now: () => new Date("2026-11-05T12:00:00Z"), actor: "Matt" };
const T = new Date("2026-11-01T00:00:00Z");
const asset = (over: Partial<assets.AdAsset>): assets.AdAsset => ({
  id: "a1", source: "arcads", concept: "Teacher testimonial", hookText: "I stopped buying planners", body: null, format: "ugc",
  metaAdName: "Teacher UGC v2", metaAdId: null, finishedAdDropboxId: null, notes: null, author: "claude", requestedBy: "Matt",
  createdAt: T, updatedAt: T, ...over,
});
const insight = (spendCents: number, purchases: number, purchaseValueCents: number) => ({
  spendCents, impressions: 1000, clicks: 10, reach: 900, purchases, purchaseValueCents, addToCart: 0, initiateCheckout: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assets.listAdAssets).mockResolvedValue([asset({}), asset({ id: "a2", source: "footage_cut", metaAdName: "Oct shoot cut 3", format: "talking head", hookText: "Homeschool mornings" })]);
  vi.mocked(assets.saveAdAsset).mockImplementation(async (_db, row) => asset({ ...row, id: row.id ?? "new" }) as never);
  vi.mocked(metaQueries.getInsightsByAdCreative).mockResolvedValue([
    { adId: "ad_1", adName: "teacher ugc v2", campaignName: "Prospecting", creativeTitle: null, creativeBody: null, creativeImageUrl: null, rows: [insight(10_000, 4, 30_000)] },
    { adId: "ad_2", adName: "Oct shoot cut 3", campaignName: "Prospecting", creativeTitle: null, creativeBody: null, creativeImageUrl: null, rows: [insight(5_000, 2, 20_000)] },
    { adId: "ad_3", adName: "Mystery", campaignName: "Prospecting", creativeTitle: null, creativeBody: null, creativeImageUrl: null, rows: [insight(7_000, 0, 0)] },
  ] as never);
});

describe("ads_creative_performance with the registry", () => {
  it("attaches each ad's source, concept, hook and format", async () => {
    const r = (await dispatchTool(ctx, "ads_creative_performance", {})) as Record<string, any>;
    expect(r.ads.find((a: { adId: string }) => a.adId === "ad_1").asset).toEqual({
      id: "a1", source: "arcads", concept: "Teacher testimonial", hookText: "I stopped buying planners", format: "ugc",
    });
    expect(r.ads.find((a: { adId: string }) => a.adId === "ad_3").asset).toBeNull();
  });

  // Which sources, formats and hooks win is the question the registry exists for.
  it("rolls results up by source, format and hook over every ad in the window", async () => {
    const r = (await dispatchTool(ctx, "ads_creative_performance", { limit: 1 })) as Record<string, any>;
    expect(r.bySource.map((s: { key: string }) => s.key)).toEqual(["arcads", "footage_cut", "(unregistered)"]);
    expect(r.bySource[0]).toMatchObject({ spendDollars: 100, purchases: 4, roas: 3 });
    expect(r.byFormat.map((s: { key: string }) => s.key)).toContain("talking head");
    expect(r.byHook.map((s: { key: string }) => s.key)).toContain("I stopped buying planners");
    expect(r.registry).toEqual({ adsInWindow: 3, registered: 2 });
  });
});

describe("ad_asset_set", () => {
  it("is a declared write tool", () => {
    expect(ALL_TOOLS.find((t) => t.name === "ad_asset_set")?.readOnly).toBe(false);
  });

  it("registers an ad as Claude for the person asking", async () => {
    await dispatchTool(ctx, "ad_asset_set", { source: "creatify", concept: "Gift guide", hookText: "Stop scrolling", metaAdName: "Creatify gift 1" });
    expect(assets.saveAdAsset).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
      source: "creatify", concept: "Gift guide", hookText: "Stop scrolling", metaAdName: "Creatify gift 1", author: "claude", requestedBy: "Matt",
    }));
  });

  // Unlinked, the asset can never meet its results.
  it("refuses a new asset that names no Meta ad", async () => {
    await expect(dispatchTool(ctx, "ad_asset_set", { source: "arcads", concept: "x" })).rejects.toBeInstanceOf(McpArgumentError);
  });

  it("updates only the fields given on an existing asset", async () => {
    vi.mocked(assets.getAdAsset).mockResolvedValue(asset({}));
    await dispatchTool(ctx, "ad_asset_set", { id: "a1", metaAdId: "ad_1" });
    expect(assets.saveAdAsset).toHaveBeenCalledWith(ctx.db, expect.objectContaining({ id: "a1", metaAdId: "ad_1", source: "arcads", hookText: "I stopped buying planners" }));
  });
});

describe("ad_assets", () => {
  it("lists the registry, filterable by source", async () => {
    const r = (await dispatchTool(ctx, "ad_assets", { source: "footage_cut" })) as Record<string, any>;
    expect(r.assets.map((a: { id: string }) => a.id)).toEqual(["a2"]);
    expect(r.total).toBe(2);
  });
});
