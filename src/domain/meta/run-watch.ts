/**
 * One pass of the Meta ad account watch: read, compare, alert, remember.
 *
 * The heartbeat is pinged on every outcome — success when the account was read
 * and anything found was reported, failure with the reason otherwise. A
 * revoked token, an account the token can no longer see, or an alert with
 * nowhere to go all fail it, and healthchecks.io says so. A worker that is not
 * running at all pings nothing, which healthchecks.io also reports.
 *
 * The snapshot only moves forward once an alert is delivered. Saving first
 * would make an undelivered change permanent: the next run would compare
 * against a state that already contains it and find nothing.
 */

import {
  toWatchedObjects,
  diffSnapshots,
  summarizeActive,
  formatWatchAlert,
  type WatchedObject,
  type WatchChange,
  type WatchSnapshotRaw,
  type ActivityEvent,
  type ActivityLookup,
  type ActiveCampaignSummary,
} from "./watch";

export interface MetaWatchClient {
  getWatchSnapshot(accountId: string): Promise<WatchSnapshotRaw>;
  getActivities(accountId: string, since: Date): Promise<ActivityEvent[]>;
}

export interface WatchStore {
  /** The last snapshot and when it was taken, or null before the first run. */
  load(): Promise<{ objects: WatchedObject[]; checkedAt: Date } | null>;
  /** Replaces the snapshot and appends the changes, together. */
  save(objects: WatchedObject[], checkedAt: Date, changes: WatchChange[]): Promise<void>;
}

/** healthchecks.io, or nothing. Pings never throw; a failed ping is logged. */
export interface Heartbeat {
  configured: boolean;
  start(): Promise<void>;
  success(): Promise<void>;
  fail(message: string): Promise<void>;
}

export interface MetaWatchResult {
  outcome: "baseline" | "no-changes" | "alerted";
  changes: number;
  /** The account, campaigns, ad sets and ads read — never zero on success. */
  objects: number;
  summary: { campaigns: ActiveCampaignSummary[]; totalDailyBudgetCents: number };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runMetaWatch(deps: {
  client: MetaWatchClient;
  accountId: string;
  store: WatchStore;
  heartbeat: Heartbeat;
  /** Posts the alert. Absent when no Slack channel is configured. */
  notify?: (text: string) => Promise<void>;
  now: () => Date;
}): Promise<MetaWatchResult> {
  const { client, accountId, store, heartbeat } = deps;
  await heartbeat.start();
  const checkedAt = deps.now();

  let objects: WatchedObject[];
  try {
    objects = toWatchedObjects(await client.getWatchSnapshot(accountId));
  } catch (err) {
    await heartbeat.fail(`Could not read the ad account: ${message(err)}`);
    throw err;
  }
  const summary = summarizeActive(objects);

  const previous = await store.load();
  if (!previous) {
    await store.save(objects, checkedAt, []);
    await heartbeat.success();
    return { outcome: "baseline", changes: 0, objects: objects.length, summary };
  }

  const changes = diffSnapshots(previous.objects, objects);
  if (changes.length === 0) {
    await store.save(objects, checkedAt, []);
    await heartbeat.success();
    return { outcome: "no-changes", changes: 0, objects: objects.length, summary };
  }

  if (!deps.notify) {
    const reason = `Found ${changes.length} change(s) but there is no Slack channel to report them to — set META_WATCH_SLACK_CHANNEL or SLACK_REPORT_CHANNEL`;
    await heartbeat.fail(reason);
    throw new Error(reason);
  }

  let activity: ActivityLookup;
  try {
    activity = { available: true, events: await client.getActivities(accountId, previous.checkedAt) };
  } catch (err) {
    activity = { available: false, reason: message(err) };
  }

  // Names for the campaigns of new or changed ads, including campaigns that
  // were themselves just removed.
  const campaignNames = new Map(
    [...previous.objects, ...objects].filter((o) => o.level === "campaign").map((o) => [o.id, o.name]),
  );

  try {
    await deps.notify(formatWatchAlert(changes, { campaignNames, activity }));
  } catch (err) {
    await heartbeat.fail(`Found ${changes.length} change(s) but could not post the alert: ${message(err)}`);
    throw err;
  }

  try {
    await store.save(objects, checkedAt, changes);
  } catch (err) {
    await heartbeat.fail(`Alerted ${changes.length} change(s) but could not save the snapshot, so they will be alerted again: ${message(err)}`);
    throw err;
  }
  await heartbeat.success();
  return { outcome: "alerted", changes: changes.length, objects: objects.length, summary };
}
