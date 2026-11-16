/**
 * The photo index's call sites.
 *
 * It rides on the daily footage cron, so a footage handler that stopped
 * calling it would leave the photos quietly stale with every footage run
 * green. And describing costs money, so the cron must describe only when
 * PHOTO_VISION is on, while `!sync photos describe` asks for it outright.
 *
 * Source assertions rather than an executed handler: the worker's handlers
 * close over live clients built at startup.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");
const router = readFileSync(join(process.cwd(), "src/worker/slack/router.ts"), "utf-8");

const scheduledFootage = worker
  .slice(worker.indexOf("const handlerFns"), worker.indexOf("const slackHandlers"))
  .match(/"sync:footage": async \(\) =>[\s\S]*?\n    },?\n/);
const slackPhotos = worker.slice(worker.indexOf("const slackHandlers")).match(/"sync:photos": async \((\w*)\) => \{[\s\S]*?\n    \},/);
const task = worker.match(/const runPhotoSync = async \([\s\S]*?\n  \};/);

describe("sync:photos wiring", () => {
  it("runs after the footage sync in the daily cron, even when footage fails", () => {
    expect(scheduledFootage?.[0]).toMatch(/try \{\s*await runFootageSync\(\);\s*\} finally \{\s*await runPhotoSync\(\);\s*\}/);
  });

  it("records its own run, so data_freshness can say when photos were last indexed", () => {
    expect(task?.[0]).toMatch(/recorded\("sync:photos"/);
  });

  it("describes on the schedule only with PHOTO_VISION=on", () => {
    expect(worker).toMatch(/const photoVisionOn = getEnvOptional\("PHOTO_VISION"\) === "on";/);
    expect(task?.[0]).toMatch(/describe: options\.describe \?\? \{ enabled: photoVisionOn \}/);
  });

  it("has a Slack route and handler that runs the shared task, passing describe through", () => {
    expect(router).toMatch(/photos: "sync:photos"/);
    expect(slackPhotos, "no sync:photos entry in slackHandlers").not.toBeNull();
    expect(slackPhotos?.[0]).toMatch(/describe = \{ enabled: true, limit: n \}/);
    expect(slackPhotos?.[0]).toMatch(/runPhotoSync\(\{ describe \}\)/);
  });
});
