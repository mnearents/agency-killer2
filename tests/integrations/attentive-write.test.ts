/**
 * The Attentive write client — the seam for the only integration in this
 * project that changes something in a system outside it.
 *
 * Three properties carry more weight here than anywhere else, because getting
 * them wrong does not produce a bad number on a dashboard. It sends real
 * messages to real customers, or fails to send ones we believe went out.
 *
 * 1. **A batch that is too large is refused, never truncated.** The API caps a
 *    request at 10,000 members. Silently sending the first 10,000 of 12,232
 *    would report success over a segment missing 2,232 people, and nothing
 *    downstream could tell.
 * 2. **`COMPLETED` is not success.** The job status endpoint reports a job-level
 *    state and puts per-record outcomes in a separate `.jsonl` file. A job that
 *    completes having rejected 4,000 records still says `COMPLETED`, so the
 *    client reads the file and refuses to report a count it did not count.
 * 3. **Eligibility is read, not assumed.** Shopify's `accepts_marketing` and
 *    Attentive's marketing eligibility disagree by about 13% on the lapsed
 *    cohort, measured over a 200-person sample.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAttentiveWriteClient,
  MAX_MEMBERS_PER_REQUEST,
  type AttentiveWriteClient,
} from "@/integrations/attentive-write";

const KEY = "test-attentive-key";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let client: AttentiveWriteClient;

beforeEach(() => {
  fetchMock = vi.fn();
  client = createAttentiveWriteClient({ apiKey: KEY, fetchFn: fetchMock as unknown as typeof fetch });
});

afterEach(() => vi.clearAllMocks());

const member = (i: number) => ({ email: `p${i}@example.com` });

describe("authentication and shape", () => {
  it("sends the key as a bearer token on every call", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ segments: [], hasMore: false }));
    await client.listSegments();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("creates a segment with the external id we chose, not one Attentive invents", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ externalId: "lapsed_12_to_24m", name: "Lapsed 12-24m", description: "d" })
    );
    const seg = await client.createSegment({
      name: "Lapsed 12-24m",
      externalId: "lapsed_12_to_24m",
      description: "d",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/v2/segments");
    expect(JSON.parse(init.body).externalId).toBe("lapsed_12_to_24m");
    expect(seg.externalId).toBe("lapsed_12_to_24m");
  });

  it("surfaces an API error rather than returning an empty success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "nope" }, 403));
    await expect(client.listSegments()).rejects.toThrow(/403/);
  });
});

describe("batch limits are refused, never truncated", () => {
  it("accepts a request at exactly the cap", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ batchJobId: "job1" }));
    const members = Array.from({ length: MAX_MEMBERS_PER_REQUEST }, (_, i) => member(i));
    await expect(client.addSegmentMembers("seg", members)).resolves.toMatchObject({
      batchJobId: "job1",
    });
  });

  /**
   * The failure this prevents: sending the first 10,000 of 12,232 and
   * reporting success. The segment would be short 2,232 people and every
   * number downstream would say it was complete.
   */
  it("refuses a request over the cap instead of sending part of it", async () => {
    const members = Array.from({ length: MAX_MEMBERS_PER_REQUEST + 1 }, (_, i) => member(i));
    await expect(client.addSegmentMembers("seg", members)).rejects.toThrow(/10000|10,000/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty member list rather than sending a no-op that reads as a push", async () => {
    await expect(client.addSegmentMembers("seg", [])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies the same cap to removals", async () => {
    const members = Array.from({ length: MAX_MEMBERS_PER_REQUEST + 1 }, (_, i) => member(i));
    await expect(client.removeSegmentMembers("seg", members)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a member with no identifier at all", async () => {
    await expect(client.addSegmentMembers("seg", [{} as never])).rejects.toThrow(/identifier/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends removals to DELETE, not POST", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ batchJobId: "job2" }));
    await client.removeSegmentMembers("seg", [member(1)]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/v2/bulk/segments/members");
    expect(init.method).toBe("DELETE");
  });
});

/**
 * The job status endpoint reports IN_PROGRESS / COMPLETED / NEEDS_REVIEW /
 * CANCELLED and nothing about individual records. Per-record outcomes live in
 * a `.jsonl` the response links to. A client that returns `COMPLETED` and
 * stops has not established that anything was written.
 */
describe("a completed job is not a successful one", () => {
  const completed = (url: string | null) =>
    jsonResponse({ status: "COMPLETED", ...(url ? { resultUrl: url } : {}) });

  it("reads the result file and counts records rather than trusting the status", async () => {
    fetchMock
      .mockResolvedValueOnce(completed("https://results.example/j.jsonl"))
      .mockResolvedValueOnce(
        textResponse(
          [
            '{"request":{"email":"a@example.com"},"response":{"status":200}}',
            '{"request":{"email":"b@example.com"},"response":{"status":200}}',
            '{"request":{"email":"c@example.com"},"response":{"status":422,"message":"invalid"}}',
          ].join("\n")
        )
      );

    const job = await client.getBulkJob("job1");
    expect(job.status).toBe("COMPLETED");
    expect(job.succeeded).toBe(2);
    expect(job.failed).toBe(1);
    expect(job.failures[0]).toMatchObject({ identifier: "c@example.com" });
  });

  // The whole point. Without the file there is no per-record evidence, so the
  // counts must be null rather than zero — zero failures is a claim.
  it("reports unknown counts, not zero, when the result file is missing", async () => {
    fetchMock.mockResolvedValueOnce(completed(null));
    const job = await client.getBulkJob("job1");
    expect(job.status).toBe("COMPLETED");
    expect(job.succeeded).toBeNull();
    expect(job.failed).toBeNull();
    expect(job.problem).toMatch(/no result file/i);
  });

  it("reports unknown counts when the result file cannot be fetched", async () => {
    fetchMock
      .mockResolvedValueOnce(completed("https://results.example/j.jsonl"))
      .mockResolvedValueOnce(textResponse("gone", 404));
    const job = await client.getBulkJob("job1");
    expect(job.succeeded).toBeNull();
    expect(job.problem).toBeTruthy();
  });

  it("does not fetch a result file for a job that is still running", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "IN_PROGRESS" }));
    const job = await client.getBulkJob("job1");
    expect(job.status).toBe("IN_PROGRESS");
    expect(job.succeeded).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a malformed line as a failure rather than skipping it", async () => {
    fetchMock
      .mockResolvedValueOnce(completed("https://results.example/j.jsonl"))
      .mockResolvedValueOnce(
        textResponse(['{"request":{"email":"a@example.com"},"response":{"status":200}}', "{not json"].join("\n"))
      );
    const job = await client.getBulkJob("job1");
    expect(job.succeeded).toBe(1);
    expect(job.failed).toBe(1);
  });
});

