import { describe, it, expect, vi } from "vitest";
import { runToolCall } from "@/mcp/server";
import type { McpToolContext } from "@/mcp/tools";

vi.mock("@/domain/meta/queries", () => ({
  getInsightTotals: vi.fn().mockResolvedValue([]),
  getInsightsByCampaign: vi.fn().mockRejectedValue(new Error("connection refused")),
  getInsightsByAdCreative: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/db/freshness", () => ({
  getDataFreshness: vi.fn().mockResolvedValue([]),
}));

const ctx: McpToolContext = { db: {} as never, now: () => new Date("2026-09-02T12:00:00Z") };

describe("runToolCall", () => {
  it("returns the tool result as JSON text", async () => {
    const result = await runToolCall(ctx, "data_freshness", {});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ sources: [], anyStale: false });
  });

  // A thrown error would kill the stdio transport and take the whole session
  // with it. Worse, a caller that can't see the error can't correct itself.
  it("reports a failing query as an error result instead of throwing", async () => {
    const result = await runToolCall(ctx, "ads_performance", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("connection refused");
  });

  it("reports an unknown tool as an error result", async () => {
    const result = await runToolCall(ctx, "nonexistent", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("nonexistent");
  });

  it("reports a bad argument as an error result naming the argument", async () => {
    const result = await runToolCall(ctx, "ads_performance", { days: -5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("days");
  });

  // Half a result read as a whole result is exactly the silent failure this
  // server exists to prevent.
  it("never returns partial data alongside an error", async () => {
    const result = await runToolCall(ctx, "ads_performance", {});
    expect(result.content).toHaveLength(1);
    expect(() => JSON.parse(result.content[0].text)).toThrow();
  });
});
