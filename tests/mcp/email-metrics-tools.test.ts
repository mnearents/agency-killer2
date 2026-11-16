import { describe, it, expect, vi } from "vitest";
import { dispatchTool, ALL_TOOLS, type McpToolContext } from "@/mcp/tools";
import { createPortalMetricsClient, type PortalMetricsClient } from "@/integrations/portal-metrics";

const TOKEN = "SECRET-INGEST-TOKEN-123";
const row = (over: Record<string, unknown> = {}) => ({ month: "2026-10", journey: "rad_welcome", delivered: 1200, opened: 600, clicked: 90, attributed_revenue: 431.5, ...over });
const ctxWith = (portalMetrics?: PortalMetricsClient): McpToolContext => ({ db: {} as never, now: () => new Date("2026-11-15T12:00:00Z"), portalMetrics });
const portal = (status: number, body: unknown) => {
  const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  return { fetchImpl, client: createPortalMetricsClient({ token: TOKEN, fetchImpl }) };
};
const post = (ctx: McpToolContext, rows: unknown[]) => dispatchTool(ctx, "email_metrics_post", { rows }) as Promise<Record<string, any>>;

describe("email_metrics_post", () => {
  it("is declared a writer and says plainly that it writes to the RAD portal and that a resend replaces", () => {
    const tool = ALL_TOOLS.find((t) => t.name === "email_metrics_post")!;
    expect(tool.readOnly).toBe(false);
    expect(tool.description).toMatch(/WRITES to the RAD portal/);
    expect(tool.description).toMatch(/re-sending a month \+ journey replaces/i);
  });

  it("posts one valid row and returns the portal's answer with the rows sent", async () => {
    const { fetchImpl, client } = portal(200, { stored: 1 });
    const r = await post(ctxWith(client), [row()]);
    expect(r).toEqual({ stored: 1, rows: [row()] });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ rows: [row()] });
  });

  // The portal replaces a month + journey it holds; the tool just sends it again.
  it("sends the same month and journey again with new figures", async () => {
    const { fetchImpl, client } = portal(200, { stored: 1 });
    await post(ctxWith(client), [row()]);
    const r = await post(ctxWith(client), [row({ delivered: 1300 })]);
    expect(r).toMatchObject({ stored: 1, rows: [expect.objectContaining({ delivered: 1300 })] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses an unknown journey or an impossible month before calling the portal, naming the row", async () => {
    const { fetchImpl, client } = portal(200, { stored: 2 });
    await expect(post(ctxWith(client), [row(), row({ journey: "welcome" })])).rejects.toThrow(/rows\[1\]\.journey/);
    await expect(post(ctxWith(client), [row({ month: "2026-13" })])).rejects.toThrow(/rows\[0\]\.month/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // The portal would refuse it too, but nothing is sent until every row passes.
  it("refuses the same month and journey twice in one call, naming the second, before calling the portal", async () => {
    const { fetchImpl, client } = portal(200, { stored: 2 });
    const r = await post(ctxWith(client), [row(), row({ delivered: 5 })]);
    expect(r.error).toMatch(/rows\[1\].*rad_welcome.*2026-10/);
    expect(r).not.toHaveProperty("stored");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an empty list", async () => {
    const { fetchImpl, client } = portal(200, { stored: 0 });
    expect((await post(ctxWith(client), [])).error).toMatch(/no rows/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says the token is wrong or missing when the server has none", async () => {
    const r = await post(ctxWith(undefined), [row()]);
    expect(r.error).toMatch(/token is wrong or missing/);
    expect(r.error).toMatch(/METRICS_INGEST_TOKEN is not set/);
  });

  it("says the token is wrong or missing when the portal answers 401 or 503, without retrying", async () => {
    for (const status of [401, 503]) {
      const { fetchImpl, client } = portal(status, { error: "Unauthorized" });
      const r = await post(ctxWith(client), [row()]);
      expect(r.error).toMatch(/token is wrong or missing/);
      expect(r).not.toHaveProperty("stored");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("passes the portal's own 400 message through", async () => {
    const { client } = portal(400, { error: "row 1: opened must be a whole number, got -3" });
    expect((await post(ctxWith(client), [row()])).error).toMatch(/row 1: opened must be a whole number, got -3/);
  });

  it("says plainly when the portal could not be reached, and that nothing was retried", async () => {
    const client = createPortalMetricsClient({ token: TOKEN, fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")) });
    const r = await post(ctxWith(client), [row()]);
    expect(r.error).toMatch(/could not reach the RAD portal.*fetch failed/i);
    expect(r.error).toMatch(/not retried/);
  });

  it("never puts the token in its output, whatever the portal answers", async () => {
    for (const [status, body] of [[200, { stored: 1 }], [400, { error: `bad ${TOKEN}` }], [401, {}], [500, { error: TOKEN }]] as const) {
      const { client } = portal(status, body);
      expect(JSON.stringify(await post(ctxWith(client), [row()]))).not.toContain(TOKEN);
    }
  });
});
