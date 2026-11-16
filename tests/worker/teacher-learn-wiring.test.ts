/**
 * The teacher video handler's call sites. A route to a handler that is not
 * registered answers "isn't wired up yet" — the link would be acknowledged
 * and never saved. Source assertions: the handlers close over live clients.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");
const app = readFileSync(join(process.cwd(), "src/worker/slack/app.ts"), "utf-8");
const handler = worker.slice(worker.indexOf("const slackHandlers")).match(/"teacher:learn": async \((\w+)\) => \{[\s\S]*?\n    \},/);

describe("teacher:learn wiring", () => {
  it("is a Slack handler that parses the message and saves each link", () => {
    expect(handler, "no teacher:learn entry in slackHandlers").not.toBeNull();
    expect(handler![0]).toMatch(new RegExp(`parseLearnMessage\\(${handler![1]}\\)`));
    expect(handler![0]).toMatch(/learnFromVideo\(\{[\s\S]*downloader: reelDownloader[\s\S]*limits: downloadLimits[\s\S]*\}, \{ link, username: request\.username, note: request\.note, savedBy: "slack" \}\)/);
    expect(handler![0]).toMatch(/describeLearnResult\(link, result\)/);
  });

  // Saving takes a minute or two; without an acknowledgement a pasted link looks ignored.
  it("acknowledges a link straight away, and is in the help", () => {
    expect(app).toMatch(/"teacher:learn": "Got it/);
    expect(app).toMatch(/Paste an Instagram link \(or `!learn <link> \[@creator\] \[why\]`\)/);
  });
});
