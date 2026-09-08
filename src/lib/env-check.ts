/**
 * Evaluates the env manifest for one surface and renders the result.
 *
 * Pure: the environment and the clock are both arguments, so a check is exactly
 * reproducible in a test. Callers pass `process.env` and `new Date()`.
 *
 * **No value ever enters the result.** The result is logged at startup, written
 * to the database, and returned through an MCP tool — a value that leaked into
 * the shape would be a credential in all three places. Only the name, whether
 * something non-blank was set, and the consequence of its absence travel.
 */

import {
  requirementsFor,
  type Severity,
  type Surface,
} from "@/lib/env-manifest";

export interface EnvVariableStatus {
  name: string;
  present: boolean;
  severity: Severity;
  /** What stops working while this is absent. Copied from the manifest. */
  breaks: string;
}

export interface EnvCheckResult {
  surface: Surface;
  checkedAt: Date;
  /** True when nothing `required` or `degraded` is absent. Optionals never count. */
  ok: boolean;
  /** Every expected variable, present ones included — the list is the whole truth. */
  variables: EnvVariableStatus[];
  missingRequired: string[];
  missingDegraded: string[];
}

/**
 * Railway lets you save a variable with an empty value. It is then present in
 * `process.env`, falsy at every use site, and looks configured in the dashboard
 * — the worst of both states. A blank is treated as absent, which also matches
 * how the worker's own `getEnvOptional` truthiness check already behaves.
 */
function isPresent(value: string | undefined): boolean {
  return value != null && value.trim() !== "";
}

export function checkEnv(
  surface: Surface,
  env: Record<string, string | undefined>,
  now: Date
): EnvCheckResult {
  const variables: EnvVariableStatus[] = requirementsFor(surface).map((r) => ({
    name: r.name,
    present: isPresent(env[r.name]),
    severity: r.severity,
    breaks: r.breaks,
  }));

  const missingOf = (severity: Severity) =>
    variables.filter((v) => !v.present && v.severity === severity).map((v) => v.name);

  const missingRequired = missingOf("required");
  const missingDegraded = missingOf("degraded");

  return {
    surface,
    checkedAt: now,
    // An absent optional has a working default, so it is not a problem. Counting
    // it would make this permanently unhappy, and a permanently unhappy check is
    // one nobody reads — which is how three real missing variables stayed invisible.
    ok: missingRequired.length === 0 && missingDegraded.length === 0,
    variables,
    missingRequired,
    missingDegraded,
  };
}

/**
 * One line per expected variable, for the startup log.
 *
 * Present variables are listed too. The point is not to print a warning — the
 * three incidents all had a warning — it is that someone reading the log can see
 * the whole expected set and what of it arrived.
 *
 * Returns lines rather than writing them: the MCP must log to stderr, because
 * stdout is its JSON-RPC channel.
 */
export function formatEnvCheck(result: EnvCheckResult): string[] {
  const tag = `[env:${result.surface}]`;
  const width = Math.max(0, ...result.variables.map((v) => v.name.length));

  const lines = result.variables.map((v) => {
    const mark = v.present ? "PRESENT" : "MISSING";
    const head = `${tag} ${mark}  ${v.name.padEnd(width)}`;
    // The consequence goes on the line that reports the absence, so the reader
    // never has to look up what the name meant.
    return v.present ? head.trimEnd() : `${head}  ${v.severity} — ${v.breaks}`;
  });

  const summary = result.ok
    ? `${tag} all ${result.variables.length} expected variables present (or optional)`
    : `${tag} ${result.missingRequired.length} required and ` +
      `${result.missingDegraded.length} feature-disabling variables are missing`;

  return [...lines, summary];
}
