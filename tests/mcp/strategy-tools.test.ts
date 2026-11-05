import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchTool, type McpToolContext } from "@/mcp/tools";
import { McpArgumentError } from "@/mcp/args";
import * as strategy from "@/domain/strategy/products";
import * as shopifyQueries from "@/domain/shopify/queries";
import * as inventoryQueries from "@/domain/inventory/queries";

vi.mock("@/domain/inventory/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/inventory/queries")>()),
  getInventoryItems: vi.fn(),
}));

vi.mock("@/domain/shopify/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/shopify/queries")>()),
  getProductSales: vi.fn(),
}));

vi.mock("@/domain/strategy/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/strategy/products")>()),
  listProducts: vi.fn(),
  getCurrentStrategies: vi.fn(),
  getStrategyHistory: vi.fn(),
  findProductsByRef: vi.fn(),
  recordStrategy: vi.fn(),
}));

const ctx: McpToolContext = { db: {} as never, now: () => new Date("2026-11-05T18:00:00Z"), actor: "Matt" };
const SET_AT = new Date("2026-11-01T12:00:00Z");

const journal = { id: "gid://shopify/Product/1", title: "Friendship Journal", handle: "friendship-journal", status: "ACTIVE", productType: "Journal" };
const calendar = { id: "gid://shopify/Product/2", title: "Wall Calendar", handle: "wall-calendar", status: "ACTIVE", productType: "Calendar" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(strategy.listProducts).mockResolvedValue([journal, calendar] as never);
  vi.mocked(strategy.getCurrentStrategies).mockResolvedValue(new Map([
    [calendar.id, { productId: calendar.id, ...strategy.EMPTY_STRATEGY, role: "seasonal", seasonStartMonth: 10, seasonEndMonth: 1, author: "claude", requestedBy: "Matt", setAt: SET_AT }],
  ]));
  vi.mocked(strategy.findProductsByRef).mockResolvedValue([journal] as never);
  vi.mocked(strategy.recordStrategy).mockImplementation(async (_db, productId, fields, who) => ({ productId, ...fields, ...who, setAt: SET_AT }));
});

describe("product_strategy", () => {
  // A product nobody has decided about must say so, not look like one with no role to play.
  it("lists every active product with its role, and counts the undecided", async () => {
    const r = (await dispatchTool(ctx, "product_strategy", {})) as Record<string, any>;
    expect(r.undecided).toBe(1);
    expect(r.products).toEqual([
      expect.objectContaining({ title: "Friendship Journal", role: null, decided: false }),
      expect.objectContaining({ title: "Wall Calendar", role: "seasonal", inSeasonNow: true, decided: true, setBy: "claude for Matt" }),
    ]);
  });

  it("filters to the undecided with role none", async () => {
    const r = (await dispatchTool(ctx, "product_strategy", { role: "none" })) as Record<string, any>;
    expect(r.products.map((p: { title: string }) => p.title)).toEqual(["Friendship Journal"]);
  });

  it("returns one product's history when asked by handle", async () => {
    vi.mocked(strategy.getStrategyHistory).mockResolvedValue([]);
    const r = (await dispatchTool(ctx, "product_strategy", { handle: "friendship-journal" })) as Record<string, any>;
    expect(strategy.getStrategyHistory).toHaveBeenCalledWith(ctx.db, journal.id);
    expect(r.history).toEqual([]);
  });
});

