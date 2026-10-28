/**
 * Where the ad account watch keeps its snapshot and its history, and what the
 * dashboard reads back.
 */

import { desc, eq, max } from "drizzle-orm";
import type { Db } from "@/db/client";
import { metaWatchObjects, metaWatchChanges, syncRuns } from "@/db/schema";
import type { WatchStore } from "./run-watch";
import {
  summarizeActive,
  type WatchedObject,
  type WatchLevel,
  type ActiveCampaignSummary,
} from "./watch";

/** Rows inserted per statement, well under Postgres's parameter limit. */
const INSERT_BATCH = 500;

export const META_WATCH_TASK = "watch:meta";

function toObject(row: typeof metaWatchObjects.$inferSelect): WatchedObject {
  return {
    level: row.level as WatchLevel,
    id: row.id,
    name: row.name,
    campaignId: row.campaignId,
    adsetId: row.adsetId,
    status: row.status,
    effectiveStatus: row.effectiveStatus,
    dailyBudgetCents: row.dailyBudgetCents,
    lifetimeBudgetCents: row.lifetimeBudgetCents,
    bidStrategy: row.bidStrategy,
    spendCapCents: row.spendCapCents,
    creativeId: row.creativeId,
    createdTime: row.createdTime,
    updatedTime: row.updatedTime,
  };
}

export function createWatchStore(db: Db): WatchStore {
  return {
    async load() {
      const rows = await db.select().from(metaWatchObjects);
      if (rows.length === 0) return null;
      const checkedAt = rows.reduce((latest, r) => (r.checkedAt > latest ? r.checkedAt : latest), rows[0].checkedAt);
      return { objects: rows.map(toObject), checkedAt };
    },

    // One transaction, so a crash between the two can neither lose the
    // history of a change nor keep a snapshot that excludes it.
    async save(objects, checkedAt, changes) {
      await db.transaction(async (tx) => {
        await tx.delete(metaWatchObjects);
        for (let i = 0; i < objects.length; i += INSERT_BATCH) {
          await tx.insert(metaWatchObjects).values(
            objects.slice(i, i + INSERT_BATCH).map((o) => ({ ...o, checkedAt })),
          );
        }
        if (changes.length > 0) {
          await tx.insert(metaWatchChanges).values(changes.map((c) => ({
            detectedAt: checkedAt,
            kind: c.kind,
            level: c.object.level,
            objectId: c.object.id,
            objectName: c.object.name,
            campaignId: c.object.campaignId,
            field: c.kind === "changed" ? c.field : null,
            before: c.kind === "changed" && c.before !== null ? String(c.before) : null,
            after: c.kind === "changed" && c.after !== null ? String(c.after) : null,
          })));
        }
      });
    },
  };
}

export interface WatchDashboard {
  /** Null before the first successful check. */
  checkedAt: Date | null;
  account: { name: string; status: string | null; spendCapCents: number | null } | null;
  campaigns: ActiveCampaignSummary[];
  totalDailyBudgetCents: number;
  /** The most recent run, which may be a failure newer than `checkedAt`. */
  lastRun: { outcome: string; finishedAt: Date; errorMessage: string | null } | null;
  recentChanges: (typeof metaWatchChanges.$inferSelect)[];
}

export async function getWatchDashboard(db: Db): Promise<WatchDashboard> {
  const [rows, [lastRun], recentChanges, [checked]] = await Promise.all([
    db.select().from(metaWatchObjects),
    db
      .select({ outcome: syncRuns.outcome, finishedAt: syncRuns.finishedAt, errorMessage: syncRuns.errorMessage })
      .from(syncRuns)
      .where(eq(syncRuns.task, META_WATCH_TASK))
      .orderBy(desc(syncRuns.finishedAt))
      .limit(1),
    db.select().from(metaWatchChanges).orderBy(desc(metaWatchChanges.detectedAt)).limit(50),
    db.select({ at: max(metaWatchObjects.checkedAt) }).from(metaWatchObjects),
  ]);
  const objects = rows.map(toObject);
  const account = objects.find((o) => o.level === "account");
  const { campaigns, totalDailyBudgetCents } = summarizeActive(objects);
  return {
    checkedAt: checked?.at ?? null,
    account: account ? { name: account.name, status: account.status, spendCapCents: account.spendCapCents } : null,
    campaigns,
    totalDailyBudgetCents,
    lastRun: lastRun ?? null,
    recentChanges,
  };
}
