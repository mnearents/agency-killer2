import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ENV_MANIFEST,
  requirementsFor,
  SURFACES,
  type Surface,
} from "@/lib/env-manifest";
import { checkEnv, formatEnvCheck } from "@/lib/env-check";

const NOW = new Date("2026-09-08T12:00:00Z");

describe("ENV_MANIFEST", () => {
  it("names every variable exactly once", () => {
    const names = ENV_MANIFEST.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("assigns every variable to at least one surface", () => {
    for (const r of ENV_MANIFEST) {
      expect(r.surfaces.length, r.name).toBeGreaterThan(0);
      for (const s of r.surfaces) expect(SURFACES, r.name).toContain(s);
    }
  });

  // "ANALYTICS_DATABASE_URL is missing" tells you nothing you can act on.
  // "the query tool is unavailable" is the sentence that makes someone fix it.
  it("says what breaks, not just what is absent", () => {
    for (const r of ENV_MANIFEST) {
      expect(r.breaks.trim(), r.name).not.toBe("");
      expect(r.breaks, r.name).not.toContain(r.name);
    }
  });

  // The manifest and .env.example drifting apart is how a variable becomes
  // invisible: nobody sets what they never saw documented.
  it("documents every variable in .env.example", () => {
    const example = fs.readFileSync(
      path.join(process.cwd(), ".env.example"),
      "utf8"
    );
    const documented = new Set(
      example
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split("=")[0].trim())
    );
    const undocumented = ENV_MANIFEST.map((r) => r.name).filter(
      (n) => !documented.has(n)
    );
    expect(undocumented).toEqual([]);
  });

  it("requires the three variables that have already shipped unset", () => {
    const byName = new Map(ENV_MANIFEST.map((r) => [r.name, r]));
    // The whole reason this module exists. Each of these was absent in
    // production while everything downstream reported healthy.
    expect(byName.get("SEAL_API_TOKEN")?.surfaces).toContain("worker");
    expect(byName.get("META_AD_ACCOUNT_ID")?.surfaces).toContain("worker");
    expect(byName.get("ANALYTICS_DATABASE_URL")?.surfaces).toContain("mcp");
    for (const n of ["SEAL_API_TOKEN", "META_AD_ACCOUNT_ID", "ANALYTICS_DATABASE_URL"]) {
      expect(byName.get(n)?.severity, n).not.toBe("optional");
    }
  });

  it("scopes each surface to the variables that surface actually reads", () => {
    // The MCP does not sync anything; the worker does not serve the query tool.
    const mcp = requirementsFor("mcp").map((r) => r.name);
    expect(mcp).toContain("ANALYTICS_DATABASE_URL");
    expect(mcp).not.toContain("SEAL_API_TOKEN");
    expect(requirementsFor("worker").map((r) => r.name)).toContain("SEAL_API_TOKEN");
  });
});

describe("checkEnv", () => {
  const surface: Surface = "worker";

  function envWithAll(over: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {};
    for (const r of requirementsFor(surface)) env[r.name] = "set";
    return { ...env, ...over };
  }

  it("reports every expected variable, not only the missing ones", () => {
    const r = checkEnv(surface, envWithAll(), NOW);
    expect(r.variables).toHaveLength(requirementsFor(surface).length);
    expect(r.variables.every((v) => v.present)).toBe(true);
  });

  it("reports a clean check as ok with nothing missing", () => {
    const r = checkEnv(surface, envWithAll(), NOW);
    expect(r.ok).toBe(true);
    expect(r.missingRequired).toEqual([]);
    expect(r.missingDegraded).toEqual([]);
  });

  // Railway lets you save a variable with an empty value. It is present in
  // process.env, it is falsy at every use site, and it looks configured in the
  // dashboard — the worst of both states.
  it("treats an empty value as missing, not as present", () => {
    const r = checkEnv(surface, envWithAll({ SEAL_API_TOKEN: "" }), NOW);
    expect(r.missingDegraded).toContain("SEAL_API_TOKEN");
    expect(r.variables.find((v) => v.name === "SEAL_API_TOKEN")?.present).toBe(false);
  });

  it("treats a whitespace-only value as missing", () => {
    const r = checkEnv(surface, envWithAll({ SEAL_API_TOKEN: "   " }), NOW);
    expect(r.missingDegraded).toContain("SEAL_API_TOKEN");
  });

  it("separates a missing required variable from a missing degraded one", () => {
    const r = checkEnv(
      surface,
      envWithAll({ DATABASE_URL: undefined, SEAL_API_TOKEN: undefined }),
      NOW
    );
    expect(r.missingRequired).toEqual(["DATABASE_URL"]);
    expect(r.missingDegraded).toContain("SEAL_API_TOKEN");
    expect(r.ok).toBe(false);
  });

  // An optional variable has a working default. Counting its absence as a
  // problem produces a permanent warning, and a permanent warning is one
  // nobody reads — which is how the three real ones stayed invisible.
  it("does not count an absent optional variable as a problem", () => {
    const optional = ENV_MANIFEST.find(
      (r) => r.severity === "optional" && r.surfaces.includes(surface)
    );
    expect(optional, "manifest should have at least one optional var").toBeDefined();
    const r = checkEnv(surface, envWithAll({ [optional!.name]: undefined }), NOW);
    expect(r.ok).toBe(true);
    expect(r.missingRequired).not.toContain(optional!.name);
    expect(r.missingDegraded).not.toContain(optional!.name);
    // Still reported, so the list is the whole truth.
    expect(r.variables.find((v) => v.name === optional!.name)?.present).toBe(false);
  });

  it("stamps the check with the time it ran", () => {
    expect(checkEnv(surface, envWithAll(), NOW).checkedAt).toEqual(NOW);
  });

  // The result is logged, written to the database and returned through an MCP
  // tool. A value leaking into any of those is a credential leak.
  it("never carries a value anywhere in its result", () => {
    const secret = "sk-live-THIS-MUST-NEVER-APPEAR";
    const r = checkEnv(surface, envWithAll({ SEAL_API_TOKEN: secret }), NOW);
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

describe("formatEnvCheck", () => {
  const surface: Surface = "mcp";

  function env(over: Record<string, string | undefined> = {}) {
    const e: Record<string, string | undefined> = {};
    for (const r of requirementsFor(surface)) e[r.name] = "set";
    return { ...e, ...over };
  }

  it("prints one line per expected variable", () => {
    const lines = formatEnvCheck(checkEnv(surface, env(), NOW));
    for (const r of requirementsFor(surface)) {
      expect(lines.join("\n")).toContain(r.name);
    }
  });

  it("marks a present variable present and a missing one missing", () => {
    const lines = formatEnvCheck(
      checkEnv(surface, env({ ANALYTICS_DATABASE_URL: undefined }), NOW)
    ).join("\n");
    expect(lines).toMatch(/MISSING.*ANALYTICS_DATABASE_URL|ANALYTICS_DATABASE_URL.*MISSING/);
    expect(lines).toMatch(/PRESENT.*DATABASE_URL|DATABASE_URL.*PRESENT/);
  });

  it("says what breaks on the line for a missing variable", () => {
    const lines = formatEnvCheck(
      checkEnv(surface, env({ ANALYTICS_DATABASE_URL: undefined }), NOW)
    );
    const line = lines.find((l) => l.includes("ANALYTICS_DATABASE_URL"))!;
    const breaks = ENV_MANIFEST.find((r) => r.name === "ANALYTICS_DATABASE_URL")!.breaks;
    expect(line).toContain(breaks);
  });

  it("never prints a value", () => {
    const secret = "postgres://user:HUNTER2@host/db";
    const lines = formatEnvCheck(
      checkEnv(surface, env({ ANALYTICS_DATABASE_URL: secret }), NOW)
    ).join("\n");
    expect(lines).not.toContain("HUNTER2");
    expect(lines).not.toContain(secret);
  });
});
