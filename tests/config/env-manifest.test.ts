/**
 * ─── The env manifest (#35) ───────────────────────────────────────────
 *
 * Three features shipped tested, green and silently inert because their
 * variable was unset in production. Each degraded politely to stderr at
 * startup, which nobody reads, and every downstream surface carried on looking
 * healthy.
 *
 * Writing the manifest found the next one: `GOOGLE_SERVICE_ACCOUNT_JSON` and
 * `GSC_SITE_URL` are read by the worker and appeared in no `.env.example`.
 * They are set on Railway, so Search Console does sync — but an environment
 * built from the documentation would not have them.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  ENV_MANIFEST,
  checkEnv,
  formatEnvCheck,
  toStoredVariables,
  describeEnvRecord,
  type EnvVariable,
  type StoredEnvVariable,
} from "@/config/env-manifest";

const root = process.cwd();

describe("checkEnv", () => {
  const manifest: EnvVariable[] = [
    { name: "NEEDED", surfaces: ["worker"], severity: "required", impact: "Everything stops." },
    { name: "NICE", surfaces: ["worker"], severity: "degraded", impact: "One feature stops." },
    { name: "ELSEWHERE", surfaces: ["mcp"], severity: "required", impact: "Not this surface." },
  ];

  it("reports a variable that is present", () => {
    const r = checkEnv("worker", { NEEDED: "x", NICE: "y" }, manifest);
    expect(r.complete).toBe(true);
    expect(r.entries.every((e) => e.present)).toBe(true);
  });

  it("separates a missing required variable from a missing optional one", () => {
    const r = checkEnv("worker", {}, manifest);
    expect(r.missingRequired.map((e) => e.name)).toEqual(["NEEDED"]);
    expect(r.missingDegraded.map((e) => e.name)).toEqual(["NICE"]);
    expect(r.complete).toBe(false);
  });

  /**
   * A surface must never report another surface's environment. The worker runs
   * on Railway and the MCP on Matt's Mac, so `process.env` in one says nothing
   * about the other — two of the three known failures were worker variables
   * and the MCP would have reported them present.
   */
  it("only reports variables this surface expects", () => {
    const r = checkEnv("worker", {}, manifest);
    expect(r.entries.map((e) => e.name)).not.toContain("ELSEWHERE");
  });

  /**
   * Railway writes an empty string when a variable is created and never filled
   * in, and an empty `SEAL_API_TOKEN` authenticates exactly as badly as an
   * unset one.
   */
  it("counts an empty string as absent", () => {
    expect(checkEnv("worker", { NEEDED: "", NICE: "   " }, manifest).missingRequired).toHaveLength(1);
    expect(checkEnv("worker", { NEEDED: "", NICE: "   " }, manifest).missingDegraded).toHaveLength(1);
  });

  // The impact is what an operator acts on; the variable name is a restatement.
  it("carries what stops working, not just what is absent", () => {
    const r = checkEnv("worker", {}, manifest);
    expect(r.missingRequired[0].impact).toBe("Everything stops.");
  });
});

/**
 * No secret may appear in a log line, a tool response, or a database row.
 * This is the acceptance criterion with the worst failure mode, so it is
 * asserted against a value that would be unmistakable in output.
 */
describe("checkEnv never handles values", () => {
  const SECRET = "sk-ant-secret-value-do-not-print";

  it("keeps the value out of the result entirely", () => {
    const r = checkEnv("worker", { SEAL_API_TOKEN: SECRET });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET.slice(0, 8));
  });

  it("keeps the value out of the printed lines", () => {
    const lines = formatEnvCheck(checkEnv("worker", { SEAL_API_TOKEN: SECRET })).join("\n");
    expect(lines).not.toContain(SECRET);
    expect(lines).toContain("SEAL_API_TOKEN");
  });

  // Not even a length. A length hint narrows a secret and buys nothing.
  it("does not hint at the length", () => {
    const lines = formatEnvCheck(checkEnv("worker", { SEAL_API_TOKEN: SECRET })).join("\n");
    expect(lines).not.toMatch(new RegExp(`\\b${SECRET.length}\\b`));
  });
});

