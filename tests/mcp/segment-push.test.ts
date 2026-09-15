/**
 * The segment push tools — the only place this system changes something in a
 * live sending platform.
 *
 * Getting a segment wrong here does not produce a bad number on a dashboard.
 * It sends real messages to real customers, or fails to send ones we believe
 * went out. So the guarantees are structural rather than procedural:
 *
 * - **The dry run never writes to Attentive.** Asserted by the client mock, not
 *   by reading the code.
 * - **The push re-derives the plan.** It takes a segment id and a token, never
 *   a list of addresses — otherwise every check here would be advisory, since
 *   the caller could pass a different list.
 * - **A token that no longer matches refuses.** The data moved underneath the
 *   approval, so the human approved a diff that is no longer the diff.
 * - **A blocked plan cannot be pushed**, and a dry run that could not be
 *   computed is a blocker rather than an empty result.
 * - **No cron can reach any of this**, because `src/worker/` imports nothing
 *   from `src/mcp/` and the worker does not hold the API key.
 * - **The address list never reaches the model.** Counts and a short sample
 *   only; twelve thousand addresses are not something to hand back.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpArgumentError } from "@/mcp/args";
import { ALL_TOOLS, dispatchTool, findTool, type McpToolContext } from "@/mcp/tools";
import { createMockAttentiveWriteClient, makeBulkJobResult } from "../mocks/attentive-write";
import * as segmentQueries from "@/domain/segments/queries";
import * as shopifySegments from "@/domain/shopify/segments";

vi.mock("@/domain/segments/queries", () => ({
  getSegmentMembers: vi.fn(),
  getLastRealPush: vi.fn(),
  recordPush: vi.fn().mockResolvedValue(undefined),
  getPushHistory: vi.fn().mockResolvedValue([]),
}));

const NOW = new Date("2026-09-15T12:00:00Z");
const SEGMENT = "rad_subscribers_lapsed";

let attentive: ReturnType<typeof createMockAttentiveWriteClient>;
let ctx: McpToolContext;

function seed(opts: {
  current?: string[];
  membershipError?: string | null;
  lastPushed?: string[] | null;
} = {}) {
  vi.mocked(segmentQueries.getSegmentMembers).mockResolvedValue({
    emails: opts.current ?? ["a@x.com", "b@x.com"],
    matched: (opts.current ?? ["a@x.com", "b@x.com"]).length,
    error: opts.membershipError ?? null,
  });
  vi.mocked(segmentQueries.getLastRealPush).mockResolvedValue(
    opts.lastPushed === undefined || opts.lastPushed === null
      ? null
      : { id: "p1", planToken: "old", members: opts.lastPushed, createdAt: NOW }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  attentive = createMockAttentiveWriteClient();
  ctx = { db: {} as never, now: () => NOW, attentive };
  seed();
});

const dryRun = (args: Record<string, unknown> = {}) =>
  dispatchTool(ctx, "segment_push_dry_run", { segmentId: SEGMENT, ...args }) as Promise<
    Record<string, unknown>
  >;

describe("the tools exist and are shaped correctly", () => {
  it("registers all three", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(names).toContain("segment_push_dry_run");
    expect(names).toContain("segment_push");
    expect(names).toContain("segment_push_history");
  });

  it("marks the dry run and the history read-only, and the push not", () => {
    expect(findTool("segment_push_dry_run")?.readOnly).toBe(true);
    expect(findTool("segment_push_history")?.readOnly).toBe(true);
    expect(findTool("segment_push")?.readOnly).toBe(false);
  });

  /**
   * The "no cron may push, ever" requirement, satisfied by construction rather
   * than by a test asserting a negative about the scheduler. The worker
   * process that runs every cron cannot import these tools at all.
   */
  it("is unreachable from the worker, which imports nothing from src/mcp", () => {
    const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");
    expect(worker).not.toMatch(/@\/mcp\//);
    expect(worker).not.toMatch(/segment_push/);
  });
});

