import { describe, it, expect, vi } from "vitest";
import { createPortalMetricsClient, type EmailMetricRow } from "@/integrations/portal-metrics";

const TOKEN = "SECRET-INGEST-TOKEN-123";
const BASE = "https://portal.example.com/";
const ROW: EmailMetricRow = { month: "2026-10", journey: "rad_welcome", delivered: 1200, opened: 600, clicked: 90, attributed_revenue: 431.5 };
const reply = (status: number, body: unknown) => vi.fn().mockImplementation(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
const client = (fetchImpl: unknown, timeoutMs?: number) => createPortalMetricsClient({ baseUrl: BASE, token: TOKEN, fetchImpl: fetchImpl as typeof fetch, timeoutMs });

describe("postEmailMetrics", () => {
  it("POSTs the rows as JSON to RAD_PORTAL_URL's endpoint with the token as a bearer header", async () => {
    const fetchImpl = reply(200, { stored: 1 });
    expect(await client(fetchImpl).postEmailMetrics([ROW])).toEqual({ ok: true, stored: 1 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://portal.example.com/api/metrics/email");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ rows: [ROW] });
  });

  it("passes the portal's 400 message through", async () => {
    const r = await client(reply(400, { error: 'row 2: unknown journey "welcome"' })).postEmailMetrics([ROW]);
    expect(r).toEqual({ ok: false, kind: "rejected", message: 'row 2: unknown journey "welcome"' });
  });

  // 401 is a token the portal does not accept; 503 is the portal with none set.
  it("reports 401 and 503 as the token, once, without retrying", async () => {
    for (const status of [401, 503]) {
      const fetchImpl = reply(status, { error: "Unauthorized" });
      expect(await client(fetchImpl).postEmailMetrics([ROW])).toEqual({ ok: false, kind: "token", status });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("reports a 500 as unexpected, with the portal's message", async () => {
    expect(await client(reply(500, { error: "Failed to store metrics" })).postEmailMetrics([ROW])).toEqual({ ok: false, kind: "unexpected", status: 500, message: "Failed to store metrics" });
  });

  it("reports a network failure once, without retrying", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect(await client(fetchImpl).postEmailMetrics([ROW])).toEqual({ ok: false, kind: "network", message: "fetch failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the timeout and says so", async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    expect(await client(fetchImpl, 20).postEmailMetrics([ROW])).toEqual({ ok: false, kind: "network", message: expect.stringMatching(/timed out after 0\.02s/) });
  });

  it("does not take a 200 without a stored count as stored", async () => {
    expect(await client(reply(200, "<html>proxy page</html>")).postEmailMetrics([ROW])).toMatchObject({ ok: false, kind: "unexpected", status: 200 });
    expect(await client(reply(200, { ok: true })).postEmailMetrics([ROW])).toMatchObject({ ok: false, kind: "unexpected", status: 200 });
  });
});

describe("getEmailMetrics", () => {
  const stored = { month: "2026-10", journey: "rad_welcome", delivered: 1200, opened: 600, clicked: 90, attributedRevenue: 431.5, updatedAt: "2026-11-15T18:00:00.000Z" };

  it("GETs the named months, comma-separated, with the token", async () => {
    const fetchImpl = reply(200, { rows: [stored] });
    expect(await client(fetchImpl).getEmailMetrics(["2026-09", "2026-10"])).toEqual({ ok: true, rows: [stored] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://portal.example.com/api/metrics/email?months=2026-09%2C2026-10");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it("asks for every month when none are named", async () => {
    const fetchImpl = reply(200, { rows: [] });
    await client(fetchImpl).getEmailMetrics();
    expect(fetchImpl.mock.calls[0][0]).toBe("https://portal.example.com/api/metrics/email");
  });

  it("passes a 400 through and refuses a reply without rows", async () => {
    expect(await client(reply(400, { error: 'months must be YYYY-MM, got "2026-13"' })).getEmailMetrics(["2026-13"])).toEqual({ ok: false, kind: "rejected", message: 'months must be YYYY-MM, got "2026-13"' });
    expect(await client(reply(200, {})).getEmailMetrics()).toMatchObject({ ok: false, kind: "unexpected" });
  });
});

// Whatever comes back, the token never leaves in a result.
describe("the token", () => {
  it("never appears in a result, even when the portal or the network echoes it", async () => {
    const outcomes = [
      reply(400, { error: `bad token ${TOKEN}` }),
      reply(500, `oops ${TOKEN}`),
      reply(200, { stored: 1, echo: TOKEN }),
      vi.fn().mockRejectedValue(new Error(`connect failed with Bearer ${TOKEN}`)),
    ];
    for (const fetchImpl of outcomes) {
      expect(JSON.stringify(await client(fetchImpl).postEmailMetrics([ROW]))).not.toContain(TOKEN);
      expect(JSON.stringify(await client(fetchImpl).getEmailMetrics(["2026-10"]))).not.toContain(TOKEN);
    }
  });
});
