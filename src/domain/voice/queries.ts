/**
 * Voice profile DB queries — CRUD for samples, rules, and banned words.
 */

import { eq, asc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { voiceSamples, voiceRules, voiceBannedWords } from "@/db/schema";
import type { VoiceProfile, WritingSample } from "./voice";

// ─── Samples ──────────────────────────────────────────────────────────

export async function getAllSamples(db: Db) {
  return db.select().from(voiceSamples).orderBy(asc(voiceSamples.createdAt));
}

export async function addSample(db: Db, title: string, content: string, tags: string[] = []) {
  const [created] = await db
    .insert(voiceSamples)
    .values({ title, content, tags })
    .returning();
  return created;
}

export async function updateSample(db: Db, id: string, updates: { title?: string; content?: string; tags?: string[] }) {
  const [updated] = await db
    .update(voiceSamples)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(voiceSamples.id, id))
    .returning();
  return updated ?? null;
}

export async function deleteSample(db: Db, id: string) {
  const result = await db.delete(voiceSamples).where(eq(voiceSamples.id, id)).returning({ id: voiceSamples.id });
  return result.length > 0;
}

// ─── Rules ────────────────────────────────────────────────────────────

export async function getAllRules(db: Db) {
  return db.select().from(voiceRules).orderBy(asc(voiceRules.createdAt));
}

export async function addRule(db: Db, rule: string) {
  const [created] = await db.insert(voiceRules).values({ rule }).returning();
  return created;
}

export async function deleteRule(db: Db, id: string) {
  const result = await db.delete(voiceRules).where(eq(voiceRules.id, id)).returning({ id: voiceRules.id });
  return result.length > 0;
}

// ─── Banned Words ─────────────────────────────────────────────────────

export async function getAllBannedWords(db: Db) {
  return db.select().from(voiceBannedWords).orderBy(asc(voiceBannedWords.createdAt));
}

export async function addBannedWord(db: Db, word: string) {
  const [created] = await db.insert(voiceBannedWords).values({ word }).returning();
  return created;
}

export async function deleteBannedWord(db: Db, id: string) {
  const result = await db.delete(voiceBannedWords).where(eq(voiceBannedWords.id, id)).returning({ id: voiceBannedWords.id });
  return result.length > 0;
}

// ─── Load full profile from DB ────────────────────────────────────────

/**
 * The outcome of a corpus read. Three states, never two.
 *
 * This used to be `VoiceProfile | null`, where `null` meant both "the tables are
 * empty" and "the read threw". Those need different responses — an empty corpus
 * should be seeded, an unreachable one must not be — and collapsing them meant
 * the caller could not tell which had happened. On 2026-09-09 a worker booted
 * against a database missing a column it had just started selecting, got `null`,
 * concluded the corpus was empty, tried to seed it, failed again, and reported a
 * successful load of the seed file. See #54.
 */
export type VoiceProfileRead =
  | { status: "loaded"; profile: VoiceProfile }
  | { status: "empty" }
  | { status: "unavailable"; error: unknown };

export async function readVoiceProfileFromDb(db: Db): Promise<VoiceProfileRead> {
  let samples, rules, bannedWords;
  try {
    [samples, rules, bannedWords] = await Promise.all([
      getAllSamples(db),
      getAllRules(db),
      getAllBannedWords(db),
    ]);
  } catch (error) {
    // The tables may not exist yet, the column may be mid-migration, or the
    // database may simply be down. None of those is an empty corpus.
    return { status: "unavailable", error };
  }

  if (samples.length === 0 && rules.length === 0 && bannedWords.length === 0) {
    return { status: "empty" };
  }

  return {
    status: "loaded",
    profile: {
      samples: samples.map((s) => ({
        id: s.id,
        title: s.title,
        content: s.content,
        tags: (s.tags as string[]) ?? [],
      })),
      rules: rules.map((r) => r.rule),
      bannedWords: bannedWords.map((b) => b.word),
    },
  };
}

/**
 * Seed the DB from the JSON file if the DB is empty.
 */
export async function seedVoiceProfileToDb(db: Db, profile: VoiceProfile): Promise<number> {
  let count = 0;

  for (const sample of profile.samples) {
    await db.insert(voiceSamples).values({
      title: sample.title,
      content: sample.content,
      tags: sample.tags,
    });
    count++;
  }

  for (const rule of profile.rules) {
    await db.insert(voiceRules).values({ rule });
    count++;
  }

  for (const word of profile.bannedWords) {
    await db.insert(voiceBannedWords).values({ word });
    count++;
  }

  return count;
}
