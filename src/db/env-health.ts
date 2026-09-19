/**
 * What each surface is missing, readable from anywhere (#35).
 *
 * The worker runs on Railway and the MCP is spawned by Claude Desktop on
 * Matt's Mac. `process.env` in one says nothing about the other, and two of
 * the three variables that shipped unset were the worker's — so a check that
 * only read its own environment would have reported them all present.
 *
 * So the two surfaces are answered differently, and the difference is stated
 * in the output rather than assumed:
 *
 *   mcp      read live from this process. Authoritative and current.
 *   worker   read from the row it wrote at boot, WITH its timestamp, so a
 *            stale record reads as stale rather than as current.
 *   web      not reported. Nothing on the web surface records a check, and
 *            inventing an "ok" for it would be the exact failure this fixes.
 */

import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { envChecks } from "./schema";
import {
  checkEnv,
  describeEnvRecord,
  toStoredVariables,
  type EnvReport,
  type StoredEnvVariable,
} from "@/config/env-manifest";

export async function getEnvHealth(
  db: Db,
  now: Date,
  env: Record<string, string | undefined> = process.env
): Promise<EnvReport[]> {
  // This process. No database needed and no staleness possible.
  const mcpCheck = checkEnv("mcp", env);
  const mcp = describeEnvRecord(
    "mcp",
    {
      recordedAt: now,
      variables: toStoredVariables(mcpCheck),
      missingRequired: mcpCheck.missingRequired.length,
    },
    now
  );

  let workerRow:
    | { recordedAt: Date; variables: StoredEnvVariable[]; missingRequired: number }
    | null = null;

  try {
    const [row] = await db
      .select({
        recordedAt: envChecks.recordedAt,
        variables: envChecks.variables,
        missingRequired: envChecks.missingRequired,
      })
      .from(envChecks)
      .where(eq(envChecks.surface, "worker"))
      .limit(1);

    if (row) {
      workerRow = {
        recordedAt: row.recordedAt,
        variables: row.variables as StoredEnvVariable[],
        missingRequired: row.missingRequired,
      };
    }
  } catch {
    // A read that threw is not an absent record, but both leave us without
    // evidence — and `describeEnvRecord(null)` reports unknown, which is the
    // honest answer to either. What must not happen is throwing here and
    // taking the whole freshness response down with it.
    workerRow = null;
  }

  return [mcp, describeEnvRecord("worker", workerRow, now)];
}

/** True unless every surface reported is fine. Unknown is never fine. */
export function anyEnvProblem(reports: EnvReport[]): boolean {
  return reports.some((r) => r.status !== "ok");
}
