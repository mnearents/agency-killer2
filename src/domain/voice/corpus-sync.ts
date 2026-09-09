/**
 * Reconciles the seed-file corpus into the database on every boot.
 *
 * ## Why this exists
 *
 * `voice-profile-seed.json` is where the corpus is authored; `voice_samples` is
 * what every generation actually reads. The only bridge used to be
 * `seedVoiceProfileToDb`, which fires once, when all three voice tables are
 * empty. Production filled those tables on its first boot, so from that moment
 * every edit to the seed file was a no-op — a real diff, a green suite, a clean
 * deploy, and a corpus that did not move.
 *
 * ## Two owners, one table
 *
 * A row's `sourceKey` says who owns it:
 *
 * - **non-null** — authored in the seed file. The file is authoritative: the row
 *   is updated to match it, and removed when the file stops mentioning it.
 * - **null** — written by a person, through the `/voice` dashboard, the API
 *   route, or `!voice add` in Slack. The seed file has no authority over it and
 *   never deletes or rewrites it.
 *
 * That distinction is the whole safety property. `!voice add` tells Tara her
 * sample was saved and she has no way to verify it later, so a sync that read
 * "absent from the file" as "delete" would remove her work on the next deploy
 * and report a successful boot.
 *
 * Planning is separated from applying so the rules above are testable without a
 * database. Everything that can be decided is decided in `planCorpusSync`.
 */

import { eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { voiceSamples, voiceRules, voiceBannedWords } from "@/db/schema";
import type { VoiceProfile } from "./voice";
import { loadVoiceProfileFromSeedFile } from "./loader";

/** A sample as authored in the seed file. */
export interface SeedEntry {
  sourceKey: string;
  title: string;
  content: string;
  tags: string[];
}

/** A sample as it currently exists in the database. */
export interface CorpusRow {
  id: string;
  sourceKey: string | null;
  title: string;
  content: string;
  tags: string[];
}

export interface CorpusPlan {
  insert: SeedEntry[];
  update: Array<SeedEntry & { id: string }>;
  delete: string[];
  /** Rows a person added. Reported, never acted on. */
  userOwned: number;
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Decide what the database should become, without touching it.
 *
 * Throws rather than returning an empty plan on malformed input. A truncated or
 * unparseable seed file yields zero entries, and the difference between "the
 * corpus is deliberately empty" and "the file failed to load" is not one this
 * function can see — so it refuses both.
 */
export function planCorpusSync(seed: SeedEntry[], rows: CorpusRow[]): CorpusPlan {
  if (seed.length === 0) {
    throw new Error(
      "Refusing to sync an empty seed corpus: this would delete every seed-sourced " +
        "sample, and an unreadable seed file looks exactly like an empty one."
    );
  }

  const seen = new Set<string>();
  for (const entry of seed) {
    if (!entry.sourceKey?.trim()) {
      throw new Error(
        `Seed entry "${entry.title}" has no source key, so it could never be matched ` +
          "to its row and would be re-inserted on every boot."
      );
    }
    if (seen.has(entry.sourceKey)) {
      throw new Error(`Duplicate seed source key: ${entry.sourceKey}`);
    }
    seen.add(entry.sourceKey);
  }

  const owned = new Map<string, CorpusRow>();
  let userOwned = 0;
  for (const r of rows) {
    if (r.sourceKey === null) userOwned++;
    else owned.set(r.sourceKey, r);
  }

  const insert: SeedEntry[] = [];
  const update: Array<SeedEntry & { id: string }> = [];

  for (const entry of seed) {
    const existing = owned.get(entry.sourceKey);
    if (!existing) {
      insert.push(entry);
    } else if (
      existing.title !== entry.title ||
      existing.content !== entry.content ||
      !sameTags(existing.tags, entry.tags)
    ) {
      update.push({ ...entry, id: existing.id });
    }
  }

  const remove = [...owned.values()].filter((r) => !seen.has(r.sourceKey!)).map((r) => r.id);

  return { insert, update, delete: remove, userOwned };
}

export interface CorpusSyncResult {
  inserted: number;
  updated: number;
  removed: number;
  userOwned: number;
  unchanged: number;
}

/**
 * Apply the plan. Samples only — rules and banned words are short flat lists
 * and are reconciled by value below.
 */
export async function syncVoiceCorpus(
  db: Db,
  now: Date,
  profile: VoiceProfile = loadVoiceProfileFromSeedFile()
): Promise<CorpusSyncResult> {
  const seed: SeedEntry[] = profile.samples.map((s) => ({
    sourceKey: s.id,
    title: s.title,
    content: s.content,
    tags: s.tags ?? [],
  }));

  const existing = await db
    .select({
      id: voiceSamples.id,
      sourceKey: voiceSamples.sourceKey,
      title: voiceSamples.title,
      content: voiceSamples.content,
      tags: voiceSamples.tags,
    })
    .from(voiceSamples);

  const plan = planCorpusSync(
    seed,
    existing.map((r) => ({ ...r, tags: (r.tags as string[]) ?? [] }))
  );

  if (plan.insert.length > 0) {
    await db.insert(voiceSamples).values(plan.insert);
  }
  for (const u of plan.update) {
    await db
      .update(voiceSamples)
      .set({ title: u.title, content: u.content, tags: u.tags, updatedAt: now })
      .where(eq(voiceSamples.id, u.id));
  }
  if (plan.delete.length > 0) {
    await db.delete(voiceSamples).where(inArray(voiceSamples.id, plan.delete));
  }

  await syncRules(db, profile.rules);
  await syncBannedWords(db, profile.bannedWords);

  return {
    inserted: plan.insert.length,
    updated: plan.update.length,
    removed: plan.delete.length,
    userOwned: plan.userOwned,
    unchanged: seed.length - plan.insert.length - plan.update.length,
  };
}

/**
 * Rules and banned words have no identity beyond their text, so the text is the
 * source key. Seed-sourced entries are added and removed to match the file;
 * entries a person added carry a null source key and are left alone, same rule
 * as samples.
 *
 * An empty list is treated as "not authored here" and skipped rather than as
 * "delete them all", for the same reason `planCorpusSync` refuses an empty seed.
 */
async function syncRules(db: Db, rules: string[]): Promise<void> {
  if (rules.length === 0) return;

  const existing = await db
    .select({ id: voiceRules.id, sourceKey: voiceRules.sourceKey })
    .from(voiceRules)
    .where(isNotNull(voiceRules.sourceKey));

  const wanted = new Set(rules);
  const have = new Set(existing.map((r) => r.sourceKey!));

  const toAdd = rules.filter((r) => !have.has(r));
  const toRemove = existing.filter((r) => !wanted.has(r.sourceKey!)).map((r) => r.id);

  if (toAdd.length > 0) {
    await db.insert(voiceRules).values(toAdd.map((rule) => ({ rule, sourceKey: rule })));
  }
  if (toRemove.length > 0) {
    await db.delete(voiceRules).where(inArray(voiceRules.id, toRemove));
  }
}

async function syncBannedWords(db: Db, words: string[]): Promise<void> {
  if (words.length === 0) return;

  const existing = await db
    .select({ id: voiceBannedWords.id, sourceKey: voiceBannedWords.sourceKey })
    .from(voiceBannedWords)
    .where(isNotNull(voiceBannedWords.sourceKey));

  const wanted = new Set(words);
  const have = new Set(existing.map((r) => r.sourceKey!));

  const toAdd = words.filter((w) => !have.has(w));
  const toRemove = existing.filter((r) => !wanted.has(r.sourceKey!)).map((r) => r.id);

  if (toAdd.length > 0) {
    await db.insert(voiceBannedWords).values(toAdd.map((word) => ({ word, sourceKey: word })));
  }
  if (toRemove.length > 0) {
    await db.delete(voiceBannedWords).where(inArray(voiceBannedWords.id, toRemove));
  }
}
