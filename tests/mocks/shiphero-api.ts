import { vi } from "vitest";
import type { ShipHeroClient } from "@/integrations/shiphero-api";

export function createMockShipHeroClient(overrides: Partial<ShipHeroClient> = {}): ShipHeroClient {
  return {
    shipments: vi.fn().mockResolvedValue({ requestId: "req", complexity: 1, nodes: [], hasNextPage: false, endCursor: null }),
    probe: vi.fn().mockImplementation(async (query) => ({ query, readable: false, code: 7, detail: "Missing permission", requestId: "req" })),
    ...overrides,
  };
}
