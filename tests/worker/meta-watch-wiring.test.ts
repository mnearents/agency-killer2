/**
 * The ad account watch's call sites.
 *
 * The watch exists to notice what nobody announced, so it is the worst thing
 * to have silently not running. Three call sites: the 3-hour schedule, a run
 * at startup — so every deploy proves the token still reads the account
 * rather than leaving a three-hour gap healthchecks.io would read as an
 * outage — and `!ads watch`. All three must run the same shared task, which
 * is the one that pings the heartbeat and records the run.
 *
 * Source assertions rather than an executed handler: the worker's handlers
 * close over live clients built at startup.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");
const scheduled = worker
  .slice(worker.indexOf("const handlerFns"), worker.indexOf("const slackHandlers"))
  .match(/"watch:meta": async \(\) =>[\s\S]*?\n    },?\n/);
const slack = worker.slice(worker.indexOf("const slackHandlers")).match(/"watch:meta": async \(\) => \{[\s\S]*?\n    \},/);
const task = worker.match(/const runMetaWatchTask = async \([\s\S]*?\n  \};/);
const afterReady = worker.slice(worker.indexOf('console.log("[worker] Ready.")'));

describe("watch:meta wiring", () => {
  it("runs the shared task on the schedule", () => {
    expect(scheduled?.[0]).toMatch(/runMetaWatchTask\(\)/);
  });

  it("runs the shared task from Slack", () => {
    expect(slack?.[0]).toMatch(/runMetaWatchTask\(\)/);
  });

  it("runs the shared task once at startup, after the worker is ready", () => {
    expect(afterReady).toMatch(/runMetaWatchTask\(\)/);
  });

  it("records the run and pings the heartbeat inside the shared task", () => {
    expect(task, "no runMetaWatchTask found").not.toBeNull();
    expect(task![0]).toMatch(/recorded\(META_WATCH_TASK/);
    expect(task![0]).toMatch(/runMetaWatch\(/);
    expect(task![0]).toMatch(/heartbeat/);
  });

  // Not configured is not quiet: nobody is watching, and healthchecks.io
  // must say so.
  it("fails the heartbeat when the token or account is missing", () => {
    expect(task![0]).toMatch(/[Hh]eartbeat\.fail\(/);
  });
});
