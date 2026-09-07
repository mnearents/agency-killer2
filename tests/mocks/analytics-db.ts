import { vi } from "vitest";
import type { AnalyticsDb } from "@/mcp/analytics-db";

export function createMockAnalyticsDb(overrides?: Partial<AnalyticsDb>): AnalyticsDb {
  return {
    select: vi.fn().mockResolvedValue({ columns: [], rows: [], truncated: false }),
    describe: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** `n` rows shaped like a real result, for exercising the cap. */
export function makeRows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, tier: "spark" }));
}
