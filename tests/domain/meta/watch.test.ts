import { describe, it, expect } from "vitest";
import {
  toWatchedObjects,
  diffSnapshots,
  summarizeActive,
  formatWatchAlert,
  type WatchedObject,
  type WatchSnapshotRaw,
} from "@/domain/meta/watch";

const obj = (over: Partial<WatchedObject> & Pick<WatchedObject, "level" | "id">): WatchedObject => ({
  name: `${over.level} ${over.id}`,
  campaignId: null,
  adsetId: null,
  status: "ACTIVE",
  effectiveStatus: "ACTIVE",
  dailyBudgetCents: null,
  lifetimeBudgetCents: null,
  bidStrategy: null,
  spendCapCents: null,
  creativeId: null,
  createdTime: "2026-10-01T00:00:00+0000",
  updatedTime: "2026-10-01T00:00:00+0000",
  ...over,
});

describe("toWatchedObjects", () => {
  const raw: WatchSnapshotRaw = {
    account: { id: "act_1", name: "Rad & Happy", account_status: 1, spend_cap: "500000" },
    campaigns: [{
      id: "c1", name: "Prospecting", status: "ACTIVE", effective_status: "ACTIVE",
      daily_budget: "15000", bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      created_time: "t0", updated_time: "t1",
    }],
    adsets: [{
      id: "s1", campaign_id: "c1", name: "Broad", status: "ACTIVE", effective_status: "ACTIVE",
      lifetime_budget: "90000", created_time: "t0", updated_time: "t1",
    }],
    ads: [{
      id: "a1", campaign_id: "c1", adset_id: "s1", name: "Hook 1", status: "PAUSED",
      effective_status: "PAUSED", creative: { id: "cr9" }, created_time: "t0", updated_time: "t1",
    }],
  };

  it("reads budgets as cents and keeps every level", () => {
    const objects = toWatchedObjects(raw);
    expect(objects.map((o) => `${o.level}:${o.id}`)).toEqual(["account:act_1", "campaign:c1", "adset:s1", "ad:a1"]);
    expect(objects.find((o) => o.id === "c1")).toMatchObject({ dailyBudgetCents: 15000, lifetimeBudgetCents: null });
    expect(objects.find((o) => o.id === "s1")).toMatchObject({ lifetimeBudgetCents: 90000, campaignId: "c1" });
    expect(objects.find((o) => o.id === "a1")).toMatchObject({ creativeId: "cr9", adsetId: "s1", status: "PAUSED" });
  });

  // Meta's account_status is a number. Stored as a word so a change reads as
  // "ACTIVE → DISABLED" rather than "1 → 2".
  it("names the account status and keeps its spend cap", () => {
    expect(toWatchedObjects(raw)[0]).toMatchObject({ level: "account", status: "ACTIVE", spendCapCents: 500000 });
  });

  // An unset budget and a zero budget are different things.
  it("records an absent budget as null, not zero", () => {
    expect(toWatchedObjects({ ...raw, campaigns: [{ ...raw.campaigns[0], daily_budget: undefined }] })
      .find((o) => o.id === "c1")!.dailyBudgetCents).toBeNull();
  });
});

describe("diffSnapshots", () => {
  const campaign = obj({ level: "campaign", id: "c1", dailyBudgetCents: 10000 });

  it("finds nothing when nothing changed", () => {
    expect(diffSnapshots([campaign], [{ ...campaign }])).toEqual([]);
  });

  it("reports a new campaign", () => {
    const fresh = obj({ level: "campaign", id: "c2" });
    expect(diffSnapshots([campaign], [campaign, fresh])).toEqual([{ kind: "created", object: fresh }]);
  });

  it("reports a new ad inside an existing campaign", () => {
    const ad = obj({ level: "ad", id: "a9", campaignId: "c1" });
    expect(diffSnapshots([campaign], [campaign, ad])).toEqual([{ kind: "created", object: ad }]);
  });

  it("reports something that is no longer listed", () => {
    expect(diffSnapshots([campaign], [])).toEqual([{ kind: "removed", object: campaign }]);
  });

  it("reports a budget change with both values", () => {
    const after = { ...campaign, dailyBudgetCents: 50000, updatedTime: "later" };
    expect(diffSnapshots([campaign], [after])).toEqual([
      { kind: "changed", object: after, field: "dailyBudgetCents", before: 10000, after: 50000 },
    ]);
  });

  it("reports each tracked field that changed", () => {
    const after = { ...campaign, name: "Renamed", status: "PAUSED", updatedTime: "later" };
    expect(diffSnapshots([campaign], [after]).map((c) => c.kind === "changed" && c.field)).toEqual(["name", "status"]);
  });

  // Targeting, placements and the like are not tracked field by field, but
  // Meta moves updated_time for any edit. Without this a targeting change
  // would pass unseen.
  it("reports an edit to something untracked when only updated_time moved", () => {
    const after = { ...campaign, updatedTime: "later" };
    expect(diffSnapshots([campaign], [after])).toEqual([{ kind: "edited", object: after }]);
  });

  it("reports a creative swapped on an existing ad", () => {
    const ad = obj({ level: "ad", id: "a1", creativeId: "cr1" });
    const after = { ...ad, creativeId: "cr2", updatedTime: "later" };
    expect(diffSnapshots([ad], [after])).toEqual([
      { kind: "changed", object: after, field: "creativeId", before: "cr1", after: "cr2" },
    ]);
  });

  // Delivery state is Meta's, not an edit: an ad entering review or a
  // campaign finishing its schedule would otherwise alert as tampering.
  it("ignores a change in delivery status alone", () => {
    expect(diffSnapshots([campaign], [{ ...campaign, effectiveStatus: "IN_PROCESS" }])).toEqual([]);
  });

  it("reports a change to the account's spend cap", () => {
    const account = obj({ level: "account", id: "act_1", spendCapCents: 100000, updatedTime: null });
    const after = { ...account, spendCapCents: 900000 };
    expect(diffSnapshots([account], [after])).toEqual([
      { kind: "changed", object: after, field: "spendCapCents", before: 100000, after: 900000 },
    ]);
  });
});

