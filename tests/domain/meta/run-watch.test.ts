import { describe, it, expect, vi } from "vitest";
import { runMetaWatch, type WatchStore, type Heartbeat, type MetaWatchClient } from "@/domain/meta/run-watch";
import { toWatchedObjects, type WatchSnapshotRaw } from "@/domain/meta/watch";

const NOW = new Date("2026-10-28T18:00:00Z");
const EARLIER = new Date("2026-10-28T15:00:00Z");

const raw = (over: Partial<WatchSnapshotRaw> = {}): WatchSnapshotRaw => ({
  account: { id: "act_1", name: "Rad & Happy", account_status: 1 },
  campaigns: [{ id: "c1", name: "Prospecting", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "10000", updated_time: "t1" }],
  adsets: [],
  ads: [],
  ...over,
});

function setup(opts: {
  stored?: WatchSnapshotRaw | null;
  current?: WatchSnapshotRaw | Error;
  activities?: unknown[] | Error;
  notify?: ((text: string) => Promise<void>) | null;
} = {}) {
  const store: WatchStore & { saved: unknown[] } = {
    saved: [],
    load: vi.fn(async () =>
      opts.stored === null || opts.stored === undefined
        ? null
        : { objects: toWatchedObjects(opts.stored), checkedAt: EARLIER }),
    save: vi.fn(async (...args: unknown[]) => { store.saved.push(args); }),
  };
  const heartbeat: Heartbeat & { pings: string[] } = {
    configured: true,
    pings: [],
    start: vi.fn(async () => { heartbeat.pings.push("start"); }),
    success: vi.fn(async () => { heartbeat.pings.push("success"); }),
    fail: vi.fn(async (m: string) => { heartbeat.pings.push(`fail: ${m}`); }),
  };
  const client: MetaWatchClient = {
    getWatchSnapshot: vi.fn(async () => {
      if (opts.current instanceof Error) throw opts.current;
      return opts.current ?? raw();
    }),
    getActivities: vi.fn(async () => {
      if (opts.activities instanceof Error) throw opts.activities;
      return (opts.activities ?? []) as never;
    }),
  };
  const notify = opts.notify === null ? undefined : opts.notify ?? vi.fn(async () => undefined);
  return {
    store, heartbeat, client, notify,
    run: () => runMetaWatch({ client, accountId: "act_1", store, heartbeat, notify, now: () => NOW }),
  };
}

describe("runMetaWatch", () => {
  // Nothing to compare against on the first run. Alerting on every campaign
  // in the account would teach the reader to ignore the alert.
  it("records a baseline on the first run and alerts nothing", async () => {
    const t = setup({ stored: null });
    const result = await t.run();
    expect(result.outcome).toBe("baseline");
    expect(t.notify).not.toHaveBeenCalled();
    expect(t.store.save).toHaveBeenCalledOnce();
    expect(t.heartbeat.pings).toEqual(["start", "success"]);
  });

  it("pings the heartbeat and alerts nothing when nothing changed", async () => {
    const t = setup({ stored: raw() });
    expect((await t.run()).outcome).toBe("no-changes");
    expect(t.notify).not.toHaveBeenCalled();
    expect(t.heartbeat.pings).toEqual(["start", "success"]);
  });

  it("alerts a budget change and then saves the new snapshot", async () => {
    const t = setup({
      stored: raw(),
      current: raw({ campaigns: [{ ...raw().campaigns[0], daily_budget: "90000", updated_time: "t2" }] }),
    });
    const result = await t.run();
    expect(result).toMatchObject({ outcome: "alerted", changes: 1 });
    expect(t.notify).toHaveBeenCalledWith(expect.stringContaining("$100.00 → $900.00"));
    expect(t.store.save).toHaveBeenCalledOnce();
    expect(t.heartbeat.pings).toEqual(["start", "success"]);
  });

  it("asks the activity log only about the time since the last check", async () => {
    const t = setup({ stored: raw(), current: raw({ campaigns: [] }) });
    await t.run();
    expect(t.client.getActivities).toHaveBeenCalledWith("act_1", EARLIER);
  });

  // A revoked or stripped token is the outage the heartbeat exists to report.
  it("fails the heartbeat with Meta's reason when the account cannot be read", async () => {
    const t = setup({ stored: raw(), current: new Error("(#200) Ad account owner has NOT grant ads_read") });
    await expect(t.run()).rejects.toThrow("(#200)");
    expect(t.heartbeat.pings).toEqual(["start", "fail: Could not read the ad account: (#200) Ad account owner has NOT grant ads_read"]);
    expect(t.store.save).not.toHaveBeenCalled();
  });

  // If the snapshot moved on, the change would never be reported: the next
  // run would compare against a state that already includes it.
  it("keeps the old snapshot when the alert could not be delivered, so the next run alerts again", async () => {
    const t = setup({
      stored: raw(),
      current: raw({ campaigns: [] }),
      notify: vi.fn().mockRejectedValue(new Error("channel_not_found")),
    });
    await expect(t.run()).rejects.toThrow("channel_not_found");
    expect(t.store.save).not.toHaveBeenCalled();
    expect(t.heartbeat.pings.at(-1)).toMatch(/^fail: Found 1 change\(s\) but could not post the alert: channel_not_found/);
  });

  it("fails rather than swallowing changes when there is nowhere to send them", async () => {
    const t = setup({ stored: raw(), current: raw({ campaigns: [] }), notify: null });
    await expect(t.run()).rejects.toThrow(/no Slack channel/);
    expect(t.store.save).not.toHaveBeenCalled();
    expect(t.heartbeat.pings.at(-1)).toMatch(/no Slack channel/);
  });

  // Who made a change is a nicety. Losing it must not lose the alert.
  it("still alerts when the activity log cannot be read, and says so", async () => {
    const t = setup({ stored: raw(), current: raw({ campaigns: [] }), activities: new Error("(#200) permission") });
    expect((await t.run()).outcome).toBe("alerted");
    expect(t.notify).toHaveBeenCalledWith(expect.stringMatching(/Who made these changes is unknown.*\(#200\) permission/));
  });

  it("names who made a change from the activity log", async () => {
    const t = setup({
      stored: raw(),
      current: raw({ campaigns: [{ ...raw().campaigns[0], status: "PAUSED", updated_time: "t2" }] }),
      activities: [{ objectId: "c1", actorName: "Matt", eventType: "update_campaign_run_status", eventTime: "t" }],
    });
    await t.run();
    expect(t.notify).toHaveBeenCalledWith(expect.stringContaining("by Matt"));
  });

  it("returns the active summary for the dashboard and the log line", async () => {
    const t = setup({ stored: raw() });
    expect((await t.run()).summary.campaigns).toEqual([
      expect.objectContaining({ id: "c1", dailyBudgetCents: 10000 }),
    ]);
  });
});
