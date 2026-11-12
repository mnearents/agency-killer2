/**
 * Where the reel downloader is called from, and where it must never be.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { routeCommand } from "@/worker/slack/router";

const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");

describe("reel downloads", () => {
  // Off unless switched on: three calls a month are easily spent by a cron.
  it("reach the daily sync only when automatic downloads are switched on", () => {
    expect(worker).toMatch(/downloads: reelDownloader && autoDownloads \? \{ downloader: reelDownloader, limits: downloadLimits \} : undefined/);
    expect(worker).toMatch(/const autoDownloads = getEnvOptional\("REEL_AUTO_DOWNLOAD"\) === "on"/);
  });

  it("run on request from Slack", () => {
    expect(routeCommand({ type: "command", category: "sync", action: "reels", args: "tara 1", raw: "!sync reels tara 1" }).handler).toBe("sync:reels");
    expect(worker).toMatch(/"sync:reels": async \(args\) => \{[\s\S]*?runReelDownloads\(/);
  });

  // The key stays on the worker: no connector can reach the downloader.
  it("are never reachable through the MCP server", () => {
    const files = readdirSync(join(process.cwd(), "src/mcp")).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), "src/mcp", f), "utf-8");
      expect(src, f).not.toMatch(/reel-downloader|reel-backfill|RAPIDAPI_KEY/);
    }
  });
});