describe("product_strategy_set", () => {
  it("records the merged strategy as Claude's, for the person who asked", async () => {
    const r = (await dispatchTool(ctx, "product_strategy_set", {
      handle: "friendship-journal", role: "maintain", audiences: "kids, gift_buyers", notes: "Does not sell; do not promote",
    })) as Record<string, any>;
    expect(strategy.recordStrategy).toHaveBeenCalledWith(ctx.db, journal.id, {
      ...strategy.EMPTY_STRATEGY, role: "maintain", audiences: ["kids", "gift_buyers"], notes: "Does not sell; do not promote",
    }, { author: "claude", requestedBy: "Matt" });
    expect(r.written).toBe(true);
  });

  it("requires exactly one of productId and handle", async () => {
    await expect(dispatchTool(ctx, "product_strategy_set", { role: "hero" })).rejects.toBeInstanceOf(McpArgumentError);
    await expect(dispatchTool(ctx, "product_strategy_set", { role: "hero", handle: "a", productId: "b" })).rejects.toBeInstanceOf(McpArgumentError);
  });

  it("refuses an audience outside the vocabulary before writing anything", async () => {
    await expect(dispatchTool(ctx, "product_strategy_set", { handle: "friendship-journal", audiences: "moms" }))
      .rejects.toThrow(/"moms"/);
    expect(strategy.recordStrategy).not.toHaveBeenCalled();
  });

  it("returns an error naming the product it could not find", async () => {
    vi.mocked(strategy.findProductsByRef).mockResolvedValue([]);
    const r = (await dispatchTool(ctx, "product_strategy_set", { handle: "nope", role: "hero" })) as Record<string, any>;
    expect(r.error).toMatch(/No product.*nope/);
    expect(strategy.recordStrategy).not.toHaveBeenCalled();
  });
});

describe("store_top_products", () => {
  // A product's sales without its role is how a maintain product got pitched.
  it("returns each product's sales with its strategy role beside them", async () => {
    vi.mocked(shopifyQueries.getProductSales).mockResolvedValue([
      { productId: calendar.id, title: "Wall Calendar", handle: "wall-calendar", status: "ACTIVE", productType: "Calendar", units: 40, orders: 38, revenueCents: 99_900 },
      { productId: journal.id, title: "Friendship Journal", handle: "friendship-journal", status: "ACTIVE", productType: "Journal", units: 1, orders: 1, revenueCents: 1_500 },
    ]);
    const r = (await dispatchTool(ctx, "store_top_products", { limit: 5 })) as Record<string, any>;
    expect(r.products[0]).toMatchObject({ title: "Wall Calendar", revenueDollars: 999, units: 40, role: "seasonal" });
    expect(r.products[1]).toMatchObject({ title: "Friendship Journal", role: null, roleDecided: false });
  });

  it("lists the weakest active products with order bottom, zero sellers included", async () => {
    vi.mocked(shopifyQueries.getProductSales).mockResolvedValue([
      { productId: calendar.id, title: "Wall Calendar", handle: "wall-calendar", status: "ACTIVE", productType: "Calendar", units: 40, orders: 38, revenueCents: 99_900 },
      { productId: journal.id, title: "Friendship Journal", handle: "friendship-journal", status: "ACTIVE", productType: "Journal", units: 0, orders: 0, revenueCents: 0 },
      { productId: "gid://shopify/Product/9", title: "Old thing", handle: "old", status: "ARCHIVED", productType: null, units: 0, orders: 0, revenueCents: 0 },
    ]);
    const r = (await dispatchTool(ctx, "store_top_products", { order: "bottom" })) as Record<string, any>;
    expect(r.products.map((p: { title: string }) => p.title)).toEqual(["Friendship Journal", "Wall Calendar"]);
  });
});

describe("inventory_status", () => {
  // Low cover on a sunset product is the plan working, not a reorder.
  it("gives each variant its product's strategy role", async () => {
    vi.mocked(inventoryQueries.getInventoryItems).mockResolvedValue([{
      variantId: "v1", productId: calendar.id, productTitle: "Wall Calendar", variantTitle: null, sku: "CAL",
      quantity: 0, tracked: true, productStatus: "ACTIVE", vendor: "Rad & Happy", unitsSoldLast30d: 10,
    }]);
    const r = (await dispatchTool(ctx, "inventory_status", {})) as Record<string, any>;
    expect(r.items[0]).toMatchObject({ productTitle: "Wall Calendar", classification: "stockout", role: "seasonal", roleDecided: true });
  });
});
