/**
 * The ShopifyQL client — sessions, which is the only source with enough
 * history to see the traffic collapse #21 exists about. 37 months, against
 * GA4's two.
 *
 * The property that matters most here is unusual: **ShopifyQL reports a bad
 * query as a 200.** A syntax error, an unknown column, an unsupported
 * function — all come back as HTTP 200 with `tableData: null` and a
 * `parseErrors` array. A client that reads `tableData` and moves on returns an
 * empty result for a query that never ran, and the sync above it records a day
 * with no traffic.
 *
 * That is not hypothetical: `sum(sessions)` and `total_sales` both did exactly
 * this while the token was valid and the scope was present.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createShopifyAnalyticsClient,
  type ShopifyAnalyticsClient,
} from "@/integrations/shopify-analytics";

function gql(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const table = (columns: string[], rows: Array<Record<string, string>>) =>
  gql({ data: { shopifyqlQuery: { tableData: { columns: columns.map((name) => ({ name })), rows }, parseErrors: null } } });

let fetchMock: ReturnType<typeof vi.fn>;
let client: ShopifyAnalyticsClient;

beforeEach(() => {
  fetchMock = vi.fn();
  client = createShopifyAnalyticsClient({
    storeDomain: "rad-happy.myshopify.com",
    accessToken: "shpca_test",
    fetchFn: fetchMock as unknown as typeof fetch,
  });
});

describe("requests", () => {
  it("authenticates with the Admin API token header", async () => {
    fetchMock.mockResolvedValue(table(["day", "sessions"], []));
    await client.query("FROM sessions SHOW sessions");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("rad-happy.myshopify.com/admin/api");
    expect((init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpca_test");
  });

  it("sends the ShopifyQL statement as written", async () => {
    fetchMock.mockResolvedValue(table(["sessions"], [{ sessions: "1" }]));
    await client.query("FROM sessions SHOW sessions SINCE -7d UNTIL today");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.query).toContain("FROM sessions SHOW sessions SINCE -7d UNTIL today");
  });

  it("returns rows keyed by column name, with numbers parsed", async () => {
    fetchMock.mockResolvedValue(
      table(["day", "sessions", "conversion_rate"], [{ day: "2026-09-14", sessions: "128", conversion_rate: "0.0229" }])
    );
    const rows = await client.query("FROM sessions SHOW sessions");
    expect(rows).toEqual([{ day: "2026-09-14", sessions: 128, conversion_rate: 0.0229 }]);
  });

  it("keeps non-numeric dimension values as strings", async () => {
    fetchMock.mockResolvedValue(table(["referrer_source", "sessions"], [{ referrer_source: "direct", sessions: "80" }]));
    expect(await client.query("q")).toEqual([{ referrer_source: "direct", sessions: 80 }]);
  });
});

/**
 * The whole reason this client exists rather than a raw fetch.
 */
describe("a parse error is a failure, not an empty result", () => {
  const parseError = (messages: string[]) =>
    gql({ data: { shopifyqlQuery: { tableData: null, parseErrors: messages } } });

  it("throws on an unknown column rather than returning no rows", async () => {
    fetchMock.mockResolvedValue(parseError(["Column Not Found: Column 'total_sales' not found"]));
    await expect(client.query("FROM sessions SHOW total_sales")).rejects.toThrow(/total_sales/);
  });

  it("throws on an unsupported function", async () => {
    fetchMock.mockResolvedValue(parseError(["Feature not supported: Could not find valid function sum()"]));
    await expect(client.query("FROM sessions SHOW sum(sessions)")).rejects.toThrow(/sum\(\)/);
  });

  it("includes the failing statement, since the error alone does not say which query", async () => {
    fetchMock.mockResolvedValue(parseError(["Column Not Found"]));
    await expect(client.query("FROM sessions SHOW nope GROUP BY day")).rejects.toThrow(/GROUP BY day/);
  });

  /**
   * A 200 with neither data nor an error is not something to interpret.
   *
   * Asserting the exact message, not merely "it throws". Mutation testing
   * caught this: removing the guard made the next line dereference null, which
   * also throws — so a bare `.rejects.toThrow()` passed over a version with no
   * guard at all. A different error has to fail the test.
   */
  it("throws a specific refusal when the response carries neither table data nor an error", async () => {
    fetchMock.mockResolvedValue(gql({ data: { shopifyqlQuery: { tableData: null, parseErrors: null } } }));
    await expect(client.query("q")).rejects.toThrow(/Refusing to read that as an empty result/);
  });

  it("throws on a GraphQL-level error", async () => {
    fetchMock.mockResolvedValue(gql({ errors: [{ message: "Access denied for shopifyqlQuery field" }] }));
    await expect(client.query("q")).rejects.toThrow(/Access denied/);
  });

  it("throws on a transport failure", async () => {
    fetchMock.mockResolvedValue(gql({ message: "boom" }, 500));
    await expect(client.query("q")).rejects.toThrow(/500/);
  });

  // A genuinely empty day is a real answer and must not throw.
  it("returns an empty array when the query ran and matched nothing", async () => {
    fetchMock.mockResolvedValue(table(["day", "sessions"], []));
    await expect(client.query("q")).resolves.toEqual([]);
  });
});

describe("scope check", () => {
  it("reports the read_reports scope as missing rather than failing obscurely later", async () => {
    fetchMock.mockResolvedValue(
      gql({ data: { currentAppInstallation: { accessScopes: [{ handle: "read_orders" }] } } })
    );
    await expect(client.assertReportsAccess()).rejects.toThrow(/read_reports/);
  });

  it("passes when the scope is present", async () => {
    fetchMock.mockResolvedValue(
      gql({ data: { currentAppInstallation: { accessScopes: [{ handle: "read_reports" }, { handle: "read_orders" }] } } })
    );
    await expect(client.assertReportsAccess()).resolves.toContain("read_reports");
  });
});
