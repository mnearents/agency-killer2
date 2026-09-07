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