describe("eligibility", () => {
  const eligibilityResponse = (users: Record<string, unknown>) =>
    jsonResponse({ data: { viewer: { installedApplication: { installerCompany: users } } } });

  const elig = (channel: string, type: string, ok: boolean) => ({
    subscription: { channel, type },
    eligibility: { isEligible: ok },
  });

  it("reports who can actually receive a marketing message", async () => {
    fetchMock.mockResolvedValue(
      eligibilityResponse({
        u0: { subscriptions: { subscriptionEligibilities: [elig("CHANNEL_EMAIL", "TYPE_MARKETING", true)] } },
        u1: { subscriptions: { subscriptionEligibilities: [elig("CHANNEL_EMAIL", "TYPE_TRANSACTIONAL", true)] } },
        u2: null,
      })
    );

    const out = await client.getEligibility(["a@x.com", "b@x.com", "c@x.com"]);
    expect(out).toEqual([
      { email: "a@x.com", known: true, marketingEligible: true },
      { email: "b@x.com", known: true, marketingEligible: false },
      { email: "c@x.com", known: false, marketingEligible: false },
    ]);
  });

  // Transactional eligibility is not permission to market to someone.
  it("does not count transactional or abandoned-checkout eligibility as marketing", async () => {
    fetchMock.mockResolvedValue(
      eligibilityResponse({
        u0: {
          subscriptions: {
            subscriptionEligibilities: [
              elig("CHANNEL_EMAIL", "TYPE_TRANSACTIONAL", true),
              elig("CHANNEL_EMAIL", "TYPE_CHECKOUT_ABANDONED", true),
              elig("CHANNEL_EMAIL", "TYPE_MARKETING", false),
            ],
          },
        },
      })
    );
    const [one] = await client.getEligibility(["a@x.com"]);
    expect(one.marketingEligible).toBe(false);
  });

  it("counts SMS marketing eligibility, since a segment push reaches both", async () => {
    fetchMock.mockResolvedValue(
      eligibilityResponse({
        u0: { subscriptions: { subscriptionEligibilities: [elig("CHANNEL_TEXT", "TYPE_MARKETING", true)] } },
      })
    );
    const [one] = await client.getEligibility(["a@x.com"]);
    expect(one.marketingEligible).toBe(true);
  });

  it("batches rather than making one request per address", async () => {
    fetchMock.mockResolvedValue(eligibilityResponse({}));
    await client.getEligibility(Array.from({ length: 60 }, (_, i) => `p${i}@x.com`));
    // 60 addresses must not be 60 requests.
    expect(fetchMock.mock.calls.length).toBeLessThan(10);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("returns an entry for every address asked about, in order", async () => {
    fetchMock.mockResolvedValue(eligibilityResponse({}));
    const emails = Array.from({ length: 60 }, (_, i) => `p${i}@x.com`);
    const out = await client.getEligibility(emails);
    expect(out.map((o) => o.email)).toEqual(emails);
  });

  it("asks nothing and returns nothing for an empty list", async () => {
    expect(await client.getEligibility([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A GraphQL 200 carrying errors is still a failure.
  it("throws when GraphQL returns errors alongside a 200", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ message: "bad" }] }));
    await expect(client.getEligibility(["a@x.com"])).rejects.toThrow(/bad/);
  });
});
