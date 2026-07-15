import { vi } from "vitest";
import type { ShopifyApiClient } from "@/integrations/shopify-api";

export function createMockShopifyApiClient(
  overrides?: Partial<ShopifyApiClient>
): ShopifyApiClient {
  return {
    getOrders: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}
