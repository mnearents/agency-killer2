/**
 * Meta ad account watch — notices changes nobody announced.
 *
 * The purpose is fraud: a stolen login or token is used to create a campaign,
 * add an ad to an existing one, or raise a budget. Every three hours the
 * account, campaigns, ad sets and ads are read and compared with the last
 * snapshot, and anything new, gone or edited is reported.
 *
 * Pure — no API, no database, no clock. `run-watch.ts` sequences it.
 *
 * Delivery status (`effective_status`) is deliberately not compared. It is
 * Meta's state, not an edit: an ad entering review or a schedule ending would
 * otherwise read as tampering, and an alert that cries wolf daily is ignored
 * on the day it matters.
 */

export type WatchLevel = "account" | "campaign" | "adset" | "ad";

export interface WatchedObject {
  level: WatchLevel;
  id: string;
  name: string;
  campaignId: string | null;
  adsetId: string | null;
  /** What the advertiser set: ACTIVE, PAUSED, … For the account, its account status. */
  status: string | null;
  /** What Meta is doing with it. Read for the dashboard, never diffed. */
  effectiveStatus: string | null;
  /** Meta's minor units. Null when unset — not zero. */
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
  bidStrategy: string | null;
  spendCapCents: number | null;
  creativeId: string | null;
  createdTime: string | null;
  /** Moves on any edit, including ones no field here records. Null for the account. */
  updatedTime: string | null;
}

/** The Graph API objects as fetched — see `MetaApiClient.getWatchSnapshot`. */
export interface WatchSnapshotRaw {
  account: { id: string; name?: string; account_status?: number; spend_cap?: string };
  campaigns: RawWatched[];
  adsets: RawWatched[];
  ads: RawWatched[];
}

interface RawWatched {
  id: string;
  name?: string;
  campaign_id?: string;
  adset_id?: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  spend_cap?: string;
  creative?: { id: string };
  created_time?: string;
  updated_time?: string;
}

/** Meta's numeric `account_status`, as words. */
const ACCOUNT_STATUS: Record<number, string> = {
  1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT", 9: "IN_GRACE_PERIOD", 100: "PENDING_CLOSURE",
  101: "CLOSED", 201: "ANY_ACTIVE", 202: "ANY_CLOSED",
};