describe("summarizeActive", () => {
  it("counts active campaigns with their daily budget and active ads", () => {
    const summary = summarizeActive([
      obj({ level: "campaign", id: "c1", name: "CBO", dailyBudgetCents: 20000 }),
      obj({ level: "adset", id: "s1", campaignId: "c1" }),
      obj({ level: "ad", id: "a1", campaignId: "c1", adsetId: "s1" }),
      obj({ level: "ad", id: "a2", campaignId: "c1", adsetId: "s1", effectiveStatus: "PAUSED" }),
      obj({ level: "campaign", id: "c2", name: "Paused", effectiveStatus: "PAUSED", dailyBudgetCents: 5000 }),
    ]);
    expect(summary.campaigns).toEqual([
      { id: "c1", name: "CBO", dailyBudgetCents: 20000, budgetSource: "campaign", lifetimeBudgetCents: null, activeAdSets: 1, activeAds: 1 },
    ]);
    expect(summary.totalDailyBudgetCents).toBe(20000);
  });

  // Without campaign budget optimisation the budget lives on the ad sets.
  it("sums the active ad sets' budgets when the campaign has none", () => {
    const summary = summarizeActive([
      obj({ level: "campaign", id: "c1" }),
      obj({ level: "adset", id: "s1", campaignId: "c1", dailyBudgetCents: 3000 }),
      obj({ level: "adset", id: "s2", campaignId: "c1", dailyBudgetCents: 4000 }),
      obj({ level: "adset", id: "s3", campaignId: "c1", dailyBudgetCents: 9000, effectiveStatus: "PAUSED" }),
    ]);
    expect(summary.campaigns[0]).toMatchObject({ dailyBudgetCents: 7000, budgetSource: "ad sets", activeAdSets: 2 });
  });

  // A lifetime budget has no daily figure. Reporting it as $0 a day would
  // understate spend; it is named instead.
  it("says when a campaign runs on a lifetime budget only", () => {
    const summary = summarizeActive([
      obj({ level: "campaign", id: "c1", lifetimeBudgetCents: 100000 }),
      obj({ level: "adset", id: "s1", campaignId: "c1" }),
    ]);
    expect(summary.campaigns[0]).toMatchObject({ dailyBudgetCents: null, budgetSource: "lifetime only", lifetimeBudgetCents: 100000 });
    expect(summary.totalDailyBudgetCents).toBe(0);
  });
});

describe("formatWatchAlert", () => {
  const campaign = obj({ level: "campaign", id: "c1", name: "Prospecting" });

  it("states money in dollars and shows the size of a budget change", () => {
    const text = formatWatchAlert(
      [{ kind: "changed", object: campaign, field: "dailyBudgetCents", before: 10000, after: 50000 }],
      { campaignNames: new Map([["c1", "Prospecting"]]), activity: { available: true, events: [] } },
    );
    expect(text).toContain("$100.00 → $500.00");
    expect(text).toContain("+400%");
  });

  it("names the campaign a new ad was added to", () => {
    const text = formatWatchAlert(
      [{ kind: "created", object: obj({ level: "ad", id: "a9", name: "Hook 9", campaignId: "c1" }) }],
      { campaignNames: new Map([["c1", "Prospecting"]]), activity: { available: true, events: [] } },
    );
    expect(text).toMatch(/New ad.*Hook 9.*Prospecting/);
  });

  it("says who made a change when the activity log names them", () => {
    const text = formatWatchAlert(
      [{ kind: "changed", object: campaign, field: "status", before: "PAUSED", after: "ACTIVE" }],
      {
        campaignNames: new Map(),
        activity: { available: true, events: [{ objectId: "c1", actorName: "Matt", eventType: "update_campaign_run_status", eventTime: "t" }] },
      },
    );
    expect(text).toContain("by Matt");
  });

  // An unknown author must not read as no author. Fraud is exactly the case
  // where the answer matters.
  it("says plainly when it cannot tell who made the changes", () => {
    const text = formatWatchAlert(
      [{ kind: "edited", object: campaign }],
      { campaignNames: new Map(), activity: { available: false, reason: "(#200) permission" } },
    );
    expect(text).toMatch(/Who made these changes is unknown.*\(#200\) permission/);
  });

  it("caps a long list and says how many were left out", () => {
    const changes = Array.from({ length: 45 }, (_, i) => ({
      kind: "created" as const, object: obj({ level: "ad", id: `a${i}` }),
    }));
    const text = formatWatchAlert(changes, { campaignNames: new Map(), activity: { available: true, events: [] } });
    expect(text).toContain("45 changes");
    expect(text).toContain("and 15 more");
  });
});
