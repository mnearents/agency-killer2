import { describe, it, expect, vi, afterEach } from "vitest";
import { createHeartbeat } from "@/integrations/healthchecks";

const URL = "https://hc-ping.com/uuid-1";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("createHeartbeat", () => {
  it("pings start, success and fail at healthchecks.io's paths", async () => {
    const fetchMock = stubFetch(async () => new Response("OK"));
    const hb = createHeartbeat(URL);
    await hb.start();
    await hb.success();
    await hb.fail("token revoked");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`${URL}/start`, URL, `${URL}/fail`]);
  });

  // healthchecks.io shows a ping's body in its event log, so the failure
  // email says why, not just that.
  it("sends the failure reason as the body", async () => {
    const fetchMock = stubFetch(async () => new Response("OK"));
    await createHeartbeat(URL).fail("(#200) no ads_read");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: "(#200) no ads_read" });
  });

  // A ping that fails must not take the watch down with it.
  it("does not throw when healthchecks.io is unreachable", async () => {
    stubFetch(async () => { throw new Error("ENOTFOUND"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(createHeartbeat(URL).success()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("ENOTFOUND"));
    error.mockRestore();
  });

  it("reports itself unconfigured and pings nothing without a URL", async () => {
    const fetchMock = stubFetch(async () => new Response("OK"));
    const hb = createHeartbeat(undefined);
    expect(hb.configured).toBe(false);
    await hb.start(); await hb.success(); await hb.fail("x");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
