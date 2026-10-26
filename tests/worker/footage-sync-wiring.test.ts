/**
 * The footage sync's call sites.
 *
 * `!sync footage` has to run the same code the 14:10 cron runs, and record the
 * run the same way. A Slack handler with its own copy of the call would drift
 * from the scheduled one; one that is missing makes the route a dead end.
 *
 * Source assertions rather than an executed handler: the worker's handlers
 * close over live clients built at startup.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");

const slackHandlers = worker.slice(worker.indexOf("const slackHandlers"));
const slackFootage = slackHandlers.match(/"sync:footage": async \(\) => \{[\s\S]*?\n    \},/);
const scheduledFootage = worker
  .slice(worker.indexOf("const handlerFns"), worker.indexOf("const slackHandlers"))
  .match(/"sync:footage": async \(\) =>[\s\S]*?\n    },?\n/);

describe("sync:footage wiring", () => {
  it("has a Slack handler", () => {
    expect(slackFootage, "no sync:footage entry in slackHandlers").not.toBeNull();
  });

  it("runs the shared footage task from Slack", () => {
    expect(slackFootage?.[0]).toMatch(/runFootageSync\(\)/);
  });

  it("runs the shared footage task from the scheduler", () => {
    expect(scheduledFootage?.[0]).toMatch(/runFootageSync\(\)/);
  });

  // The shared task is what records the run; the cron's own wrapper must not
  // be the only place that happens.
  it("records the run inside the shared task", () => {
    const task = worker.match(/const runFootageSync = async \(\)[\s\S]*?\n  \};/);
    expect(task, "no runFootageSync found").not.toBeNull();
    expect(task![0]).toMatch(/recorded\("sync:footage"/);
  });
});
