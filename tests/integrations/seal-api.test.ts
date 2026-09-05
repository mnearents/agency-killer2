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

  // The list endpoint omits customer_id, log and tags entirely; only the
  // single-subscription endpoint carries them. That is the sole reason this
  // endpoint is called, and why all three are fetched in one request.
  describe("getSubscriptionDetail", () => {
    const detail = (id: string) =>
      createSealApiClient({ apiToken: "t", sleep: noSleep }).getSubscriptionDetail(id);

    it("reads customer_id from the single-subscription endpoint", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ success: true, payload: { id: 42, customer_id: "10089422586101" } }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await detail("42");

      expect(result.customerId).toBe("10089422586101");
      expect(fetchMock.mock.calls[0][0]).toContain("/subscription?id=42");
    });

    // Seal returns a bare numeric string. Shopify stores a GID. Neither side
    // should have to remember which form it is holding.
    it("returns the bare numeric id, not a GID", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ success: true, payload: { customer_id: "10089422586101" } }))
      );

      expect((await detail("42")).customerId).not.toContain("gid://");
    });

    // A migrated subscription may genuinely have no Shopify customer behind it.
    // That is a real answer and must be distinguishable from a failed lookup.
    it("returns null when the record carries no customer_id", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ success: true, payload: { id: 42, customer_id: "" } }))
      );

      expect((await detail("42")).customerId).toBeNull();
    });

    it("throws rather than returning null when the lookup itself fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 404)));

      await expect(detail("42")).rejects.toThrow(/404/);
    });

    it("throws when the envelope is not the shape we depend on", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} })));

      await expect(detail("42")).rejects.toThrow(/envelope/i);
    });

    // Seal answers an unauthorised request with `payload: []`. That is an
    // object to `typeof`, so without an array check it slips through as a
    // subscription with no customer, no log and no tags — 4,390 silent blanks.
    it("throws on the empty-array payload Seal returns when forbidden", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ success: false, error: "Access forbidden.", payload: [] }))
      );

      await expect(detail("42")).rejects.toThrow(/envelope/i);
    });

    it("retries a 503 like every other call", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("busy", { status: 503 }))
        .mockResolvedValueOnce(jsonResponse({ success: true, payload: { customer_id: "7" } }));
      vi.stubGlobal("fetch", fetchMock);

      expect((await detail("42")).customerId).toBe("7");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("reads the audit log, preserving content and timestamp", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({
            success: true,
            payload: {
              customer_id: "7",
              log: [
                { content: 'Merchant added item "Really Awesome Doodles - Studio" to the subscription through the API.', created: "2026-08-03 17:13:50" },
                { content: 'Merchant removed item "Really Awesome Doodles Spark" from the subscription through the API.', created: "2026-08-03 17:13:52" },
              ],
            },
          })
        )
      );

      const { log } = await detail("42");
      expect(log).toHaveLength(2);
      expect(log?.[0].content).toContain("Really Awesome Doodles - Studio");
      expect(log?.[0].created).toBe("2026-08-03 17:13:50");
    });

    it("reads tags as a string array", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({ success: true, payload: { customer_id: "7", tags: ["subscription", "color-happy"] } })
        )
      );

      expect((await detail("42")).tags).toEqual(["subscription", "color-happy"]);
    });

    // An empty log is a real answer — nobody ever edited this subscription.
    it("distinguishes an empty log from an absent one", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ success: true, payload: { customer_id: "7", log: [], tags: [] } }))
      );

      const result = await detail("42");
      expect(result.log).toEqual([]);
      expect(result.tags).toEqual([]);
    });

    // The distinction matters: [] means "never edited", so storing it for a
    // field that was actually missing would hide every tier change on the
    // record and quietly understate the upgrade count.
    it("returns null, not an empty array, when log and tags are absent", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ success: true, payload: { customer_id: "7" } }))
      );

      const result = await detail("42");
      expect(result.log).toBeNull();
      expect(result.tags).toBeNull();
    });

    it("drops malformed log entries rather than trusting their shape", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({
            success: true,
            payload: {
              customer_id: "7",
              log: [{ content: "real", created: "2026-08-03 17:13:50" }, { content: 42 }, null, "nope"],
            },
          })
        )
      );

      expect((await detail("42")).log).toEqual([{ content: "real", created: "2026-08-03 17:13:50" }]);
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