describe("segment_push_dry_run", () => {
  it("reports the diff without touching Attentive", async () => {
    seed({ current: ["a@x.com", "c@x.com"], lastPushed: ["a@x.com", "b@x.com"] });
    const r = await dryRun();

    expect(r).toMatchObject({ added: 1, removed: 1, unchanged: 1, canPush: true });
    expect(attentive.addSegmentMembers).not.toHaveBeenCalled();
    expect(attentive.removeSegmentMembers).not.toHaveBeenCalled();
    expect(attentive.createSegment).not.toHaveBeenCalled();
  });

  it("returns a token the push will require", async () => {
    expect(await dryRun()).toMatchObject({ planToken: expect.stringMatching(/^[a-f0-9]{12}$/) });
  });

  /**
   * Twelve thousand addresses are not something to hand a model. Counts and a
   * short sample are enough to decide, and the full list only ever moves from
   * Postgres to Attentive inside the push.
   */
  it("never returns the full address list", async () => {
    seed({ current: Array.from({ length: 500 }, (_, i) => `p${i}@x.com`), lastPushed: null });
    const r = await dryRun();
    const serialised = JSON.stringify(r);
    expect(r.added).toBe(500);
    expect((r.sampleOfAdds as string[]).length).toBeLessThanOrEqual(5);
    expect(serialised.length).toBeLessThan(2000);
  });

  it("says a first push is a first push", async () => {
    seed({ lastPushed: null });
    expect(await dryRun()).toMatchObject({ isFirstPush: true });
  });

  it("blocks and explains when the membership query failed", async () => {
    seed({ current: [], membershipError: "connection reset" });
    const r = await dryRun();
    expect(r.canPush).toBe(false);
    expect((r.blockers as string[]).join(" ")).toMatch(/connection reset/);
  });

  it("blocks a change that would empty a populated segment", async () => {
    seed({ current: [], lastPushed: ["a@x.com", "b@x.com"] });
    const r = await dryRun();
    expect(r.canPush).toBe(false);
    expect((r.blockers as string[]).join(" ")).toMatch(/empt/i);
  });

  it("measures reachability when asked, and reports it as measured", async () => {
    seed({ current: ["a@x.com", "b@x.com"], lastPushed: null });
    attentive.getEligibility = vi.fn().mockResolvedValue([
      { email: "a@x.com", known: true, marketingEligible: true },
      { email: "b@x.com", known: true, marketingEligible: false },
    ]);
    const r = await dryRun({ checkReachability: true });
    expect(r.reachability).toMatchObject({ checked: 2, marketingEligible: 1 });
  });

  // Unmeasured must read as unmeasured. Zero reachable is a claim.
  it("reports reachability as null when it was not measured", async () => {
    expect((await dryRun()).reachability).toBeNull();
    expect(attentive.getEligibility).not.toHaveBeenCalled();
  });

  it("records the dry run in the history without storing membership", async () => {
    await dryRun();
    const [, recorded] = vi.mocked(segmentQueries.recordPush).mock.calls[0];
    expect(recorded.dryRun).toBe(true);
    expect(recorded.members).toEqual([]);
  });

  it("refuses a segment id that is not a defined segment", async () => {
    await expect(dryRun({ segmentId: "not_a_segment" })).rejects.toBeInstanceOf(McpArgumentError);
  });
});

