/**
 * `getEnvHealth` and its call sites (#35).
 *
 * The pure logic is covered in `tests/config/env-manifest.test.ts`. What is
 * asserted here is the wiring, which is the part that has repeatedly been
 * missing in this repo: that the worker records its check at boot, that the
 * MCP prints its own, and that `data_freshness` reports both — because a
 * manifest nothing reads is exactly the kind of tested, green, inert feature
 * this issue exists to prevent.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getEnvHealth, anyEnvProblem } from "@/db/env-health";
import type { Db } from "@/db/client";

const NOW = new Date("2026-09-18T12:00:00Z");

/** A db whose `env_checks` read returns whatever is handed in. */
function dbReturning(rows: unknown[]): Db {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }),
  } as unknown as Db;
}

/** A db whose read throws, which is not the same as one with no row. */
function dbThrowing(): Db {
  return {
    select: () => {
      throw new Error("connection refused");
    },
  } as unknown as Db;
}

describe("getEnvHealth", () => {
  it("reports the MCP from this process rather than from the database", async () => {
    const reports = await getEnvHealth(dbReturning([]), NOW, { DATABASE_URL: "x" });
    const mcp = reports.find((r) => r.surface === "mcp")!;
    expect(mcp.missing).toContain("ANALYTICS_DATABASE_URL");
    expect(mcp.missing).not.toContain("DATABASE_URL");
  });

  /**
   * The worker runs on Railway and the MCP on Matt's Mac, so reading
   * `process.env` for the worker would report the MCP's environment under the
   * worker's name. Two of the three variables that shipped unset were the
   * worker's, and that mistake would have reported them present.
   */
  it("reports the worker from its recorded row, not from this process", async () => {
    const reports = await getEnvHealth(
      dbReturning([
        {
          recordedAt: new Date("2026-09-18T06:00:00Z"),
          variables: [{ name: "SEAL_API_TOKEN", present: false }],
          missingRequired: 0,
        },
      ]),
      NOW,
      { SEAL_API_TOKEN: "set-here-but-not-there" }
    );
    const worker = reports.find((r) => r.surface === "worker")!;
    expect(worker.status).toBe("degraded");
    expect(worker.missing).toEqual(["SEAL_API_TOKEN"]);
  });

  /**
   * The single most likely state the day this ships. An empty table must not
   * read as a clean bill of health.
   */
  it("reports UNKNOWN for a worker that has never recorded a check", async () => {
    const reports = await getEnvHealth(dbReturning([]), NOW, {});
    const worker = reports.find((r) => r.surface === "worker")!;
    expect(worker.status).toBe("unknown");
    expect(worker.detail).toMatch(/has ever recorded an environment check/);
  });

  /**
   * A read that threw and a table with no row leave us equally without
   * evidence, so both report unknown — but neither may take the whole
   * freshness response down with it.
   */
  it("survives a failed read and still reports unknown", async () => {
    const reports = await getEnvHealth(dbThrowing(), NOW, {});
    expect(reports.find((r) => r.surface === "worker")!.status).toBe("unknown");
  });

  /**
   * Nothing on the web surface records a check, so inventing an "ok" for it
   * would be the exact failure this issue is about.
   */
  it("does not report a surface that records nothing", async () => {
    const reports = await getEnvHealth(dbReturning([]), NOW, {});
    expect(reports.map((r) => r.surface)).not.toContain("web");
  });
});

describe("anyEnvProblem", () => {
  it("is true when a surface is unknown", () => {
    expect(anyEnvProblem([{ status: "unknown" } as never])).toBe(true);
  });

  it("is true when a surface is degraded", () => {
    expect(anyEnvProblem([{ status: "degraded" } as never])).toBe(true);
  });

  it("is false only when every surface is ok", () => {
    expect(anyEnvProblem([{ status: "ok" } as never, { status: "ok" } as never])).toBe(false);
  });
});

/**
 * ─── The call sites ───────────────────────────────────────────────────
 */
describe("the worker records its check at boot", () => {
  const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");

  it("runs the check for its own surface", () => {
    expect(worker).toMatch(/checkEnv\("worker", process\.env\)/);
  });

  it("writes it to env_checks", () => {
    expect(worker).toMatch(/insert\(envChecks\)/);
    expect(worker).toMatch(/surface: "worker"/);
  });

  // The row must never carry a value, and `toStoredVariables` is the one
  // place that rule is enforced.
  it("stores only what toStoredVariables allows", () => {
    expect(worker).toMatch(/variables: toStoredVariables\(envCheck\)/);
  });

  /**
   * Failing to RECORD a check is not a reason to refuse to run, and the stale
   * timestamp left behind is itself the signal — an old record reads unknown.
   */
  it("does not make a failed write fatal", () => {
    const block = worker.match(
      /try \{[\s\S]{0,1400}?insert\(envChecks\)[\s\S]{0,1400}?\n  \} catch[\s\S]{0,600}?\n  \}/
    );
    expect(block, "the env_checks write is not inside a try/catch").not.toBeNull();
    expect(block![0]).not.toMatch(/process\.exit/);
  });

  // A degraded boot styled as routine reads as routine.
  it("routes an incomplete environment through stderr", () => {
    expect(worker).toMatch(/if \(envCheck\.complete\) console\.log\(line\);\s*\n\s*else console\.error\(line\);/);
  });
});

describe("the MCP prints its check", () => {
  const mcp = readFileSync(join(process.cwd(), "src/mcp/index.ts"), "utf-8");

  it("runs the check for its own surface", () => {
    expect(mcp).toMatch(/checkEnv\("mcp", process\.env\)/);
  });

  /**
   * stdout is the JSON-RPC channel. A single stray line there breaks the
   * handshake, which is why `--silent` is load-bearing in the pnpm command.
   */
  it("writes only to stderr", () => {
    const block = mcp.match(/for \(const line of formatEnvCheck[\s\S]{0,200}?\n  \}/);
    expect(block, "no env-check loop found in the MCP entry point").not.toBeNull();
    expect(block![0]).toMatch(/console\.error\(line\)/);
    expect(block![0]).not.toMatch(/console\.log/);
  });
});