describe("formatEnvCheck", () => {
  /**
   * The whole list, not only the failures. Ten PRESENT lines and one MISSING
   * is readable; a silent pass is indistinguishable from a check that never
   * ran, which is the failure this whole issue is about.
   */
  it("prints every expected variable, present ones included", () => {
    const lines = formatEnvCheck(checkEnv("mcp", { DATABASE_URL: "x" }));
    expect(lines.some((l) => l.includes("PRESENT") && l.includes("DATABASE_URL"))).toBe(true);
    expect(lines.some((l) => l.includes("MISSING") && l.includes("ANALYTICS_DATABASE_URL"))).toBe(true);
  });

  it("heads the list with a count that cannot be mistaken for a pass", () => {
    const lines = formatEnvCheck(checkEnv("mcp", {}));
    expect(lines[0]).toMatch(/\[env:mcp\] \d+ expected, \d+ required missing, \d+ optional missing/);
  });

  it("explains the impact on the line that reports a variable missing", () => {
    const lines = formatEnvCheck(checkEnv("mcp", { DATABASE_URL: "x" }));
    const line = lines.find((l) => l.includes("ANALYTICS_DATABASE_URL"))!;
    expect(line).toMatch(/query. tool is unavailable/i);
  });
});

/**
 * ─── The manifest and the code cannot drift ───────────────────────────
 *
 * #35's acceptance: "Adding a variable to the manifest without adding it to
 * `.env.example` fails a test." The reverse matters just as much — a variable
 * the code reads and the manifest omits is exactly the gap that produced this
 * issue, and it is how GOOGLE_SERVICE_ACCOUNT_JSON went undocumented.
 */
describe("the manifest, .env.example and the code agree", () => {
  const envExample = readFileSync(join(root, ".env.example"), "utf-8");
  const declared = new Set(
    [...envExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1])
  );

  it("finds variables in .env.example at all", () => {
    // A parse that matches nothing would make every assertion below vacuous.
    expect(declared.size).toBeGreaterThan(10);
  });

  it("declares every manifest variable in .env.example", () => {
    const undocumented = ENV_MANIFEST.map((v) => v.name).filter((n) => !declared.has(n));
    expect(undocumented, `in the manifest but not .env.example: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("has a manifest entry for every variable .env.example declares", () => {
    const known = new Set(ENV_MANIFEST.map((v) => v.name));
    const unexplained = [...declared].filter((n) => !known.has(n));
    expect(unexplained, `in .env.example but not the manifest: ${unexplained.join(", ")}`).toEqual([]);
  });

  /**
   * The one that would have caught the original bugs: a variable the code
   * reads that nothing describes. Greps the real source rather than a list
   * someone maintains, because a maintained list drifts the same way.
   */
  it("has a manifest entry for every variable the code reads", () => {
    const used = execSync(
      `grep -rhoE 'process\\.env\\.[A-Z0-9_]+|getEnvOptional\\("[A-Z0-9_]+"\\)|requireEnv\\("[A-Z0-9_]+"\\)' src app | grep -oE '[A-Z0-9_]{4,}' | sort -u`,
      { cwd: root, encoding: "utf-8" }
    )
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      // Node's own, and the ones a test or build sets rather than an operator.
      .filter((n) => !["NODE_ENV", "JOB_TMP", "TZ", "CI"].includes(n));

    expect(used.length, "the grep found no variables, so this check is vacuous").toBeGreaterThan(10);

    const known = new Set(ENV_MANIFEST.map((v) => v.name));
    const undescribed = used.filter((n) => !known.has(n));
    expect(undescribed, `read by the code but not in the manifest: ${undescribed.join(", ")}`).toEqual([]);
  });

  it("gives every variable a surface and an impact", () => {
    for (const v of ENV_MANIFEST) {
      expect(v.surfaces.length, `${v.name} has no surface`).toBeGreaterThan(0);
      expect(v.impact.length, `${v.name} has no impact`).toBeGreaterThan(20);
      // "X is missing" restates the problem rather than describing it.
      expect(v.impact, `${v.name}'s impact just names the variable`).not.toMatch(
        new RegExp(`^${v.name} is `)
      );
    }
  });

  it("names DATABASE_URL required on every surface", () => {
    const db = ENV_MANIFEST.find((v) => v.name === "DATABASE_URL")!;
    expect(db.severity).toBe("required");
    expect(db.surfaces.sort()).toEqual(["mcp", "web", "worker"]);
  });
});

