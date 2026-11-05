/**
 * Product strategy: what each product is for, recorded beside what it sells.
 *
 * Sales numbers say what happened. They cannot say that the Friendship
 * Journal is not meant to grow, so the brief pitched content for it. A role
 * is a decision a person made, and it is read beside the numbers rather than
 * inferred from them.
 *
 * Stored append-only (`product_strategy`): every change is a new row carrying
 * the whole strategy, so the newest row is the current one and the table is
 * its own history.
 */

import { sql, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { productStrategy, shopifyProducts } from "@/db/schema";

export const PRODUCT_ROLES = ["hero", "grow", "seasonal", "maintain", "clearance", "gift_with_purchase", "sunset"] as const;
export const PRODUCT_AUDIENCES = [
  "teachers", "homeschool", "parents", "kids", "adults_who_color", "planner_users", "gift_buyers",
] as const;

export interface StrategyFields {
  role: string | null;
  audiences: string[];
  seasonStartMonth: number | null;
  seasonEndMonth: number | null;
  priorityRank: number | null;
  notes: string | null;
}

export const CLEARABLE = ["role", "audiences", "seasonStartMonth", "seasonEndMonth", "priorityRank", "notes"] as const;
export type ClearableField = (typeof CLEARABLE)[number];

export interface StrategyChange {
  role?: string;
  audiences?: string[];
  seasonStartMonth?: number;
  seasonEndMonth?: number;
  priorityRank?: number;
  notes?: string;
  clear?: ClearableField[];
}

export const EMPTY_STRATEGY: StrategyFields = {
  role: null, audiences: [], seasonStartMonth: null, seasonEndMonth: null, priorityRank: null, notes: null,
};

/**
 * The whole strategy after a change. Fields the change does not name are
 * carried forward — setting a role must not wipe the audiences.
 */
export function mergeStrategy(current: StrategyFields | null, change: StrategyChange): StrategyFields {
  const base = current ?? EMPTY_STRATEGY;
  if (change.role !== undefined && !(PRODUCT_ROLES as readonly string[]).includes(change.role)) {
    throw new Error(`role must be one of ${PRODUCT_ROLES.join(", ")}; got "${change.role}"`);
  }

  const next: StrategyFields = {
    role: change.role ?? base.role,
    audiences: change.audiences ?? base.audiences,
    seasonStartMonth: change.seasonStartMonth ?? base.seasonStartMonth,
    seasonEndMonth: change.seasonEndMonth ?? base.seasonEndMonth,
    priorityRank: change.priorityRank ?? base.priorityRank,
    notes: change.notes ?? base.notes,
  };
  for (const field of change.clear ?? []) {
    (next as unknown as Record<string, unknown>)[field] = field === "audiences" ? [] : null;
  }

  if ((next.seasonStartMonth === null) !== (next.seasonEndMonth === null)) {
    throw new Error("A season needs both seasonStartMonth and seasonEndMonth (1-12); a window may wrap the year, e.g. 11 to 1.");
  }
  if (JSON.stringify(next) === JSON.stringify(base) && current !== null) {
    throw new Error("This change changes nothing: every field already has that value.");
  }
  return next;
}

export function parseAudiences(csv: string): string[] {
  const out: string[] = [];
  for (const raw of csv.split(",")) {
    const a = raw.trim().toLowerCase();
    if (a === "") continue;
    if (!(PRODUCT_AUDIENCES as readonly string[]).includes(a)) {
      throw new Error(`Unknown audience "${a}": must be one of ${PRODUCT_AUDIENCES.join(", ")}`);
    }
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** Null when no season is set: "all year" and "not decided" are not the same as in season. */
export function isInSeason(s: Pick<StrategyFields, "seasonStartMonth" | "seasonEndMonth">, month: number): boolean | null {
  if (s.seasonStartMonth === null || s.seasonEndMonth === null) return null;
  return s.seasonStartMonth <= s.seasonEndMonth
    ? month >= s.seasonStartMonth && month <= s.seasonEndMonth
    : month >= s.seasonStartMonth || month <= s.seasonEndMonth;
}

export interface CurrentStrategy extends StrategyFields {
  productId: string;
  author: string;
  requestedBy: string | null;
  setAt: Date;
}

const toFields = (r: typeof productStrategy.$inferSelect): CurrentStrategy => ({
  productId: r.productId,
  role: r.role,
  audiences: r.audiences ?? [],
  seasonStartMonth: r.seasonStartMonth,
  seasonEndMonth: r.seasonEndMonth,
  priorityRank: r.priorityRank,
  notes: r.notes,
  author: r.author,
  requestedBy: r.requestedBy,
  setAt: r.createdAt,
});

/** The newest strategy row per product. Products never set are absent. */
export async function getCurrentStrategies(db: Db): Promise<Map<string, CurrentStrategy>> {
  const rows = (await db.execute(sql`
    select distinct on (product_id)
      id, product_id as "productId", role, audiences,
      season_start_month as "seasonStartMonth", season_end_month as "seasonEndMonth",
      priority_rank as "priorityRank", notes, author, requested_by as "requestedBy", created_at as "createdAt"
    from ${productStrategy}
    order by product_id, created_at desc, id desc`)) as unknown as (typeof productStrategy.$inferSelect)[];
  return new Map(rows.map((r) => [r.productId, toFields({ ...r, createdAt: new Date(r.createdAt) })]));
}

export async function getStrategyHistory(db: Db, productId: string): Promise<CurrentStrategy[]> {
  const rows = await db
    .select()
    .from(productStrategy)
    .where(eq(productStrategy.productId, productId))
    .orderBy(desc(productStrategy.createdAt), desc(productStrategy.id));
  return rows.map(toFields);
}

export async function recordStrategy(
  db: Db,
  productId: string,
  fields: StrategyFields,
  who: { author: string; requestedBy: string | null },
): Promise<CurrentStrategy> {
  const [row] = await db.insert(productStrategy).values({ productId, ...fields, ...who }).returning();
  return toFields(row);
}

/** Products by GID or handle, for the strategy tools to resolve what they were given. */
export async function findProductsByRef(db: Db, ref: { id?: string; handle?: string }) {
  return db
    .select({ id: shopifyProducts.id, title: shopifyProducts.title, handle: shopifyProducts.handle, status: shopifyProducts.status })
    .from(shopifyProducts)
    .where(ref.id ? eq(shopifyProducts.id, ref.id) : eq(shopifyProducts.handle, (ref.handle ?? "").trim().toLowerCase()))
    .limit(2);
}

export async function listProducts(db: Db, opts: { activeOnly: boolean }) {
  const q = db
    .select({ id: shopifyProducts.id, title: shopifyProducts.title, handle: shopifyProducts.handle, status: shopifyProducts.status, productType: shopifyProducts.productType })
    .from(shopifyProducts)
    .orderBy(shopifyProducts.title);
  return opts.activeOnly ? q.where(eq(shopifyProducts.status, "ACTIVE")) : q;
}
