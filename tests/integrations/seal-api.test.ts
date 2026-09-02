import { describe, it, expect, vi, afterEach } from "vitest";
import { createSealApiClient } from "@/integrations/seal-api";

const noSleep = () => Promise.resolve();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function page(subs: unknown[], pageNo: number, totalPages: number) {
  return jsonResponse({
    success: true,
    payload: { subscriptions: subs, page: pageNo, total_pages: totalPages },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSealApiClient", () => {
  it("sends the API token in the X-Seal-Token header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([{ id: 1 }], 1, 1));
    vi.stubGlobal("fetch", fetchMock);

    await createSealApiClient({ apiToken: "tok_123", sleep: noSleep }).getAllSubscriptions();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-Seal-Token"]).toBe("tok_123");
  });

  // Cancelled records carry cancelled_on plus intact items and billing
  // attempts. Filtering them out server-side would make cohort retention
  // impossible to compute.
  it("never sends active-only, and always asks for items and billing attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([{ id: 1 }], 1, 1));
    vi.stubGlobal("fetch", fetchMock);

    await createSealApiClient({ apiToken: "t", sleep: noSleep }).getAllSubscriptions();

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain("active-only");
    expect(url).toContain("with-items=true");
    expect(url).toContain("with-billing-attempts=true");
  });

  it("follows total_pages to the end and concatenates every page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: 1 }, { id: 2 }], 1, 3))
      .mockResolvedValueOnce(page([{ id: 3 }], 2, 3))
      .mockResolvedValueOnce(page([{ id: 4 }], 3, 3));
    vi.stubGlobal("fetch", fetchMock);

    const subs = await createSealApiClient({ apiToken: "t", sleep: noSleep }).getAllSubscriptions();

    expect(subs.map((s) => s.id)).toEqual([1, 2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 503 and returns the eventual success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(page([{ id: 7 }], 1, 1));
    vi.stubGlobal("fetch", fetchMock);

    const subs = await createSealApiClient({ apiToken: "t", sleep: noSleep }).getAllSubscriptions();

    expect(subs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Seal serves HTML error pages under load. Parsing one as JSON would throw
  // somewhere far less obvious than here.
  it("retries a non-JSON response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>error</html>", { status: 200, headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(page([{ id: 7 }], 1, 1));
    vi.stubGlobal("fetch", fetchMock);

    const subs = await createSealApiClient({ apiToken: "t", sleep: noSleep }).getAllSubscriptions();
    expect(subs).toHaveLength(1);
  });

  it("retries a network error before giving up", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(page([{ id: 7 }], 1, 1));
    vi.stubGlobal("fetch", fetchMock);

    const subs = await createSealApiClient({ apiToken: "t", sleep: noSleep }).getAllSubscriptions();
    expect(subs).toHaveLength(1);
  });

  it("throws on a non-OK response rather than returning nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "bad token" }, 401)));

    await expect(
      createSealApiClient({ apiToken: "t", sleep: noSleep }).getAllSubscriptions()
    ).rejects.toThrow(/401/);
  });

  // The envelope is undocumented. If Seal ever changes it, an empty array
  // would read as "every subscriber is gone" — so it has to be an error.
  it("throws when the response envelope is not the shape we depend on", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true, data: [] })));

    await expect(
      createSealApiClient({ apiToken: "t", sleep: noSleep }).getAllSubscriptions()
    ).rejects.toThrow(/envelope/i);
  });

  it("throws when subscriptions is missing from an otherwise valid payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true, payload: { total_pages: 1 } })));

    await expect(
      createSealApiClient({ apiToken: "t", sleep: noSleep }).getAllSubscriptions()
    ).rejects.toThrow(/envelope/i);
  });

  // The list endpoint omits customer_id entirely; only the single-subscription
  // endpoint carries it. This is the sole reason that endpoint is called.
  describe("getSubscriptionCustomerId", () => {
    it("reads customer_id from the single-subscription endpoint", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ success: true, payload: { id: 42, customer_id: "10089422586101" } }));
      vi.stubGlobal("fetch", fetchMock);

      const id = await createSealApiClient({ apiToken: "t", sleep: noSleep }).getSubscriptionCustomerId("42");

      expect(id).toBe("10089422586101");
      expect(fetchMock.mock.calls[0][0]).toContain("/subscription?id=42");
    });

    // Seal returns a bare numeric string. Shopify stores a GID. Neither side
    // should have to remember which form it is holding.
    it("returns the bare numeric id, not a GID", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ success: true, payload: { customer_id: "10089422586101" } }))
      );

      const id = await createSealApiClient({ apiToken: "t", sleep: noSleep }).getSubscriptionCustomerId("42");
      expect(id).not.toContain("gid://");
    });

    // A migrated subscription may genuinely have no Shopify customer behind it.
    // That is a real answer and must be distinguishable from a failed lookup.
    it("returns null when the record carries no customer_id", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ success: true, payload: { id: 42, customer_id: "" } }))
      );

      const id = await createSealApiClient({ apiToken: "t", sleep: noSleep }).getSubscriptionCustomerId("42");
      expect(id).toBeNull();
    });

    it("throws rather than returning null when the lookup itself fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 404)));

      await expect(
        createSealApiClient({ apiToken: "t", sleep: noSleep }).getSubscriptionCustomerId("42")
      ).rejects.toThrow(/404/);
    });

    it("throws when the envelope is not the shape we depend on", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} })));

      await expect(
        createSealApiClient({ apiToken: "t", sleep: noSleep }).getSubscriptionCustomerId("42")
      ).rejects.toThrow(/envelope/i);
    });

    it("retries a 503 like every other call", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("busy", { status: 503 }))
        .mockResolvedValueOnce(jsonResponse({ success: true, payload: { customer_id: "7" } }));
      vi.stubGlobal("fetch", fetchMock);

      expect(await createSealApiClient({ apiToken: "t", sleep: noSleep }).getSubscriptionCustomerId("42")).toBe("7");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("stops after the retry budget instead of looping forever", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSealApiClient({ apiToken: "t", sleep: noSleep }).getAllSubscriptions()
    ).rejects.toThrow(/ECONNRESET/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
