import { describe, it, expect, vi } from "vitest";
import { fetchAllPages, MetaApiError } from "@/integrations/meta-api";

const page = (data: unknown[], next?: string) => new Response(JSON.stringify({ data, paging: next ? { next } : {} }), { status: 200 });
const throttled = (usageMinutes?: number) =>
  new Response(JSON.stringify({ error: { message: "There have been too many calls to this ad-account.", code: 80004 } }), {
    status: 400,
    headers: usageMinutes === undefined ? {} : {
      "x-business-use-case-usage": JSON.stringify({ act_1: [{ type: "ads_management", estimated_time_to_regain_access: usageMinutes }] }),
    },
  });

describe("fetchAllPages", () => {
  // The creatives fetch hit the ad-account limit every day this week and
  // gave up on the first refusal.
  it("waits and retries a page Meta throttled, then carries on", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([1], "p2"))
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(page([2]));
    const sleep = vi.fn(async (_ms: number) => {});
    expect(await fetchAllPages("p1", { fetchImpl, sleep, pageDelayMs: 0 })).toEqual([1, 2]);
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("waits as long as Meta says, when it says", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(throttled(2)).mockResolvedValueOnce(page([1]));
    const sleep = vi.fn(async (_ms: number) => {});
    await fetchAllPages("p1", { fetchImpl, sleep, pageDelayMs: 0 });
    expect(sleep).toHaveBeenCalledWith(2 * 60_000);
  });

  // A daily cron must not sit for an hour; the run records rate-limited instead.
  it("gives up rather than waiting longer than the cap", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => throttled(45));
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(fetchAllPages("p1", { fetchImpl, sleep, pageDelayMs: 0 })).rejects.toBeInstanceOf(MetaApiError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after its retries, with Meta's error", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => throttled());
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(fetchAllPages("p1", { fetchImpl, sleep, pageDelayMs: 0, maxRetries: 3 })).rejects.toThrow(/too many calls/);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([30_000, 60_000, 120_000]);
  });

  // Anything else is not a throttle, and waiting would only delay the error.
  it("does not retry an error that is not a throttle", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad", code: 190 } }), { status: 400 }));
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(fetchAllPages("p1", { fetchImpl, sleep, pageDelayMs: 0 })).rejects.toThrow(/bad/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("spaces its page requests out", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(page([1], "p2")).mockResolvedValueOnce(page([2]));
    const sleep = vi.fn(async (_ms: number) => {});
    await fetchAllPages("p1", { fetchImpl, sleep, pageDelayMs: 1_500 });
    expect(sleep).toHaveBeenCalledWith(1_500);
  });
});
