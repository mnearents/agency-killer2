import { describe, it, expect, vi } from "vitest";
import { dispatchTool, ALL_TOOLS, type McpToolContext } from "@/mcp/tools";
import { createPortalMetricsClient, type PortalMetricsClient } from "@/integrations/portal-metrics";

const TOKEN = "SECRET-INGEST-TOKEN-123";
const NOW = new Date("2026-11-15T12:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({ month: "2026-10", journey: "rad_welcome", delivered: 1200, opened: 600, clicked: 90, attributed_revenue: 431.5, ...over });
const ctxWith = (portalMetrics?: PortalMetricsClient): McpToolContext => ({ db: {} as never, now: () => NOW, portalMetrics });
const client = (fetchImpl: unknown) => createPortalMetricsClient({ baseUrl: "https://portal.example.com", token: TOKEN, fetchImpl: fetchImpl as typeof fetch });

/**
 * The portal, faked at the HTTP boundary: POST stores (replacing a month +
 * journey it holds), GET returns stored rows for ?months=. `post` and `get`
 * override a method's answer with a fixed status and body.
 */
function fakePortal(over: { post?: [number, unknown]; get?: [number, unknown] } = {}) {
  const stored = new Map<string, Record<string, unknown>>();
  let clock = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (init.method === "POST") {
      if (over.post) return answer(...over.post);
      const rows = JSON.parse(String(init.body)).rows as Array<Record<string, unknown>>;
      for (const r of rows) {
        const { attributed_revenue, ...rest } = r;
        stored.set(`${r.month}|${r.journey}`, { ...rest, attributedRevenue: attributed_revenue, updatedAt: `2026-11-15T12:00:0${clock++}.000Z` });
      }
      return answer(200, { stored: rows.length });
    }
    if (over.get) return answer(...over.get);
    const months = new URL(url).searchParams.get("months")?.split(",");
    return answer(200, { rows: [...stored.values()].filter((r) => !months || months.includes(r.month as string)) });
  });
  return { fetchImpl, stored, client: client(fetchImpl) };
}

const post = (ctx: McpToolContext, rows: unknown[]) => dispatchTool(ctx, "email_metrics_post", { rows }) as Promise<Record<string, any>>;
const get = (ctx: McpToolContext, args: Record<string, unknown> = {}) => dispatchTool(ctx, "email_metrics_get", args) as Promise<Record<string, any>>;
const posts = (f: { fetchImpl: { mock: { calls: unknown[][] } } }) => f.fetchImpl.mock.calls.filter((c) => (c[1] as RequestInit).method === "POST").length;