/**
 * ─── What gets stored, and what a reader makes of it ──────────────────
 */
describe("toStoredVariables", () => {
  const SECRET = "sk-ant-secret-value-do-not-print";

  /**
   * The analytics role can read this table, so it has to be safe to expose by
   * construction rather than by review. The impact text is dropped too — not
   * because it is secret, but because a row that carries anything beyond a
   * name and a flag invites the next field to be a value.
   */
  it("stores names and flags and nothing else", () => {
    const stored = toStoredVariables(checkEnv("worker", { SEAL_API_TOKEN: SECRET }));
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    for (const row of stored) {
      expect(Object.keys(row).sort()).toEqual(["name", "present"]);
    }
  });

  it("stores every expected variable, present ones included", () => {
    const stored = toStoredVariables(checkEnv("mcp", { DATABASE_URL: "x" }));
    expect(stored.find((v) => v.name === "DATABASE_URL")!.present).toBe(true);
    expect(stored.find((v) => v.name === "ANALYTICS_DATABASE_URL")!.present).toBe(false);
  });
});

describe("describeEnvRecord", () => {
  const NOW = new Date("2026-09-18T12:00:00Z");
  const recent = new Date("2026-09-18T06:00:00Z");

  const record = (variables: StoredEnvVariable[], recordedAt = recent) => ({
    recordedAt,
    variables,
    missingRequired: variables.filter((v) => !v.present).length,
  });

  /**
   * The single most likely state on the day this ships. CLAUDE.md: no-run is
   * UNKNOWN, never PASS — reading an empty table as healthy would ship the
   * exact bug this issue exists to fix.
   */
  it("reports UNKNOWN when no check has ever been recorded", () => {
    const r = describeEnvRecord("worker", null, NOW);
    expect(r.status).toBe("unknown");
    expect(r.recordedAt).toBeNull();
    expect(r.detail).toMatch(/not the same as nothing being missing/);
  });

  it("reports ok when everything is present", () => {
    const r = describeEnvRecord("worker", record([{ name: "SEAL_API_TOKEN", present: true }]), NOW);
    expect(r.status).toBe("ok");
    expect(r.missing).toEqual([]);
  });

  it("reports degraded when an optional variable is unset", () => {
    const r = describeEnvRecord("worker", record([{ name: "SEAL_API_TOKEN", present: false }]), NOW);
    expect(r.status).toBe("degraded");
    expect(r.missing).toEqual(["SEAL_API_TOKEN"]);
  });

  // A surface missing something it cannot run without is not merely degraded.
  it("reports broken when a required variable is unset", () => {
    const r = describeEnvRecord("worker", record([{ name: "DATABASE_URL", present: false }]), NOW);
    expect(r.status).toBe("broken");
    expect(r.detail).toMatch(/cannot run without/);
  });

  /**
   * A recorded check is evidence about the process that wrote it. The worker
   * redeploys often, so a record from last month describes a process that no
   * longer exists — and reading it as current is how a fixed variable looks
   * broken and a broken one looks fixed.
   */
  it("reports a stale record as unknown rather than as current", () => {
    const old = new Date("2026-09-01T12:00:00Z");
    const r = describeEnvRecord("worker", record([{ name: "SEAL_API_TOKEN", present: true }], old), NOW);
    expect(r.stale).toBe(true);
    expect(r.status).toBe("unknown");
    expect(r.detail).toMatch(/probably been replaced/);
  });

  it("does not call a record from this morning stale", () => {
    const r = describeEnvRecord("worker", record([{ name: "SEAL_API_TOKEN", present: true }]), NOW);
    expect(r.stale).toBe(false);
    expect(r.ageHours).toBeCloseTo(6, 1);
  });

  /**
   * Staleness outranks content. A stale record showing everything present is
   * the most misleading state available, because it reads as a clean bill of
   * health for a process nobody has checked.
   */
  it("calls a stale all-present record unknown, not ok", () => {
    const old = new Date("2026-08-01T12:00:00Z");
    const r = describeEnvRecord(
      "worker",
      record([{ name: "SEAL_API_TOKEN", present: true }], old),
      NOW
    );
    expect(r.status).toBe("unknown");
  });
});
