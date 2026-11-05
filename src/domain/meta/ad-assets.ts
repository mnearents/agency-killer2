/**
 * The ad asset registry: what each ad IS, beside how it performed.
 *
 * Meta knows an ad's spend and its creative's headline. It does not know that
 * the ad came from Arcads rather than a cut of the October shoot, which
 * concept it tests or which hook it opens on — and those are the variables
 * the business is choosing between. A registry row records them once, keyed
 * by the Meta ad it ran as, and `ads_creative_performance` rolls results up
 * by source, format and hook.
 *
 * Matched by Meta ad ID when one is recorded, else by ad name ignoring case
 * and spacing — the name is what a person knows when they register an ad.
 */

import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { adAssets } from "@/db/schema";

export const AD_SOURCES = ["footage_cut", "arcads", "creatify", "other"] as const;
export type AdSource = (typeof AD_SOURCES)[number];

export type AdAsset = typeof adAssets.$inferSelect;

export function normaliseAdName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Each Meta ad's registry entry, by ad ID. Unregistered ads are absent. */
export function matchAssets(ads: { adId: string; adName: string | null }[], assets: AdAsset[]): Map<string, AdAsset> {
  const byId = new Map(assets.filter((a) => a.metaAdId).map((a) => [a.metaAdId!, a]));
  const byName = new Map(assets.filter((a) => a.metaAdName).map((a) => [normaliseAdName(a.metaAdName!), a]));
  const out = new Map<string, AdAsset>();
  for (const ad of ads) {
    const hit = byId.get(ad.adId) ?? (ad.adName ? byName.get(normaliseAdName(ad.adName)) : undefined);
    if (hit) out.set(ad.adId, hit);
  }
  return out;
}

export interface RollUpRow {
  adId: string;
  /** Null for an ad with no registry entry. */
  key: string | null;
  spendCents: number;
  purchases: number;
  purchaseValueCents: number;
}

/** Totals per key, highest spend first; unregistered ads grouped and named as such. */
export function rollUp(rows: RollUpRow[]) {
  const groups = new Map<string, { ads: Set<string>; spend: number; purchases: number; value: number }>();
  for (const r of rows) {
    const key = r.key ?? "(unregistered)";
    const g = groups.get(key) ?? { ads: new Set(), spend: 0, purchases: 0, value: 0 };
    g.ads.add(r.adId);
    g.spend += r.spendCents;
    g.purchases += r.purchases;
    g.value += r.purchaseValueCents;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      ads: g.ads.size,
      spendDollars: g.spend / 100,
      purchases: g.purchases,
      revenueDollars: g.value / 100,
      roas: g.spend === 0 ? null : Math.round((g.value / g.spend) * 100) / 100,
      cpaDollars: g.purchases === 0 ? null : Math.round(g.spend / g.purchases) / 100,
    }))
    .sort((a, b) => (a.key === "(unregistered)" ? 1 : b.key === "(unregistered)" ? -1 : b.spendDollars - a.spendDollars));
}

export async function listAdAssets(db: Db): Promise<AdAsset[]> {
  return db.select().from(adAssets).orderBy(desc(adAssets.updatedAt));
}

export async function getAdAsset(db: Db, id: string): Promise<AdAsset | null> {
  const [row] = await db.select().from(adAssets).where(eq(adAssets.id, id)).limit(1);
  return row ?? null;
}

export async function saveAdAsset(db: Db, row: typeof adAssets.$inferInsert & { id?: string }): Promise<AdAsset> {
  if (row.id) {
    const [updated] = await db.update(adAssets).set({ ...row, updatedAt: new Date() }).where(eq(adAssets.id, row.id)).returning();
    return updated;
  }
  const [created] = await db.insert(adAssets).values(row).returning();
  return created;
}