function cents(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toWatchedObjects(raw: WatchSnapshotRaw): WatchedObject[] {
  const base = (level: WatchLevel, r: RawWatched): WatchedObject => ({
    level,
    id: r.id,
    name: r.name ?? "",
    campaignId: r.campaign_id ?? null,
    adsetId: r.adset_id ?? null,
    status: r.status ?? null,
    effectiveStatus: r.effective_status ?? null,
    dailyBudgetCents: cents(r.daily_budget),
    lifetimeBudgetCents: cents(r.lifetime_budget),
    bidStrategy: r.bid_strategy ?? null,
    spendCapCents: cents(r.spend_cap),
    creativeId: r.creative?.id ?? null,
    createdTime: r.created_time ?? null,
    updatedTime: r.updated_time ?? null,
  });
  const a = raw.account;
  const accountStatus = a.account_status === undefined
    ? null
    : ACCOUNT_STATUS[a.account_status] ?? String(a.account_status);
  return [
    {
      ...base("account", { id: a.id, name: a.name, spend_cap: a.spend_cap }),
      status: accountStatus,
      effectiveStatus: accountStatus,
    },
    ...raw.campaigns.map((r) => base("campaign", r)),
    ...raw.adsets.map((r) => base("adset", r)),
    ...raw.ads.map((r) => base("ad", r)),
  ];
}

type TrackedField =
  | "name" | "status" | "dailyBudgetCents" | "lifetimeBudgetCents"
  | "bidStrategy" | "spendCapCents" | "creativeId";

/** The fields compared at each level. Anything else is caught by `updatedTime`. */
const TRACKED: Record<WatchLevel, TrackedField[]> = {
  account: ["name", "status", "spendCapCents"],
  campaign: ["name", "status", "dailyBudgetCents", "lifetimeBudgetCents", "bidStrategy", "spendCapCents"],
  adset: ["name", "status", "dailyBudgetCents", "lifetimeBudgetCents", "bidStrategy"],
  ad: ["name", "status", "creativeId"],
};

export type WatchChange =
  | { kind: "created"; object: WatchedObject }
  | { kind: "removed"; object: WatchedObject }
  | { kind: "changed"; object: WatchedObject; field: TrackedField; before: string | number | null; after: string | number | null }
  /** `updated_time` moved but no tracked field changed — targeting, placements, schedule, … */
  | { kind: "edited"; object: WatchedObject };

const keyOf = (o: WatchedObject) => `${o.level}:${o.id}`;

export function diffSnapshots(before: WatchedObject[], after: WatchedObject[]): WatchChange[] {
  const previous = new Map(before.map((o) => [keyOf(o), o]));
  const current = new Set(after.map(keyOf));
  const changes: WatchChange[] = [];

  for (const now of after) {
    const was = previous.get(keyOf(now));
    if (!was) {
      changes.push({ kind: "created", object: now });
      continue;
    }
    const fieldChanges: WatchChange[] = TRACKED[now.level]
      .filter((field) => was[field] !== now[field])
      .map((field) => ({ kind: "changed", object: now, field, before: was[field], after: now[field] }));
    if (fieldChanges.length > 0) changes.push(...fieldChanges);
    else if (was.updatedTime !== now.updatedTime) changes.push({ kind: "edited", object: now });
  }
  for (const was of before) {
    if (!current.has(keyOf(was))) changes.push({ kind: "removed", object: was });
  }
  return changes;
}

export interface ActiveCampaignSummary {
  id: string;
  name: string;
  /** Null when the campaign spends against a lifetime budget only. */
  dailyBudgetCents: number | null;
  budgetSource: "campaign" | "ad sets" | "lifetime only" | "none";
  lifetimeBudgetCents: number | null;
  activeAdSets: number;
  activeAds: number;
}

/**
 * Active campaigns with their daily budget and how many ads are running.
 *
 * With campaign budget optimisation the budget is on the campaign; without it,
 * on each ad set, so the campaign's figure is the sum of its active ad sets.
 * Lifetime budgets have no daily figure and are named rather than counted as
 * $0, which would understate what the account can spend.
 */
export function summarizeActive(objects: WatchedObject[]): {
  campaigns: ActiveCampaignSummary[];
  totalDailyBudgetCents: number;
} {
  const active = (o: WatchedObject) => o.effectiveStatus === "ACTIVE";
  const adsets = objects.filter((o) => o.level === "adset" && active(o));
  const ads = objects.filter((o) => o.level === "ad" && active(o));

  const campaigns = objects
    .filter((o) => o.level === "campaign" && active(o))
    .map((c): ActiveCampaignSummary => {
      const own = adsets.filter((s) => s.campaignId === c.id);
      const adSetDaily = own.reduce((sum, s) => sum + (s.dailyBudgetCents ?? 0), 0);
      const hasAdSetDaily = own.some((s) => s.dailyBudgetCents !== null);
      const lifetime = c.lifetimeBudgetCents ??
        (own.some((s) => s.lifetimeBudgetCents !== null)
          ? own.reduce((sum, s) => sum + (s.lifetimeBudgetCents ?? 0), 0)
          : null);
      const [dailyBudgetCents, budgetSource]: [number | null, ActiveCampaignSummary["budgetSource"]] =
        c.dailyBudgetCents !== null ? [c.dailyBudgetCents, "campaign"]
        : hasAdSetDaily ? [adSetDaily, "ad sets"]
        : lifetime !== null ? [null, "lifetime only"]
        : [null, "none"];
      return {
        id: c.id,
        name: c.name,
        dailyBudgetCents,
        budgetSource,
        lifetimeBudgetCents: lifetime,
        activeAdSets: own.length,
        activeAds: ads.filter((a) => a.campaignId === c.id).length,
      };
    })
    .sort((a, b) => (b.dailyBudgetCents ?? 0) - (a.dailyBudgetCents ?? 0) || a.name.localeCompare(b.name));

  return {
    campaigns,
    totalDailyBudgetCents: campaigns.reduce((sum, c) => sum + (c.dailyBudgetCents ?? 0), 0),
  };
}

export interface ActivityEvent {
  objectId: string | null;
  actorName: string | null;
  eventType: string;
  eventTime: string;
}

/** Meta's activity log for the window, or why it could not be read. */
export type ActivityLookup =
  | { available: true; events: ActivityEvent[] }
  | { available: false; reason: string };

const LEVEL_LABEL: Record<WatchLevel, string> = {
  account: "ad account", campaign: "campaign", adset: "ad set", ad: "ad",
};

const FIELD_LABEL: Record<TrackedField, string> = {
  name: "name", status: "status", dailyBudgetCents: "daily budget",
  lifetimeBudgetCents: "lifetime budget", bidStrategy: "bid strategy",
  spendCapCents: "spend cap", creativeId: "creative",
};

const MONEY_FIELDS = new Set<TrackedField>(["dailyBudgetCents", "lifetimeBudgetCents", "spendCapCents"]);

const dollars = (c: number | string | null) =>
  c === null ? "none" : `$${(Number(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Lines shown before the rest are summarised as a count. */
const MAX_LINES = 30;

/**
 * The Slack alert. New things first, then money, then everything else — the
 * order a fraud check reads in.
 */
export function formatWatchAlert(
  changes: WatchChange[],
  context: { campaignNames: Map<string, string>; activity: ActivityLookup },
): string {
  const rank = (c: WatchChange) =>
    c.kind === "created" ? 0
    : c.kind === "changed" && MONEY_FIELDS.has(c.field) ? 1
    : c.kind === "changed" && c.field === "status" ? 2
    : 3;
  const ordered = [...changes].sort((a, b) => rank(a) - rank(b));

  const actorFor = (id: string) =>
    context.activity.available
      ? context.activity.events.find((e) => e.objectId === id && e.actorName)?.actorName ?? null
      : null;

  const describe = (c: WatchChange): string => {
    const o = c.object;
    const label = LEVEL_LABEL[o.level];
    const inCampaign = o.level !== "campaign" && o.level !== "account" && o.campaignId
      ? ` in campaign "${context.campaignNames.get(o.campaignId) ?? o.campaignId}"`
      : "";
    const who = actorFor(o.id);
    const by = who ? ` — by ${who}` : "";
    switch (c.kind) {
      case "created":
        return `• New ${label}: "${o.name}"${inCampaign}${by}`;
      case "removed":
        return `• ${label[0].toUpperCase()}${label.slice(1)} no longer listed (deleted or archived): "${o.name}"${inCampaign}${by}`;
      case "edited":
        return `• Edited ${label} "${o.name}"${inCampaign} — a setting not tracked here (targeting, placements, schedule…)${by}`;
      case "changed": {
        if (MONEY_FIELDS.has(c.field)) {
          const pct = typeof c.before === "number" && typeof c.after === "number" && c.before > 0
            ? ` (${c.after >= c.before ? "+" : ""}${Math.round(((c.after - c.before) / c.before) * 100)}%)`
            : "";
          return `• ${FIELD_LABEL[c.field][0].toUpperCase()}${FIELD_LABEL[c.field].slice(1)} of ${label} "${o.name}"${inCampaign}: ${dollars(c.before)} → ${dollars(c.after)}${pct}${by}`;
        }
        return `• ${FIELD_LABEL[c.field][0].toUpperCase()}${FIELD_LABEL[c.field].slice(1)} of ${label} "${o.name}"${inCampaign}: ${c.before ?? "none"} → ${c.after ?? "none"}${by}`;
      }
    }
  };

  const lines = ordered.slice(0, MAX_LINES).map(describe);
  if (ordered.length > MAX_LINES) lines.push(`…and ${ordered.length - MAX_LINES} more`);

  const footer = context.activity.available
    ? "If you did not make these changes, check Meta Business Settings → People and Ads Manager now."
    : `Who made these changes is unknown: the activity log could not be read (${context.activity.reason}). If you did not make them, check Meta Business Settings → People and Ads Manager now.`;

  return `*Meta ad account: ${changes.length} change${changes.length === 1 ? "" : "s"} since the last check*\n${lines.join("\n")}\n\n${footer}`;
}