describe("segment_push", () => {
  const push = (args: Record<string, unknown>) =>
    dispatchTool(ctx, "segment_push", {
      segmentId: SEGMENT,
      pushedBy: "Matt",
      ...args,
    }) as Promise<Record<string, unknown>>;

  async function tokenFor(opts: Parameters<typeof seed>[0] = {}) {
    seed(opts);
    return (await dryRun()).planToken as string;
  }

  it("pushes the adds and removes the plan computed", async () => {
    const token = await tokenFor({ current: ["a@x.com", "c@x.com"], lastPushed: ["a@x.com", "b@x.com"] });
    attentive.getBulkJob = vi
      .fn()
      .mockResolvedValue(makeBulkJobResult({ status: "COMPLETED", succeeded: 1, failed: 0 }));

    const r = await push({ planToken: token });

    expect(attentive.addSegmentMembers).toHaveBeenCalledWith(SEGMENT, [{ email: "c@x.com" }]);
    expect(attentive.removeSegmentMembers).toHaveBeenCalledWith(SEGMENT, [{ email: "b@x.com" }]);
    expect(r.pushed).toBe(true);
  });

  /**
   * The approval is of a specific diff. If the data moved since the dry run,
   * the human approved something that is no longer what would happen.
   */
  it("refuses a token that no longer matches the current diff", async () => {
    const token = await tokenFor({ current: ["a@x.com"], lastPushed: null });
    seed({ current: ["a@x.com", "surprise@x.com"], lastPushed: null });

    const r = await push({ planToken: token });
    expect(r.pushed).toBe(false);
    expect(r.error).toMatch(/changed|stale|fresh dry run/i);
    expect(attentive.addSegmentMembers).not.toHaveBeenCalled();
  });

  it("refuses a token that was never issued", async () => {
    const r = await push({ planToken: "000000000000" });
    expect(r.pushed).toBe(false);
    expect(attentive.addSegmentMembers).not.toHaveBeenCalled();
  });

  it("requires a token at all", async () => {
    await expect(push({})).rejects.toBeInstanceOf(McpArgumentError);
  });

  it("refuses to push a blocked plan even with a matching token", async () => {
    const token = await tokenFor({ current: [], membershipError: "boom" });
    const r = await push({ planToken: token });
    expect(r.pushed).toBe(false);
    expect(attentive.addSegmentMembers).not.toHaveBeenCalled();
  });

  // Approving, like shipping a draft, is a human act this tool records.
  it.each(["claude", "Claude", "system", "agent"])(
    "refuses a push attributed to %o",
    async (pushedBy) => {
      const token = await tokenFor();
      await expect(push({ planToken: token, pushedBy })).rejects.toBeInstanceOf(McpArgumentError);
      expect(attentive.addSegmentMembers).not.toHaveBeenCalled();
    }
  );

  it("requires pushedBy rather than defaulting it", async () => {
    const token = await tokenFor();
    await expect(
      dispatchTool(ctx, "segment_push", { segmentId: SEGMENT, planToken: token })
    ).rejects.toBeInstanceOf(McpArgumentError);
  });

  /**
   * The API's COMPLETED status says nothing about individual records. A push
   * that reports success on the strength of it has established nothing.
   */
  it("reports per-record outcomes rather than the job status", async () => {
    const token = await tokenFor({ current: ["a@x.com", "b@x.com"], lastPushed: null });
    attentive.getBulkJob = vi.fn().mockResolvedValue(
      makeBulkJobResult({
        status: "COMPLETED",
        succeeded: 1,
        failed: 1,
        failures: [{ identifier: "b@x.com", detail: "422 invalid" }],
        problem: "1 of 2 records were rejected.",
      })
    );
    const r = await push({ planToken: token });
    expect(r).toMatchObject({ recordsSucceeded: 1, recordsFailed: 1 });
    expect(r.problem).toMatch(/rejected/);
  });

  it("does not claim success when the job outcome could not be established", async () => {
    const token = await tokenFor({ current: ["a@x.com"], lastPushed: null });
    attentive.getBulkJob = vi.fn().mockResolvedValue(
      makeBulkJobResult({ status: "COMPLETED", succeeded: null, failed: null, problem: "no result file" })
    );
    const r = await push({ planToken: token });
    expect(r.recordsSucceeded).toBeNull();
    expect(r.problem).toMatch(/no result file/i);
  });

  it("records the push with the membership it actually sent", async () => {
    const token = await tokenFor({ current: ["a@x.com", "b@x.com"], lastPushed: null });
    await push({ planToken: token });
    const [, recorded] = vi.mocked(segmentQueries.recordPush).mock.calls.at(-1)!;
    expect(recorded.dryRun).toBe(false);
    expect(recorded.members).toEqual(["a@x.com", "b@x.com"]);
    expect(recorded.pushedBy).toBe("Matt");
  });

  it("reports the client being unavailable instead of quietly doing nothing", async () => {
    const token = await tokenFor();
    const noClient: McpToolContext = { db: {} as never, now: () => NOW };
    const r = (await dispatchTool(noClient, "segment_push", {
      segmentId: SEGMENT,
      planToken: token,
      pushedBy: "Matt",
    })) as Record<string, unknown>;
    expect(r.pushed).toBe(false);
    expect(r.error).toMatch(/ATTENTIVE_API_KEY/);
  });
});

/**
 * The client has to be constructed and handed to the server, or every push
 * reports "ATTENTIVE_API_KEY is not set" forever while the key sits in the
 * config file.
 *
 * `createAttentiveWriteClient` defined, tested and called from nowhere is the
 * failure this repo has produced nine times, and a caller-less client is
 * indistinguishable from an unset key from the outside — both say unavailable.
 * So the entry point is asserted, not just the tool's behaviour.
 */
describe("the Attentive client is constructed at the entry point", () => {
  const entry = readFileSync(join(process.cwd(), "src/mcp/index.ts"), "utf-8");

  it("builds a client from ATTENTIVE_API_KEY", () => {
    expect(entry).toMatch(/createAttentiveWriteClient\s*\(\s*\{\s*apiKey/);
    expect(entry).toMatch(/process\.env\.ATTENTIVE_API_KEY/);
  });

  it("passes it into the server as `attentive`, where the tools read it", () => {
    const call = entry.match(/createMcpServer\(\{[\s\S]{0,600}?\}\)/);
    expect(call, "no createMcpServer({...}) call found").not.toBeNull();
    expect(call![0]).toMatch(/attentive:/);
  });

  // An unset key is a supported state, but a silent one is not — it would be
  // indistinguishable from a client that was never wired.
  it("says so on stderr when the key is missing, rather than starting quietly", () => {
    expect(entry).toMatch(/ATTENTIVE_API_KEY not set/);
  });
});
