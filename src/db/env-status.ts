/**
 * Environment status across all three processes.
 *
 * `checkEnv` can only see the environment of the process it runs in. The MCP
 * cannot read the worker's variables, and the worker's are the ones that have
 * actually been wrong. So each surface records its own check at startup, and
 * this module reassembles the three into one answer that `data_freshness` can
 * return — the tool a model is already told to call before trusting anything.
 *
 * The rule that matters here: **a surface that has never recorded reports
 * UNKNOWN, not healthy.** A missing record is an absence of evidence, and
 * turning it into `ok: true` would rebuild the exact failure this is meant to
 * catch — a green signal with no check behind it.
 */

import { desc } from "drizzle-orm";
import type { Db } from "./client";
import { envChecks } from "./schema";
import type { EnvCheckResult } from "@/lib/env-check";
import {
  ENV_MANIFEST,
  SURFACES,
  type Severity,
  type Surface,
} from "@/lib/env-manifest";

/**
 * The worker re-records daily, so a record older than this means it stopped
 * reporting — the process is down, or wedged before startup finished. Matched to
 * the daily sync window for the same reason.
 */
export const ENV_STALE_HOURS = 36;

const HOUR_MS = 60 * 60 * 1000;

/** One surface's stored check, as read back from the database. */
export interface RecordedEnvCheck {
  surface: Surface;
  checkedAt: Date;
  ok: boolean;
  expected: number;
  missingRequired: string[];
  missingDegraded: string[];
}

/**
 * `live` — this process checked its own environment just now; cannot be stale.
 * `recorded` — another process wrote this; age tells you whether to believe it.
 * `never-recorded` — no evidence either way. Reported as unknown.
 */
export type EnvBasis = "live" | "recorded" | "never-recorded";

export interface EnvConsequence {
  name: string;
  severity: Severity;
  breaks: string;
}

export interface SurfaceEnvStatus {
  surface: Surface;
  basis: EnvBasis;
  /** Null means unknown. Never `true` on the strength of a missing record. */
  ok: boolean | null;
  checkedAt: string | null;
  ageHours: number | null;
  stale: boolean;
  /**
   * How many variables the reporting process expected. A process on an older
   * deploy checks an older manifest, so it can report "nothing missing" quite
   * honestly while being blind to a variable added since. Null when unknown.
   */
  expected: number | null;
  missingRequired: string[];
  missingDegraded: string[];
  /** What each missing variable breaks, so the name does not need looking up. */
  consequences: EnvConsequence[];
}

function consequencesFor(names: string[]): EnvConsequence[] {
  return names.flatMap((name) => {
    const r = ENV_MANIFEST.find((m) => m.name === name);
    return r ? [{ name: r.name, severity: r.severity, breaks: r.breaks }] : [];
  });
}

export function classifyEnvStatus(
  records: RecordedEnvCheck[],
  live: EnvCheckResult | null,
  now: Date
): SurfaceEnvStatus[] {
  return SURFACES.map((surface) => {
    // A live check beats a stored one: it describes this instant, while the
    // record describes whenever that process last started.
    if (live && live.surface === surface) {
      return {
        surface,
        basis: "live" as const,
        ok: live.ok,
        checkedAt: live.checkedAt.toISOString(),
        ageHours: 0,
        stale: false,
        expected: live.variables.length,
        missingRequired: live.missingRequired,
        missingDegraded: live.missingDegraded,
        consequences: consequencesFor([...live.missingRequired, ...live.missingDegraded]),
      };
    }

    const record = records.find((r) => r.surface === surface);
    if (!record) {
      return {
        surface,
        basis: "never-recorded" as const,
        // Unknown. Not ok. This process has never told us anything, which is
        // itself worth seeing — it is how a service that never boots looks.
        ok: null,
        checkedAt: null,
        ageHours: null,
        stale: true,
        expected: null,
        missingRequired: [],
        missingDegraded: [],
        consequences: [],
      };
    }

    const ageHours = (now.getTime() - record.checkedAt.getTime()) / HOUR_MS;
    return {
      surface,
      basis: "recorded" as const,
      ok: record.ok,
      checkedAt: record.checkedAt.toISOString(),
      ageHours: Math.round(ageHours * 10) / 10,
      // Stale on age alone, whatever the record says. A week-old `ok` describes
      // a process that is no longer running.
      stale: ageHours > ENV_STALE_HOURS,
      expected: record.expected,
      missingRequired: record.missingRequired,
      missingDegraded: record.missingDegraded,
      consequences: consequencesFor([...record.missingRequired, ...record.missingDegraded]),
    };
  });
}

/**
 * Store this process's check, replacing whatever that surface recorded before.
 *
 * One row per surface: the only question anyone asks is "what is true now", and
 * a history of startups would bury it. Called at startup and daily thereafter,
 * so `checked_at` doubles as a liveness signal.
 */
export async function recordEnvCheck(db: Db, result: EnvCheckResult): Promise<void> {
  await db
    .insert(envChecks)
    .values({
      surface: result.surface,
      checkedAt: result.checkedAt,
      ok: result.ok ? 1 : 0,
      expected: result.variables.length,
      missingRequired: result.missingRequired,
      missingDegraded: result.missingDegraded,
    })
    .onConflictDoUpdate({
      target: envChecks.surface,
      set: {
        checkedAt: result.checkedAt,
        ok: result.ok ? 1 : 0,
        expected: result.variables.length,
        missingRequired: result.missingRequired,
        missingDegraded: result.missingDegraded,
      },
    });
}

/** Every surface's status, with the calling process's own check taken live. */
export async function getEnvironmentStatus(
  db: Db,
  live: EnvCheckResult | null,
  now: Date
): Promise<SurfaceEnvStatus[]> {
  const rows = await db
    .select({
      surface: envChecks.surface,
      checkedAt: envChecks.checkedAt,
      ok: envChecks.ok,
      expected: envChecks.expected,
      missingRequired: envChecks.missingRequired,
      missingDegraded: envChecks.missingDegraded,
    })
    .from(envChecks)
    .orderBy(desc(envChecks.checkedAt));

  const records: RecordedEnvCheck[] = rows.map((r) => ({
    surface: r.surface as Surface,
    checkedAt: new Date(r.checkedAt),
    ok: r.ok === 1,
    expected: r.expected,
    missingRequired: r.missingRequired ?? [],
    missingDegraded: r.missingDegraded ?? [],
  }));

  return classifyEnvStatus(records, live, now);
}
