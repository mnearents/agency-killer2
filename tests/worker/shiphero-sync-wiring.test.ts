/**
 * The ShipHero sync at its call sites. syncShipHero is covered on its own in
 * tests/domain/economics/shiphero-sync.test.ts and would pass forever with
 * nothing calling it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPhase1Tasks, getTaskHandlerMap } from "@/worker/tasks/registry";
import { routeCommand } from "@/worker/slack/router";
import { FRESHNESS_SOURCES } from "@/db/freshness";
import { ENV_MANIFEST } from "@/config/env-manifest";

const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");

describe("sync:shiphero wiring", () => {
  it("runs syncShipHero with the ShipHero client, recorded as sync:shiphero, and probes billing", () => {
    const shared = worker.match(/const runShipHeroSync = async[\s\S]*?\n  \};/);
    expect(shared, "no runShipHeroSync").not.toBeNull();
    expect(shared![0]).toMatch(/recorded\("sync:shiphero"/);
    expect(shared![0]).toMatch(/syncShipHero\(\{ db, client: shipheroClient/);
    expect(shared![0]).toMatch(/backfillShipHeroRange\(/);
    expect(shared![0]).toMatch(/dailyShipHeroRange\(/);
    expect(shared![0]).toMatch(/probe\("bills"\)/);
    expect(shared![0]).toMatch(/probe\("fulfillment_invoices"\)/);
    expect(shared![0]).toMatch(/task: SHIPHERO_BILLING_PROBE_TASK/);
  });

  it("builds the client from the refresh token and logs every throttle", () => {
    expect(worker).toMatch(/createShipHeroClient\(\{\s*refreshToken: getEnv\("SHIPHERO_REFRESH_TOKEN"\)/);
    expect(worker).toMatch(/onThrottle: \(e\) => \{\s*shipheroThrottles\.push\(e\);\s*console\.error/);
  });

  it("is called daily by the scheduler and by !sync shiphero, which takes backfill", () => {
    expect(worker).toMatch(/"sync:shiphero": async \(\) => \{\s*await runShipHeroSync\("daily"\);/);
    expect(worker).toMatch(/"sync:shiphero": async \(args\) => \{[\s\S]*?"backfill"[\s\S]*?await runShipHeroSync\(mode\)/);
  });

  it("is scheduled daily and mapped to its handler", () => {
    const task = getPhase1Tasks().find((t) => t.id === "shiphero-sync");
    expect(task?.enabled).toBe(true);
    expect(task?.schedule.type).toBe("daily");
    expect(getTaskHandlerMap()["shiphero-sync"]).toBe("sync:shiphero");
  });

  it("answers !sync shiphero", () => {
    expect(routeCommand({ type: "command", category: "sync", action: "shiphero", args: "backfill", raw: "!sync shiphero backfill" }).handler).toBe("sync:shiphero");
  });

  it("is the run data_freshness reads for the labels", () => {
    const source = FRESHNESS_SOURCES.find((s) => s.name === "shiphero_labels");
    expect(source && "task" in source ? source.task : null).toBe("sync:shiphero");
  });

  it("names its token in the environment manifest, for the worker only", () => {
    const entry = ENV_MANIFEST.find((e) => e.name === "SHIPHERO_REFRESH_TOKEN");
    expect(entry?.surfaces).toEqual(["worker"]);
  });

  // The MCP surface reads the stored rows; it has no business reaching ShipHero.
  it("nothing in src/mcp imports the ShipHero client", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    expect(execSync("grep -rl 'shiphero-api' src/mcp || true", { encoding: "utf-8" }).trim()).toBe("");
  });
});
