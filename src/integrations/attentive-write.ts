/**
 * Attentive write client — the seam.
 *
 * This is the only integration in the project that changes something in a
 * system outside it. Everything else reads. Getting it wrong does not produce
 * a bad number on a dashboard; it sends real messages to real customers, or
 * fails to send ones we believe went out. The extra strictness below is for
 * that reason, not for symmetry with the other clients.
 *
 * Deliberately separate from `attentive-agent.ts`, which is a Playwright UI
 * scraper that exports a bare function. This follows the interface + factory
 * pattern so a test can swap it at the boundary.
 *
 * ## What the API actually guarantees, and what it does not
 *
 * `POST /v2/bulk/segments/members` and its DELETE counterpart are async. They
 * return a `batchJobId` and nothing about whether any particular person was
 * added. `GET /v2/bulk/job/{id}` then reports a job-level status —
 * IN_PROGRESS, COMPLETED, NEEDS_REVIEW, CANCELLED — and puts the per-record
 * outcomes in a separate `.jsonl` file it links to.
 *
 * So **COMPLETED is not success**. A job that completes having rejected four
 * thousand records reports COMPLETED. This client reads the file and counts,
 * and when it cannot, it returns `null` counts and a `problem` rather than
 * zero failures — because zero failures is a claim, and a claim needs
 * evidence.
 *
 * Eligibility is read through `POST /v1/graphql`, which is where subscriber
 * lookup lives despite the REST-shaped reference page. Shopify's
 * `accepts_marketing` and Attentive's marketing eligibility disagree by about
 * 13% on the lapsed cohort, measured over a 200-person sample, so reachability
 * is something to look up rather than infer.
 */

const DEFAULT_BASE_URL = "https://api.attentivemobile.com";

/** The API's own cap. Documented on POST /v2/bulk/segments/members. */
export const MAX_MEMBERS_PER_REQUEST = 10_000;

/** GraphQL aliases per eligibility request. Well under any query-size limit. */
const ELIGIBILITY_BATCH_SIZE = 25;

export interface AttentiveSegment {
  externalId: string;
  name: string;
  description?: string;
}

/** At least one identifier is required. Email is what we have. */
export interface SegmentMember {
  email?: string;
  phone?: string;
  clientUserId?: string;
}

export interface BulkJobAccepted {
  batchJobId: string;
}

export type BulkJobStatus = "IN_PROGRESS" | "COMPLETED" | "NEEDS_REVIEW" | "CANCELLED";

export interface BulkJobFailure {
  identifier: string;
  detail: string;
}

export interface BulkJobResult {
  status: BulkJobStatus;
  /**
   * Per-record counts from the result file, or `null` when the file was absent
   * or unreadable. `null` and `0` are different facts: one means "we could not
   * look", the other means "we looked and everything worked".
   */
  succeeded: number | null;
  failed: number | null;
  failures: BulkJobFailure[];
  /** Non-null when the job's outcome could not be established. */
  problem: string | null;
}

export interface SubscriberEligibility {
  email: string;
  /** Whether Attentive has this address at all. */
  known: boolean;
  /** Whether a marketing message would actually reach them, on any channel. */
  marketingEligible: boolean;
}

export interface AttentiveWriteClient {
  listSegments(): Promise<AttentiveSegment[]>;
  createSegment(input: { name: string; description?: string; externalId?: string }): Promise<AttentiveSegment>;
  addSegmentMembers(externalId: string, members: SegmentMember[]): Promise<BulkJobAccepted>;
  removeSegmentMembers(externalId: string, members: SegmentMember[]): Promise<BulkJobAccepted>;
  getBulkJob(batchJobId: string): Promise<BulkJobResult>;
  getEligibility(emails: string[]): Promise<SubscriberEligibility[]>;
}

export interface AttentiveWriteConfig {
  apiKey: string;
  baseUrl?: string;
  /** Injected so tests never reach the network. */
  fetchFn?: typeof fetch;
}

/**
 * Refuses rather than truncates.
 *
 * Sending the first 10,000 of 12,232 would report success over a segment short
 * 2,232 people, and nothing downstream could tell. Splitting into batches is
 * the caller's job precisely so the caller has to account for each one.
 */
function assertSendable(members: SegmentMember[]): void {
  if (members.length === 0) {
    throw new Error(
      "Refusing to send an empty member list. A request that changes nothing would " +
        "return a batchJobId and read as a push."
    );
  }
  if (members.length > MAX_MEMBERS_PER_REQUEST) {
    throw new Error(
      `${members.length} members exceeds the API limit of ${MAX_MEMBERS_PER_REQUEST} per request. ` +
        `Split into batches and account for each one — this client will not send a partial list ` +
        `and report success.`
    );
  }
  for (const [i, m] of members.entries()) {
    if (!m.email && !m.phone && !m.clientUserId) {
      throw new Error(
        `Member at index ${i} has no identifier. Attentive needs an email, phone or clientUserId ` +
          `to match anyone; a member with none is silently unmatchable.`
      );
    }
  }
}

