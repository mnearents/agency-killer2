/**
 * Reads over the footage table, for the MCP surface (#13).
 *
 * The distinction every caller needs: a clip with no tags because it is silent
 * is a known, listed clip — not a failure, and not something waiting to be
 * fixed. B-roll has no speech and that is what b-roll is.
 */

import { sql, eq, and, desc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { footage, kbDocuments } from "@/db/schema";
import type { FootageKind } from "./finished-ads";

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
  /** Transcribed clips whose word timings are stored — what a cut list needs. */
  timed: number;
}

/** Where the page after this one starts, or null when this one is the last. */
export function nextPageOffset(offset: number, returned: number, matched: number): number | null {
  const next = offset + returned;
  return returned > 0 && next < matched ? next : null;
}

export async function getFootageCoverage(db: Db, kind: FootageKind = "raw"): Promise<FootageCoverage> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      transcribed: sql<number>`count(*) filter (where ${footage.transcriptionStatus} = 'ok')::int`,
      silent: sql<number>`count(*) filter (where ${footage.transcriptionStatus} = 'no-audio')::int`,
      failed: sql<number>`count(*) filter (where ${footage.transcriptionStatus} in ('error','unknown'))::int`,
      pending: sql<number>`count(*) filter (where ${footage.transcriptionStatus} is null)::int`,
      tagged: sql<number>`count(${footage.taggedAt})::int`,
      timed: sql<number>`count(*) filter (where ${footage.transcriptionStatus} = 'ok' and jsonb_array_length(${footage.words}) > 0)::int`,
    })
    .from(footage)
    .where(eq(footage.kind, kind));
  return row;
}

export async function listFootage(
  db: Db,
  options: { status?: string; tag?: string; limit: number; offset?: number; kind?: FootageKind },
): Promise<{ rows: FootageSummary[]; matched: number; nextOffset: number | null }> {
  const offset = options.offset ?? 0;
  const conditions = [eq(footage.kind, options.kind ?? "raw")];
  if (options.status) conditions.push(eq(footage.transcriptionStatus, options.status));
  // jsonb containment, so a tag matches exactly rather than as a substring of
  // another tag.
  if (options.tag) conditions.push(sql`${footage.tags} @> ${JSON.stringify([options.tag.toLowerCase()])}::jsonb`);
  const where = and(...conditions);

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
    // A total order, so a page boundary never falls between two clips updated
    // in the same instant and shows one twice and the other never.
    .orderBy(desc(footage.updatedAt), footage.path, footage.dropboxId)
    .limit(options.limit)
    .offset(offset);

  return { rows, matched, nextOffset: nextPageOffset(offset, rows.length, matched) };
}

/** Every tag in use, so a caller can filter without guessing at vocabulary. */
export async function getFootageTags(db: Db): Promise<{ tag: string; clips: number }[]> {
  const rows = await db.execute(sql`
    select tag, count(*)::int as clips
    from footage, jsonb_array_elements_text(coalesce(tags, '[]'::jsonb)) as tag
    where kind = 'raw'
    group by tag order by count(*) desc, tag
  `);
  return rows as unknown as { tag: string; clips: number }[];
}

export interface FinishedAdSummary {
  path: string;
  name: string;
  hook: string | null;
  angle: string | null;
  product: string | null;
  callToAction: string | null;
  format: string | null;
  summary: string | null;
  tags: string[] | null;
  transcriptionStatus: string | null;
  durationMs: number | null;
  /** The ad's words, from its knowledge base document. Null when it has none. */
  transcript: string | null;
  firstSeenAt: string;
}

export interface FinishedAdUsage {
  /** Ads analysed from what was said in them. */
  analysed: number;
  /** No speech, so no hook or angle could be read — likely music and on-screen text. */
  silent: number;
  failed: number;
  pending: number;
  angles: { angle: string; ads: number }[];
  products: { product: string; ads: number }[];
  formats: { format: string; ads: number }[];
}

/** What has been used across every finished ad — the "already done" list. */
export async function getFinishedAdUsage(db: Db): Promise<FinishedAdUsage> {
  const [counts] = await db
    .select({
      analysed: sql<number>`count(*) filter (where ${footage.transcriptionStatus} = 'ok')::int`,
      silent: sql<number>`count(*) filter (where ${footage.transcriptionStatus} = 'no-audio')::int`,
      failed: sql<number>`count(*) filter (where ${footage.transcriptionStatus} in ('error','unknown'))::int`,
      pending: sql<number>`count(*) filter (where ${footage.transcriptionStatus} is null)::int`,
    })
    .from(footage)
    .where(eq(footage.kind, "finished-ad"));

  const tally = async (column: "ad_angle" | "ad_product" | "ad_format") =>
    (await db.execute(sql`
      select ${sql.identifier(column)} as value, count(*)::int as ads
      from footage
      where kind = 'finished-ad' and ${sql.identifier(column)} is not null
      group by 1 order by count(*) desc, 1
    `)) as unknown as { value: string; ads: number }[];

  const [angles, products, formats] = await Promise.all([
    tally("ad_angle"), tally("ad_product"), tally("ad_format"),
  ]);
  return {
    ...counts,
    angles: angles.map((r) => ({ angle: r.value, ads: r.ads })),
    products: products.map((r) => ({ product: r.value, ads: r.ads })),
    formats: formats.map((r) => ({ format: r.value, ads: r.ads })),
  };
}

export async function listFinishedAds(
  db: Db,
  options: { angle?: string; product?: string; format?: string; limit: number; offset?: number },
): Promise<{ rows: FinishedAdSummary[]; matched: number; nextOffset: number | null }> {
  const offset = options.offset ?? 0;
  const conditions = [eq(footage.kind, "finished-ad")];
  // Case-insensitive and whole-value, so "time saving" finds the ads analysed
  // as "Time saving" and not those whose angle merely contains the words.
  if (options.angle) conditions.push(sql`lower(${footage.adAngle}) = ${options.angle.toLowerCase()}`);
  if (options.product) conditions.push(sql`lower(${footage.adProduct}) = ${options.product.toLowerCase()}`);
  if (options.format) conditions.push(sql`lower(${footage.adFormat}) = ${options.format.toLowerCase()}`);
  const where = and(...conditions);

  const [{ matched }] = await db
    .select({ matched: sql<number>`count(*)::int` })
    .from(footage)
    .where(where);

  const rows = await db
    .select({
      path: footage.path,
      name: footage.name,
      hook: footage.adHook,
      angle: footage.adAngle,
      product: footage.adProduct,
      callToAction: footage.adCallToAction,
      format: footage.adFormat,
      summary: footage.summary,
      tags: footage.tags,
      transcriptionStatus: footage.transcriptionStatus,
      durationMs: footage.durationMs,
      // The text after the document's `Transcript:` marker, as footageTranscript reads it.
      transcript: sql<string | null>`case when position(E'\\nTranscript:\\n' in ${kbDocuments.content}) > 0
        then substring(${kbDocuments.content} from position(E'\\nTranscript:\\n' in ${kbDocuments.content}) + 13) end`,
      firstSeenAt: sql<string>`${footage.firstSeenAt}::text`,
    })
    .from(footage)
    .leftJoin(kbDocuments, eq(kbDocuments.sourceFile, sql`'footage:' || ${footage.dropboxId}`))
    .where(where)
    .orderBy(desc(footage.firstSeenAt), footage.path, footage.dropboxId)
    .limit(options.limit)
    .offset(offset);

  return { rows, matched, nextOffset: nextPageOffset(offset, rows.length, matched) };
}
