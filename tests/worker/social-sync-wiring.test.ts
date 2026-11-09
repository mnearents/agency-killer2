/**
 * The social sync's call sites.
 *
 * The cron and `!sync social` used to call `syncSocialPosts` separately, and
 * neither handed it an Anthropic client — so the post analysis the weekly
 * review depends on would have been built, tested, and never run. One shared
 * task, given every client, called from both places.
 *
 * Source assertions rather than an executed handler: the worker's handlers
 * close over live clients built at startup.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");

const slackHandlers = worker.slice(worker.indexOf("const slackHandlers"));
const slackSocial = slackHandlers.match(/"sync:social": async \((\w*)\) => \{[\s\S]*?\n    \},/);
const scheduledSocial = worker
  .slice(worker.indexOf("const handlerFns"), worker.indexOf("const slackHandlers"))
  .match(/"sync:social": async \(\) =>[\s\S]*?\n    },?\n/);
const task = worker.match(/const runSocialSync = async \([\s\S]*?\n  \};/);

describe("sync:social wiring", () => {
  it("runs the shared task from the scheduler and from Slack", () => {
    expect(scheduledSocial?.[0]).toMatch(/runSocialSync\(\)/);
    expect(slackSocial?.[0]).toMatch(/runSocialSync\(/);
  });

  it("gives the sync the Anthropic client, so posts are analysed", () => {
    expect(task?.[0]).toMatch(/anthropic: anthropicClient \?\? undefined/);
  });

  it("records the run inside the shared task", () => {
    expect(task?.[0]).toMatch(/recorded\("sync:social"/);
  });

  // `!sync social 100` reaches back past the daily window to fill the
  // baseline. A handler that ignores its argument syncs 20 and says done.
  it("passes a post count from Slack through to the sync", () => {
    const param = slackSocial?.[1];
    expect(param, "the Slack handler takes no argument").toBeTruthy();
    expect(slackSocial?.[0]).toMatch(new RegExp(`parseInt\\(${param}`));
    expect(task?.[0]).toMatch(/syncSocialPosts\([\s\S]*?\},\s*limit,?\s*\)/);
  });
});
