/**
 * Reads over the footage table, for the MCP surface (#13).
 *
 * The distinction every caller needs: a clip with no tags because it is silent
 * is a known, listed clip — not a failure, and not something waiting to be
 * fixed. B-roll has no speech and that is what b-roll is.
 */

import { sql, eq, desc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { footage } from "@/db/schema";

export interface FootageSummary {
  path: string;
  name: string;
  sizeBytes: number;
  transcriptionStatus: string | null;
  transcriptionDetail: string | null;
  tags: string[] | null;
  summary: string | null;
  attempts: number;
  attemptedAt: string | null;
}

export interface FootageCoverage {
  total: number;
  transcribed: number;
  /** No speech. Ordinary for b-roll; cannot be tagged without vision. */
  silent: number;
  failed: number;
  pending: number;
  tagged: number;
}

export async function getFootageCoverage(db: Db): Promise<FootageCoverage> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      transcribed: sql<number>`count(*) filter (where ${footage.transcriptionStatus} = 'ok')::int`,
      silent: sql<number>`count(*) filter (where ${footage.transcriptionStatus} = 'no-audio')::int`,
      failed: sql<number>`count(*) filter (where ${footage.transcriptionStatus} in ('error','unknown'))::int`,
      pending: sql<number>`count(*) filter (where ${footage.transcriptionStatus} is null)::int`,
      tagged: sql<number>`count(${footage.taggedAt})::int`,
    })
    .from(footage);
  return row;
}

export async function listFootage(
  db: Db,
  options: { status?: string; tag?: string; limit: number },
): Promise<{ rows: FootageSummary[]; matched: number }> {
  const conditions = [];
  if (options.status) conditions.push(eq(footage.transcriptionStatus, options.status));
  // jsonb containment, so a tag matches exactly rather than as a substring of
  // another tag.
  if (options.tag) conditions.push(sql`${footage.tags} @> ${JSON.stringify([options.tag.toLowerCase()])}::jsonb`);
  const where = conditions.length > 0 ? sql.join(conditions, sql` and `) : undefined;

  const [{ matched }] = await db
    .select({ matched: sql<number>`count(*)::int` })
    .from(footage)
    .where(where);

  const rows = await db
    .select({
      path: footage.path,
      name: footage.name,
      sizeBytes: footage.sizeBytes,
      transcriptionStatus: footage.transcriptionStatus,
      transcriptionDetail: footage.transcriptionDetail,
      tags: footage.tags,
      summary: footage.summary,
      attempts: footage.transcriptionAttempts,
      attemptedAt: sql<string | null>`${footage.transcriptionAttemptedAt}::text`,
    })
    .from(footage)
    .where(where)
    .orderBy(desc(footage.updatedAt))
    .limit(options.limit);

  return { rows, matched };
}

/** Every tag in use, so a caller can filter without guessing at vocabulary. */
export async function getFootageTags(db: Db): Promise<{ tag: string; clips: number }[]> {
  const rows = await db.execute(sql`
    select tag, count(*)::int as clips
    from footage, jsonb_array_elements_text(coalesce(tags, '[]'::jsonb)) as tag
    group by tag order by count(*) desc, tag
  `);
  return rows as unknown as { tag: string; clips: number }[];
}
