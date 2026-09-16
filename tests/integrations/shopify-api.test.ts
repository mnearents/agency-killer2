import { describe, it, expect, vi, afterEach } from "vitest";
import { createShopifyApiClient } from "@/integrations/shopify-api";

function ordersPage(nodes: unknown[], hasNextPage = false, endCursor = "") {
  return new Response(
    JSON.stringify({
      data: { orders: { pageInfo: { hasNextPage, endCursor }, nodes } },
      extensions: {
        cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function variablesOf(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const [, init] = fetchMock.mock.calls[call];
  return JSON.parse(init.body as string).variables;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getOrders: window", () => {
  it("sends no query filter when neither bound is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ordersPage([]));
    vi.stubGlobal("fetch", fetchMock);

    await createShopifyApiClient("shop.myshopify.com", "tok").getOrders({});

    expect(variablesOf(fetchMock).query).toBeUndefined();
  });

  it("filters on the lower bound alone when only since is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ordersPage([]));
    vi.stubGlobal("fetch", fetchMock);

    await createShopifyApiClient("shop.myshopify.com", "tok").getOrders({
      since: "2025-07-01",
    });

    expect(variablesOf(fetchMock).query).toBe("created_at:>='2025-07-01'");
  });

  // A backfill crawls in month chunks so an interrupted run resumes at a
  // boundary instead of re-fetching 54k orders. Without an upper bound every
  // chunk would run to the present and each one would cost more than the last.
  it("bounds the window on both ends when since and until are given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ordersPage([]));
    vi.stubGlobal("fetch", fetchMock);

    await createShopifyApiClient("shop.myshopify.com", "tok").getOrders({
      since: "2025-07-01",
      until: "2025-08-01",
    });

    expect(variablesOf(fetchMock).query).toBe(
      "created_at:>='2025-07-01' AND created_at:<'2025-08-01'"
    );
  });

  // Exclusive, so consecutive chunks neither drop nor duplicate an order
  // sitting exactly on a month boundary.
  it("treats until as exclusive", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ordersPage([]));
    vi.stubGlobal("fetch", fetchMock);

    await createShopifyApiClient("shop.myshopify.com", "tok").getOrders({
      until: "2025-08-01",
    });

    expect(variablesOf(fetchMock).query).toBe("created_at:<'2025-08-01'");
  });

  it("carries the same window across every page of a chunk", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ordersPage([{ id: "1" }], true, "cur1"))
      .mockResolvedValueOnce(ordersPage([{ id: "2" }]));
    vi.stubGlobal("fetch", fetchMock);

    const orders = await createShopifyApiClient(
      "shop.myshopify.com",
      "tok"
    ).getOrders({ since: "2025-07-01", until: "2025-08-01" });

    expect(orders).toHaveLength(2);
    expect(variablesOf(fetchMock, 1).query).toBe(
      "created_at:>='2025-07-01' AND created_at:<'2025-08-01'"
    );
    expect(variablesOf(fetchMock, 1).after).toBe("cur1");
  });
});

describe("ORDERS_QUERY line item selection", () => {
  // The four fields added for per-product net revenue. If the query stops
  // requesting them the transform silently writes nulls forever, and net
  // revenue reads as unknown instead of failing.
  it("requests the discount, shipping, vendor, and variant title", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ordersPage([]));
    vi.stubGlobal("fetch", fetchMock);

    await createShopifyApiClient("shop.myshopify.com", "tok").getOrders({});

    const query = JSON.parse(fetchMock.mock.calls[0][1].body as string).query;
    expect(query).toContain("totalDiscountSet { shopMoney { amount } }");
    expect(query).toContain("requiresShipping");
    expect(query).toContain("vendor");
    expect(query).toContain("variant { id sku title }");
  });
});

/**
 * ─── Unit cost, the input every COD figure rests on (#34) ─────────────
 *
 * Shopify's "Cost per item" holds landed product cost — China invoice plus
 * freight plus duty — which is exactly what a cost of delivery needs. Nothing
 * synced it, so no margin could be computed at all.
 *
 * Measured against the live store before building: 82.4% of active PHYSICAL
 * variants carry a cost (42 of 51; the gaps are 3 planners, 5 stationery, 1
 * bag). The other 181 active variants are digital, gift cards, subscriptions
 * and classes, which correctly have none.
 *
 * The distinction matters more than the number. "18% coverage" across all 232
 * active variants is the figure a naive count produces, and it describes a
 * catalogue that is mostly zero-COGS by design rather than a data gap.
 */
describe("getInventory: unit cost", () => {
  const variantNode = (over: Record<string, unknown> = {}) => ({
    id: "gid://shopify/ProductVariant/1",
    title: "Default",
    sku: "SKU1",
    inventoryQuantity: 5,
    price: "45.00",
    inventoryItem: { id: "gid://shopify/InventoryItem/1", tracked: true, unitCost: { amount: "12.50" } },
    product: { id: "gid://shopify/Product/1", title: "Planner", status: "ACTIVE", productType: "Planners" },
    ...over,
  });

  const variantsPage = (nodes: unknown[]) =>
    new Response(
      JSON.stringify({
        data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes } },
        extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  it("asks Shopify for the cost field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(variantsPage([]));
    vi.stubGlobal("fetch", fetchMock);
    await createShopifyApiClient("shop.myshopify.com", "tok").getInventory();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.query).toMatch(/unitCost/);
  });

  it("returns the cost when Shopify has one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(variantsPage([variantNode()])));
    const [v] = await createShopifyApiClient("shop.myshopify.com", "tok").getInventory();
    expect(v.inventoryItem?.unitCost).toBe("12.50");
  });

  /**
   * A variant with no cost recorded and a variant that genuinely costs nothing
   * are different facts. Digital products are legitimately 0.00; a planner
   * with no cost entered is a gap. Collapsing them to 0 would make every COD
   * figure quietly optimistic and there would be nothing to notice.
   */
  it("distinguishes no cost recorded from a cost of zero", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(variantsPage([
      variantNode({ inventoryItem: { id: "i1", tracked: true, unitCost: null } }),
      variantNode({ inventoryItem: { id: "i2", tracked: true, unitCost: { amount: "0.0" } } }),
    ])));
    const [missing, free] = await createShopifyApiClient("shop.myshopify.com", "tok").getInventory();
    expect(missing.inventoryItem?.unitCost).toBeNull();
    expect(free.inventoryItem?.unitCost).toBe("0.0");
  });

  it("survives a variant with no inventory item at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(variantsPage([variantNode({ inventoryItem: null })])));
    const [v] = await createShopifyApiClient("shop.myshopify.com", "tok").getInventory();
    expect(v.inventoryItem).toBeNull();
  });
});