export function createAttentiveWriteClient(config: AttentiveWriteConfig): AttentiveWriteClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = config.fetchFn ?? fetch;

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Attentive ${init.method ?? "GET"} ${path} failed: ${res.status} ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  async function bulkMembers(
    method: "POST" | "DELETE",
    externalId: string,
    members: SegmentMember[]
  ): Promise<BulkJobAccepted> {
    assertSendable(members);
    const body = (await request("/v2/bulk/segments/members", {
      method,
      body: JSON.stringify({ externalId, members }),
    })) as { batchJobId?: string };

    if (!body.batchJobId) {
      throw new Error(
        `Attentive accepted the ${method} but returned no batchJobId, so there is nothing to ` +
          `check the outcome against. Treating as a failure rather than assuming it worked.`
      );
    }
    return { batchJobId: body.batchJobId };
  }

  /**
   * Parses the `.jsonl` result file into per-record outcomes.
   *
   * A line that will not parse counts as a failure, not as something to skip.
   * Skipping it would quietly reduce the denominator and make the success rate
   * look better than it is.
   */
  function parseResults(text: string): { succeeded: number; failed: number; failures: BulkJobFailure[] } {
    let succeeded = 0;
    let failed = 0;
    const failures: BulkJobFailure[] = [];

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;

      let parsed: { request?: SegmentMember; response?: { status?: number; message?: string } };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        failed++;
        failures.push({ identifier: "(unparseable line)", detail: trimmed.slice(0, 200) });
        continue;
      }

      const status = parsed.response?.status ?? 0;
      if (status >= 200 && status < 300) {
        succeeded++;
      } else {
        failed++;
        const req = parsed.request ?? {};
        failures.push({
          identifier: req.email ?? req.phone ?? req.clientUserId ?? "(no identifier)",
          detail: `${status} ${parsed.response?.message ?? ""}`.trim(),
        });
      }
    }

    return { succeeded, failed, failures };
  }

  return {
    async listSegments() {
      const body = (await request("/v2/segments?limit=100")) as { segments?: AttentiveSegment[] };
      return body.segments ?? [];
    },

    async createSegment(input) {
      return (await request("/v2/segments", {
        method: "POST",
        body: JSON.stringify(input),
      })) as AttentiveSegment;
    },

    addSegmentMembers: (externalId, members) => bulkMembers("POST", externalId, members),
    removeSegmentMembers: (externalId, members) => bulkMembers("DELETE", externalId, members),

    async getBulkJob(batchJobId) {
      const body = (await request(`/v2/bulk/job/${encodeURIComponent(batchJobId)}`)) as {
        status?: BulkJobStatus;
        resultUrl?: string;
      };
      const status = body.status ?? "IN_PROGRESS";

      const unknown = (problem: string | null): BulkJobResult => ({
        status,
        succeeded: null,
        failed: null,
        failures: [],
        problem,
      });

      // Nothing to read yet, and that is not a problem — it is just not done.
      if (status === "IN_PROGRESS") return unknown(null);

      if (!body.resultUrl) {
        return unknown(
          `Job reported ${status} but carried no result file, so no record was confirmed written. ` +
            `The status alone does not establish that anything succeeded.`
        );
      }

      let text: string;
      try {
        const res = await doFetch(body.resultUrl);
        if (!res.ok) {
          return unknown(
            `Job reported ${status} but its result file could not be fetched (${res.status}), ` +
              `so per-record outcomes are unknown.`
          );
        }
        text = await res.text();
      } catch (err) {
        return unknown(
          `Job reported ${status} but its result file could not be fetched (${String(err)}), ` +
            `so per-record outcomes are unknown.`
        );
      }

      const { succeeded, failed, failures } = parseResults(text);
      return {
        status,
        succeeded,
        failed,
        failures,
        problem: failed > 0 ? `${failed} of ${succeeded + failed} records were rejected.` : null,
      };
    },

    async getEligibility(emails) {
      if (emails.length === 0) return [];

      const out: SubscriberEligibility[] = [];

      for (let i = 0; i < emails.length; i += ELIGIBILITY_BATCH_SIZE) {
        const chunk = emails.slice(i, i + ELIGIBILITY_BATCH_SIZE);
        const aliases = chunk
          .map(
            (email, j) =>
              `u${j}: user(email: ${JSON.stringify(email)}) { subscriptions { ` +
              `subscriptionEligibilities { subscription { channel type } eligibility { isEligible } } } }`
          )
          .join(" ");

        const body = (await request("/v1/graphql", {
          method: "POST",
          body: JSON.stringify({
            query: `query { viewer { installedApplication { installerCompany { ${aliases} } } } }`,
          }),
        })) as {
          data?: { viewer?: { installedApplication?: { installerCompany?: Record<string, unknown> } } };
          errors?: Array<{ message?: string }>;
        };

        // A GraphQL 200 carrying errors is still a failure. Reading `data` past
        // them would treat an errored lookup as "nobody is eligible".
        if (body.errors?.length) {
          throw new Error(
            `Attentive GraphQL returned errors: ${body.errors.map((e) => e.message).join("; ")}`
          );
        }

        const company = body.data?.viewer?.installedApplication?.installerCompany ?? {};

        chunk.forEach((email, j) => {
          const user = company[`u${j}`] as
            | { subscriptions?: { subscriptionEligibilities?: Array<{ subscription?: { channel?: string; type?: string }; eligibility?: { isEligible?: boolean } }> } }
            | null
            | undefined;

          const eligibilities = user?.subscriptions?.subscriptionEligibilities ?? [];

          out.push({
            email,
            known: eligibilities.length > 0,
            // Transactional and abandoned-checkout eligibility is not
            // permission to market to someone. Only TYPE_MARKETING counts, on
            // either channel — a segment push reaches email and SMS alike.
            marketingEligible: eligibilities.some(
              (e) => e.subscription?.type === "TYPE_MARKETING" && e.eligibility?.isEligible === true
            ),
          });
        });
      }

      return out;
    },
  };
}
