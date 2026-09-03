/**
 * Sync outcome classification.
 *
 * Why this module exists: `meta_insights` held zero rows for months while the
 * daily task cheerfully logged "Done: 0 insights". The task had never actually
 * called Meta — META_AD_ACCOUNT_ID was unset, so it returned early every run.
 * Nothing in the logs or the database distinguished that from a working sync
 * over a paused account.
 *
 * The fix is to make "why is this zero?" a first-class, recorded answer rather
 * than something a human has to infer from an absence.
 */

import { MetaApiError } from "@/integrations/meta-api";

/** Meta error codes that mean the credentials are the problem. */
const AUTH_ERROR_CODES = new Set([
  102, // session invalid
  190, // access token expired / invalidated / malformed
  200, // permissions error
  272, // insufficient permission for ad account
  294, // requires management permission
  10, // permission denied
]);

/** Meta error codes that mean "slow down", not "you are broken". */
const RATE_LIMIT_ERROR_CODES = new Set([
  4, // application request limit reached
  17, // user request limit reached
  32, // page-level throttle
  613, // calls per second limit
  80000, 80001, 80002, 80003, 80004, // business use case throttling
]);

export type SyncOutcome =
  | "ok"
  | "no-data"
  | "auth-failed"
  | "rate-limited"
  | "api-error"
  | "not-configured";

export interface ClassifyInput {
  /** False when required credentials were absent and no call was attempted. */
  configured: boolean;
  rowsWritten: number;
  error?: unknown;
}

export interface ClassifiedRun {
  outcome: SyncOutcome;
  rowsWritten: number;
  errorMessage: string | null;
  errorCode: number | null;
}

/**
 * Reduce a sync attempt to exactly one outcome.
 *
 * Order matters. An error always wins over the row count: a run that wrote 300
 * rows and then hit a throttle is a rate-limited run, not a success. Reporting
 * it as success is how a half-finished backfill gets mistaken for a complete one.
 */
export function classifyOutcome(input: ClassifyInput): ClassifiedRun {
  const { configured, rowsWritten, error } = input;

  if (error !== undefined && error !== null) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof MetaApiError ? error.code : null;

    let outcome: SyncOutcome = "api-error";
    if (code !== null) {
      if (AUTH_ERROR_CODES.has(code)) outcome = "auth-failed";
      else if (RATE_LIMIT_ERROR_CODES.has(code)) outcome = "rate-limited";
    }

    return { outcome, rowsWritten, errorMessage: message, errorCode: code };
  }

  if (!configured) {
    return {
      outcome: "not-configured",
      rowsWritten,
      errorMessage: null,
      errorCode: null,
    };
  }

  return {
    outcome: rowsWritten > 0 ? "ok" : "no-data",
    rowsWritten,
    errorMessage: null,
    errorCode: null,
  };
}

/** Outcomes that mean a human needs to do something. */
export function isFailure(outcome: SyncOutcome): boolean {
  return (
    outcome === "auth-failed" ||
    outcome === "api-error" ||
    outcome === "rate-limited" ||
    outcome === "not-configured"
  );
}
