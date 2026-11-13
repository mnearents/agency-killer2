import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createShipHeroClient, ShipHeroError, SHIPHERO_GRAPHQL_URL, SHIPHERO_REFRESH_URL, parseTimeRemainingMs } from "@/integrations/shiphero-api";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const page = (ids: string[], next: string | null) => ({
  data: {
    shipments: {
      request_id: "req-1",
      complexity: ids.length + 1,
      data: {
        pageInfo: { hasNextPage: next !== null, endCursor: next },
        edges: ids.map((id) => ({ node: { id, shipping_labels: [] } })),
      },
    },
  },
});

function setup(responses: Array<Response | (() => Response)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("no more responses");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  const sleep = vi.fn().mockResolvedValue(undefined);
  const throttles: unknown[] = [];
  const client = createShipHeroClient({ refreshToken: "REFRESH-SECRET", fetchImpl, sleep, onThrottle: (e) => throttles.push(e) });
  return { client, calls, sleep, throttles };
}

const WINDOW = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-07T23:59:59Z") };

describe("ShipHero client", () => {
  it("exchanges the refresh token once, then sends the access token as a bearer", async () => {
    const { client, calls } = setup([json({ access_token: "ACCESS-1", expires_in: 2419200 }), json(page(["a"], "c1")), json(page(["b"], null))]);
    await client.shipments(WINDOW, null);
    await client.shipments(WINDOW, "c1");
    expect(calls[0].url).toBe(SHIPHERO_REFRESH_URL);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ refresh_token: "REFRESH-SECRET" });
    // Reused, not refreshed on every call.
    expect(calls.filter((c) => c.url === SHIPHERO_REFRESH_URL)).toHaveLength(1);
    expect(calls[1].url).toBe(SHIPHERO_GRAPHQL_URL);
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer ACCESS-1");
  });

  it("always sends a date window and a page size of at most 100", async () => {
    const { client, calls } = setup([json({ access_token: "A" }), json(page(["a"], null))]);
    await client.shipments(WINDOW, null);
    const body = JSON.parse(String(calls[1].init.body));
    expect(body.variables).toEqual({ from: "2026-11-01T00:00:00Z", to: "2026-11-07T23:59:59Z", after: null });
    const first = Number(String(body.query).match(/first:\s*(\d+)/)![1]);
    expect(first).toBeLessThanOrEqual(100);
  });

  it("returns the page's shipments, cursor and request id", async () => {
    const { client } = setup([json({ access_token: "A" }), json(page(["a", "b"], "c1"))]);
    const r = await client.shipments(WINDOW, null);
    expect(r).toMatchObject({ requestId: "req-1", hasNextPage: true, endCursor: "c1" });
    expect(r.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  // Never select a customer field: the token can see them, the app must not keep them.
  it("selects no address, email or name of a customer", async () => {
    const { client, calls } = setup([json({ access_token: "A" }), json(page([], null))]);
    await client.shipments(WINDOW, null);
    const query = String(JSON.parse(String(calls[1].init.body)).query);
    for (const field of ["address", "email", "first_name", "last_name", "phone", "company", "customer", "to_address", "from_address", "profile"]) {
      expect(query, field).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it("waits the time_remaining a credit error reports, records it, and retries", async () => {
    const { client, sleep, throttles } = setup([
      json({ access_token: "A" }),
      json({ errors: [{ code: 30, message: "There are not enough credits", time_remaining: "3 seconds", request_id: "req-t" }], data: { shipments: null } }),
      json(page(["a"], null)),
    ]);
    const r = await client.shipments(WINDOW, null);
    expect(r.nodes).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(3500);
    expect(throttles).toEqual([{ kind: "credits", waitedMs: 3500, requestId: "req-t", detail: expect.stringMatching(/credits/) }]);
  });

  it("backs off on HTTP 429 and records it", async () => {
    const { client, sleep, throttles } = setup([json({ access_token: "A" }), json({}, 429), json(page(["a"], null))]);
    await client.shipments(WINDOW, null);
    expect(sleep).toHaveBeenCalledWith(30_000);
    expect(throttles).toEqual([{ kind: "http-429", waitedMs: 30_000, requestId: null, detail: expect.any(String) }]);
  });

  it("gives up after repeated throttling with an error that says so", async () => {
    const throttled = () => json({ errors: [{ code: 30, time_remaining: "1 second" }] });
    const { client } = setup([json({ access_token: "A" }), ...Array.from({ length: 10 }, () => throttled)]);
    await expect(client.shipments(WINDOW, null)).rejects.toMatchObject({ code: 30, message: expect.stringMatching(/throttled/i) });
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    const { client, calls } = setup([json({ access_token: "OLD" }), json({ message: "expired" }, 401), json({ access_token: "NEW" }), json(page(["a"], null))]);
    await client.shipments(WINDOW, null);
    expect((calls[3].init.headers as Record<string, string>).authorization).toBe("Bearer NEW");
  });

  it("reports a GraphQL error with its code and request id", async () => {
    const { client } = setup([json({ access_token: "A" }), json({ errors: [{ code: 7, message: "Missing permission billing.manage.read", request_id: "req-7" }] })]);
    const err = await client.shipments(WINDOW, null).catch((e) => e);
    expect(err).toBeInstanceOf(ShipHeroError);
    expect(err).toMatchObject({ code: 7, requestId: "req-7" });
  });

  it("never puts a token in an error", async () => {
    const { client } = setup([json({ access_token: "ACCESS-SECRET" }), json({ errors: [{ code: 9, message: "bad token ACCESS-SECRET / REFRESH-SECRET" }] })]);
    const err = await client.shipments(WINDOW, null).catch((e) => e);
    expect(String(err.message)).not.toMatch(/ACCESS-SECRET|REFRESH-SECRET/);
  });

  it("fails clearly when the refresh is refused", async () => {
    const { client } = setup([json({ error: "invalid_grant" }, 403)]);
    await expect(client.shipments(WINDOW, null)).rejects.toMatchObject({ message: expect.stringMatching(/refresh.*403/i) });
  });
});

describe("billing probe", () => {
  it("says a query refused for a missing permission is not permitted", async () => {
    const { client } = setup([json({ access_token: "A" }), json({ errors: [{ code: 7, message: "Missing Billing: Read", request_id: "r" }] })]);
    expect(await client.probe("bills")).toEqual({ query: "bills", readable: false, code: 7, detail: expect.stringMatching(/Billing/), requestId: "r" });
  });

  it("says a query that answered is readable", async () => {
    const { client } = setup([json({ access_token: "A" }), json({ data: { fulfillment_invoices: { request_id: "r2", data: { edges: [] } } } })]);
    expect(await client.probe("fulfillment_invoices")).toEqual({ query: "fulfillment_invoices", readable: true, code: null, detail: null, requestId: "r2" });
  });
});

describe("parseTimeRemainingMs", () => {
  it("reads seconds", () => {
    expect(parseTimeRemainingMs("3 seconds")).toBe(3000);
    expect(parseTimeRemainingMs("1 second")).toBe(1000);
    expect(parseTimeRemainingMs("0.5 seconds")).toBe(500);
  });
  it("is null for anything else", () => {
    expect(parseTimeRemainingMs(undefined)).toBeNull();
    expect(parseTimeRemainingMs("soon")).toBeNull();
  });
});

// Queries only, in every code path. The module holds fixed documents and no
// generic query method, and a document that is not a query is refused.
describe("no mutation can be sent", () => {
  const source = readFileSync(join(process.cwd(), "src/integrations/shiphero-api.ts"), "utf-8");

  it("the client source contains no mutation document", () => {
    const docs = source.match(/`[\s\S]*?`/g) ?? [];
    for (const d of docs) expect(d).not.toMatch(/\bmutation\b/i);
  });

  it("every GraphQL body it sends starts with `query`", async () => {
    const { client, calls } = setup([json({ access_token: "A" }), json(page([], null)), json({ data: { bills: { request_id: "r", data: { edges: [] } } } })]);
    await client.shipments(WINDOW, null);
    await client.probe("bills");
    for (const c of calls.filter((c) => c.url === SHIPHERO_GRAPHQL_URL)) {
      expect(String(JSON.parse(String(c.init.body)).query).trimStart()).toMatch(/^query\b/);
    }
  });

  it("exposes nothing but the shipments read and the billing probe", () => {
    const { client } = setup([]);
    expect(Object.keys(client).sort()).toEqual(["probe", "shipments"]);
  });

  it("no other module talks to ShipHero's API", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync("grep -rl 'public-api.shiphero.com' src || true", { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
    expect(hits).toEqual(["src/integrations/shiphero-api.ts"]);
  });
});