describe("email_metrics_post", () => {
  it("is declared a writer and says plainly that it writes to the RAD portal and that a resend replaces", () => {
    const tool = ALL_TOOLS.find((t) => t.name === "email_metrics_post")!;
    expect(tool.readOnly).toBe(false);
    expect(tool.description).toMatch(/WRITES to the RAD portal/);
    expect(tool.description).toMatch(/re-sending a month \+ journey replaces/i);
  });

  it("posts one valid row and returns stored 1 with the row as the portal read it back", async () => {
    const portal = fakePortal();
    const r = await post(ctxWith(portal.client), [row()]);
    expect(r).toEqual({
      stored: 1,
      rows: [{ month: "2026-10", journey: "rad_welcome", delivered: 1200, opened: 600, clicked: 90, attributedRevenue: 431.5, updatedAt: "2026-11-15T12:00:00.000Z" }],
    });
    expect(portal.fetchImpl.mock.calls[1][0]).toBe("https://portal.example.com/api/metrics/email?months=2026-10");
  });

  // The read-back is what the post wrote: other journeys in those months are not this call's.
  it("returns only the month + journey rows it posted, not the rest of those months", async () => {
    const portal = fakePortal();
    await post(ctxWith(portal.client), [row({ journey: "failed_payment" })]);
    const r = await post(ctxWith(portal.client), [row()]);
    expect(r.rows.map((x: { journey: string }) => x.journey)).toEqual(["rad_welcome"]);
  });

  it("replaces a month + journey sent again, so there is still one row", async () => {
    const portal = fakePortal();
    await post(ctxWith(portal.client), [row()]);
    const r = await post(ctxWith(portal.client), [row({ delivered: 1300 })]);
    expect(r).toMatchObject({ stored: 1, rows: [expect.objectContaining({ delivered: 1300 })] });
    expect(portal.stored.size).toBe(1);
  });

  it("refuses an unknown journey or an impossible month before calling the portal, naming the row", async () => {
    const portal = fakePortal();
    await expect(post(ctxWith(portal.client), [row(), row({ journey: "welcome" })])).rejects.toThrow(/rows\[1\]\.journey/);
    await expect(post(ctxWith(portal.client), [row({ month: "2026-13" })])).rejects.toThrow(/rows\[0\]\.month/);
    expect(portal.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses the same month and journey twice in one call, naming the second, before calling the portal", async () => {
    const portal = fakePortal();
    const r = await post(ctxWith(portal.client), [row(), row({ delivered: 5 })]);
    expect(r.error).toMatch(/rows\[1\].*rad_welcome.*2026-10/);
    expect(r).not.toHaveProperty("stored");
    expect(portal.fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces the portal's row-naming 400 and says nothing was stored", async () => {
    const portal = fakePortal({ post: [400, { error: 'row 2: unknown journey "welcome" (expected one of failed_payment, ...)' }] });
    const r = await post(ctxWith(portal.client), [row()]);
    expect(r.error).toMatch(/row 2: unknown journey "welcome"/);
    expect(r.error).toMatch(/stored nothing/);
    expect(r).not.toHaveProperty("stored");
  });

  it("says the token is wrong or missing on 401 and 503, and reports a 500, each once and without the token", async () => {
    for (const [status, pattern] of [[401, /token is wrong or missing/], [503, /token is wrong or missing/], [500, /answered 500: Failed to store/]] as const) {
      const portal = fakePortal({ post: [status, { error: `Failed to store metrics ${TOKEN}` }] });
      const r = await post(ctxWith(portal.client), [row()]);
      expect(r.error).toMatch(pattern);
      expect(r).not.toHaveProperty("stored");
      expect(posts(portal)).toBe(1);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });

  it("says plainly when the portal could not be reached, without retrying or showing the token", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED (Bearer ${TOKEN})`));
    const r = await post(ctxWith(client(fetchImpl)), [row()]);
    expect(r.error).toMatch(/could not reach the RAD portal/i);
    expect(r.error).toMatch(/not retried/);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // The write happened; a failed read-back must not make it look as if it did not.
  it("still reports stored when the read-back fails, with rows null and why", async () => {
    const portal = fakePortal({ get: [500, { error: "db down" }] });
    const r = await post(ctxWith(portal.client), [row()]);
    expect(r).toMatchObject({ stored: 1, rows: null, readBack: expect.stringMatching(/could not be read back.*500/) });
    expect(r).not.toHaveProperty("error");
  });

  it("says the portal is not configured, and sends nothing, without RAD_PORTAL_URL and the token", async () => {
    const r = await post(ctxWith(undefined), [row()]);
    expect(r.error).toMatch(/not configured/);
    expect(r.error).toMatch(/RAD_PORTAL_URL and METRICS_INGEST_TOKEN/);
  });
});

describe("email_metrics_get", () => {
  it("is read-only", () => {
    expect(ALL_TOOLS.find((t) => t.name === "email_metrics_get")!.readOnly).toBe(true);
  });

  it("defaults to this calendar month and the one before, from the injected clock", async () => {
    const portal = fakePortal();
    const r = await get(ctxWith(portal.client));
    expect(portal.fetchImpl.mock.calls[0][0]).toBe("https://portal.example.com/api/metrics/email?months=2026-10%2C2026-11");
    expect(r).toEqual({ months: ["2026-10", "2026-11"], rows: [] });
  });

  it("crosses a year boundary for the default window", async () => {
    const portal = fakePortal();
    await get({ ...ctxWith(portal.client), now: () => new Date("2027-01-03T00:00:00Z") });
    expect(portal.fetchImpl.mock.calls[0][0]).toMatch(/months=2026-12%2C2027-01$/);
  });

  it("returns the stored rows for the months asked, with when each was last updated", async () => {
    const portal = fakePortal();
    await post(ctxWith(portal.client), [row(), row({ month: "2026-08", journey: "pages_dropped" })]);
    const r = await get(ctxWith(portal.client), { months: ["2026-08"] });
    expect(r.rows).toEqual([expect.objectContaining({ month: "2026-08", journey: "pages_dropped", attributedRevenue: 431.5, updatedAt: expect.any(String) })]);
  });

  it("reports failures without the token, and the not-configured path", async () => {
    const r = await get(ctxWith(fakePortal({ get: [401, { error: TOKEN }] }).client));
    expect(r.error).toMatch(/token is wrong or missing/);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect((await get(ctxWith(undefined))).error).toMatch(/not configured/);
  });
});
