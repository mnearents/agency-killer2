/**
 * The Search Console client — the seam.
 *
 * Two things about this API shape the design, and both are the kind of thing
 * that produces a healthy-looking sync over no data.
 *
 * 1. **Access failures do not look like failures.** A service account with a
 *    valid key and no grant on the property returns `200 {}` from /sites, not
 *    403. A sync built without care would run daily, log "0 rows", exit 0 and
 *    look fine forever. That is the precise failure this whole issue exists
 *    about, so an empty site list is an error here, never an empty result.
 * 2. **The data lags two to three days.** The latest available date on
 *    2026-09-15 was 2026-09-13. "No rows for yesterday" is normal and must not
 *    read as a broken sync.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSearchConsoleClient,
  GSC_MAX_ROWS,
  type SearchConsoleClient,
} from "@/integrations/search-console";

const KEY = {
  client_email: "gsc-sync@rad-agency-2.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
  // A real RSA key would make these tests slow and add nothing — signing is
  // injected so the JWT assembly is still exercised.
  private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let client: SearchConsoleClient;
const tokenOk = () => jsonResponse({ access_token: "tok", expires_in: 3600 });

beforeEach(() => {
  fetchMock = vi.fn();
  client = createSearchConsoleClient({
    credentialsJson: JSON.stringify(KEY),
    siteUrl: "sc-domain:radandhappy.com",
    fetchFn: fetchMock as unknown as typeof fetch,
    signFn: () => "signature",
  });
});

describe("credentials", () => {
  it("refuses credentials that are not valid JSON rather than starting up broken", () => {
    expect(() =>
      createSearchConsoleClient({ credentialsJson: "not json", siteUrl: "sc-domain:x" })
    ).toThrow(/JSON/i);
  });

  it("refuses credentials missing the fields it needs to sign", () => {
    expect(() =>
      createSearchConsoleClient({ credentialsJson: JSON.stringify({ client_email: "a@b" }), siteUrl: "x" })
    ).toThrow(/private_key/);
  });

  it("surfaces a token exchange failure instead of returning no rows", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
    await expect(client.listSites()).rejects.toThrow(/invalid_grant|400/);
  });

  it("reuses a token across calls rather than exchanging one per request", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValue(jsonResponse({ siteEntry: [{ siteUrl: "sc-domain:radandhappy.com", permissionLevel: "siteRestrictedUser" }] }));
    await client.listSites();
    await client.listSites();
    const tokenCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("oauth2"));
    expect(tokenCalls).toHaveLength(1);
  });
});

/**
 * The 200-with-nothing case. A valid key that has not been granted access to
 * the property returns an empty object, and treating that as "no data" is how
 * a sync reports success having read nothing at all.
 */
describe("access is confirmed, not assumed", () => {
  it("throws when the site list is empty, rather than reporting no data", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValue(jsonResponse({}));
    await expect(client.assertAccess()).rejects.toThrow(/no propert|not been granted|access/i);
  });

  it("throws when the configured property is absent from the list", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValue(jsonResponse({ siteEntry: [{ siteUrl: "sc-domain:somewhereelse.com", permissionLevel: "siteOwner" }] }));
    await expect(client.assertAccess()).rejects.toThrow(/radandhappy/);
  });

  it("passes when the property is present", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValue(jsonResponse({ siteEntry: [{ siteUrl: "sc-domain:radandhappy.com", permissionLevel: "siteRestrictedUser" }] }));
    await expect(client.assertAccess()).resolves.toMatchObject({ permissionLevel: "siteRestrictedUser" });
  });
});

describe("searchAnalytics", () => {
  const row = (keys: string[], over = {}) => ({ keys, clicks: 1, impressions: 10, ctr: 0.1, position: 3, ...over });

  it("asks for the configured property and the dimensions requested", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValue(jsonResponse({ rows: [] }));
    await client.query({ startDate: "2026-09-01", endDate: "2026-09-07", dimensions: ["date", "query"] });

    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("searchAnalytics"))!;
    expect(String(call[0])).toContain(encodeURIComponent("sc-domain:radandhappy.com"));
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toMatchObject({ startDate: "2026-09-01", endDate: "2026-09-07", dimensions: ["date", "query"] });
  });

  it("returns typed rows with the dimension values split out", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValue(jsonResponse({ rows: [row(["2026-09-01", "rad and happy"], { clicks: 554 })] }));
    const rows = await client.query({ startDate: "2026-09-01", endDate: "2026-09-01", dimensions: ["date", "query"] });
    expect(rows[0]).toMatchObject({ keys: ["2026-09-01", "rad and happy"], clicks: 554 });
  });

  /**
   * The API caps a response at 25,000 rows and paginates by startRow. A client
   * that requests one page and stops silently truncates a busy day, and the
   * total would simply be lower than reality with nothing to indicate it.
   */
  it("pages until the API stops returning a full page", async () => {
    const full = Array.from({ length: GSC_MAX_ROWS }, (_, i) => row(["2026-09-01", `q${i}`]));
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(jsonResponse({ rows: full }))
      .mockResolvedValueOnce(jsonResponse({ rows: [row(["2026-09-01", "last"])] }));

    const rows = await client.query({ startDate: "2026-09-01", endDate: "2026-09-01", dimensions: ["date", "query"] });
    expect(rows).toHaveLength(GSC_MAX_ROWS + 1);

    const analyticsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("searchAnalytics"));
    expect(JSON.parse((analyticsCalls[1][1] as RequestInit).body as string).startRow).toBe(GSC_MAX_ROWS);
  });

  it("stops after a short page rather than looping forever", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValue(jsonResponse({ rows: [row(["2026-09-01", "one"])] }));
    await client.query({ startDate: "2026-09-01", endDate: "2026-09-01", dimensions: ["date", "query"] });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("searchAnalytics"))).toHaveLength(1);
  });

  // A day with no traffic is a real answer, not an error.
  it("returns an empty array when the API reports no rows", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValue(jsonResponse({}));
    await expect(
      client.query({ startDate: "2026-09-01", endDate: "2026-09-01", dimensions: ["date"] })
    ).resolves.toEqual([]);
  });

  it("surfaces an API error rather than an empty result", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValue(jsonResponse({ error: { message: "quota" } }, 429));
    await expect(
      client.query({ startDate: "2026-09-01", endDate: "2026-09-01", dimensions: ["date"] })
    ).rejects.toThrow(/429|quota/);
  });
});
