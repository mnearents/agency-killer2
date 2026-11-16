import { describe, it, expect, vi } from "vitest";
import { createPortalMetricsClient, PORTAL_EMAIL_METRICS_URL, type EmailMetricRow } from "@/integrations/portal-metrics";

const TOKEN = "SECRET-INGEST-TOKEN-123";
const ROW: EmailMetricRow = { month: "2026-10", journey: "rad_welcome", delivered: 1200, opened: 600, clicked: 90, attributed_revenue: 431.5 };
const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("createPortalMetricsClient", () => {
  it("POSTs the rows as JSON to the portal with the token as a bearer header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(200, { stored: 1 }));
    const r = await createPortalMetricsClient({ token: TOKEN, fetchImpl }).postEmailMetrics([ROW]);
    expect(r).toEqual({ ok: true, body: { stored: 1 } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://notify.radandhappy.com/api/metrics/email");
    expect(url).toBe(PORTAL_EMAIL_METRICS_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ rows: [ROW] });
  });

  it("passes the portal's 400 message through", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(400, { error: "row 2: duplicate rad_welcome row for 2026-10" }));
    expect(await createPortalMetricsClient({ token: TOKEN, fetchImpl }).postEmailMetrics([ROW])).toEqual({ ok: false, kind: "rejected", message: "row 2: duplicate rad_welcome row for 2026-10" });
  });

  // 401 is a token the portal does not accept; 503 is the portal with none set.
  it("reports 401 and 503 as the token, once, without retrying", async () => {
    for (const status of [401, 503]) {
      const fetchImpl = vi.fn().mockResolvedValue(reply(status, { error: "Unauthorized" }));
      expect(await createPortalMetricsClient({ token: TOKEN, fetchImpl }).postEmailMetrics([ROW])).toEqual({ ok: false, kind: "token", status });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("reports a network failure once, without retrying", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const r = await createPortalMetricsClient({ token: TOKEN, fetchImpl }).postEmailMetrics([ROW]);
    expect(r).toEqual({ ok: false, kind: "network", message: expect.stringMatching(/fetch failed/) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the timeout and says so", async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    const r = await createPortalMetricsClient({ token: TOKEN, fetchImpl: fetchImpl as never, timeoutMs: 20 }).postEmailMetrics([ROW]);
    expect(r).toEqual({ ok: false, kind: "network", message: expect.stringMatching(/timed out after 0\.02s/) });
  });

  it("reports any other answer as unexpected, with its status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(500, { error: "Failed to store metrics" }));
    expect(await createPortalMetricsClient({ token: TOKEN, fetchImpl }).postEmailMetrics([ROW])).toEqual({ ok: false, kind: "unexpected", status: 500, message: "Failed to store metrics" });
  });

  it("does not take an unreadable 200 as stored", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(200, "<html>proxy page</html>"));
    expect(await createPortalMetricsClient({ token: TOKEN, fetchImpl }).postEmailMetrics([ROW])).toMatchObject({ ok: false, kind: "unexpected", status: 200 });
  });

  // Whatever comes back, the token never leaves in a result.
  it("never returns the token, even when the portal or the network echoes it", async () => {
    const outcomes = [
      vi.fn().mockResolvedValue(reply(400, { error: `bad token ${TOKEN}` })),
      vi.fn().mockResolvedValue(reply(500, `oops ${TOKEN}`)),
      vi.fn().mockRejectedValue(new Error(`connect failed with Bearer ${TOKEN}`)),
    ];
    for (const fetchImpl of outcomes) {
      const r = await createPortalMetricsClient({ token: TOKEN, fetchImpl }).postEmailMetrics([ROW]);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });
});
