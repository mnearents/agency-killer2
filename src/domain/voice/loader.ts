/**
 * Voice profile loader — loads from DB first, falls back to seed file.
 *
 * On first run with an empty DB, seeds the DB from the JSON file so
 * future edits go to the DB and persist across deploys.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { VoiceProfile, WritingSample } from "./voice";
import type { Db } from "@/db/client";
import { readVoiceProfileFromDb, seedVoiceProfileToDb } from "./queries";

/**
 * Where the profile in hand actually came from.
 *
 * Carried on the profile rather than logged and discarded, because the caller is
 * what prints the line an operator reads. A summary that says "loaded N samples"
 * without naming the source reads the same whether the corpus was reached or
 * not — which is what made #54 invisible for a full deploy cycle.
 */
export type VoiceProfileSource =
  | "database"
  | "seed file (database empty)"
  | "seed file (database unreachable)";

export interface LoadedVoiceProfile extends VoiceProfile {
  source: VoiceProfileSource;
}

interface SeedData {
  samples: Array<{
    id: string;
    content: string;
    title: string;
    tags: string[];
    createdAt: string;
  }>;
  rules: string[];
  bannedWords: string[];
  promptTemplate?: string;
}

function loadSeedFile(): VoiceProfile {
  const paths = [
    join(dirname(fileURLToPath(import.meta.url)), "voice-profile-seed.json"),
    join(process.cwd(), "src/domain/voice/voice-profile-seed.json"),
  ];

  let raw: string | null = null;
  for (const path of paths) {
    try {
      raw = readFileSync(path, "utf-8");
      break;
    } catch {
      continue;
    }
  }

  if (!raw) {
    console.warn("[voice] Could not load voice-profile-seed.json — using empty profile");
    return {
      samples: [],
      rules: [],
      bannedWords: ["synergy", "delve", "leverage"],
    };
  }

  const seed: SeedData = JSON.parse(raw);

  return {
    samples: seed.samples.map((s) => ({
      id: s.id,
      title: s.title,
      content: s.content,
      tags: s.tags,
    })),
    rules: seed.rules,
    bannedWords: seed.bannedWords,
    promptTemplate: seed.promptTemplate,
  };
}

/**
 * Load voice profile from the seed file only, ignoring the database.
 *
 * Named explicitly because it is almost never what a caller wants. Samples are
 * edited through the /voice dashboard, the API, and the `!voice add` Slack
 * command, and every one of those writes to the database — so anything that
 * generates copy from this function is working off a frozen snapshot and will
 * silently ignore every edit. Use `loadVoiceProfileWithDb` unless there is
 * genuinely no database available.
 */
export function loadVoiceProfileFromSeedFile(): VoiceProfile {
  return loadSeedFile();
}

/**
 * Load voice profile from DB, seeding from file if DB is empty.
 * Call this after DB is available for the most up-to-date profile.
 */
export async function loadVoiceProfileWithDb(db: Db): Promise<LoadedVoiceProfile> {
  const read = await readVoiceProfileFromDb(db);

  if (read.status === "loaded") {
    const p = read.profile;
    console.log(
      `[voice] Loaded from DB: ${p.samples.length} samples, ${p.rules.length} rules, ${p.bannedWords.length} banned words`
    );
    return { ...p, source: "database" };
  }

  const seedProfile = loadSeedFile();

  if (read.status === "unavailable") {
    // Not seeded: the read failed, so "empty" was never established, and
    // inserting 84 rows into a database that may already hold them is how one
    // failure becomes two. Generation continues on the file — a worse corpus
    // beats no corpus — but nothing here is allowed to read as a normal load.
    console.error(
      "[voice] Corpus UNREACHABLE — falling back to the seed file. Edits made " +
        "through /voice, the API, or `!voice add` are NOT in this profile:",
      read.error
    );
    return { ...seedProfile, source: "seed file (database unreachable)" };
  }

  if (seedProfile.samples.length > 0) {
    try {
      const count = await seedVoiceProfileToDb(db, seedProfile);
      console.log(`[voice] Seeded DB with ${count} items from seed file`);
    } catch (err) {
      console.error("[voice] Failed to seed an empty DB:", err);
    }
  }

  return { ...seedProfile, source: "seed file (database empty)" };
}
