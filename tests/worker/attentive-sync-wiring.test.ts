/**
 * The Attentive sync's call sites.
 *
 * The parsers and imports in `domain/attentive/` are covered by their own
 * tests and would pass forever with nothing calling them. What is asserted
 * here is that the worker actually exports the four new reports, imports each
 * one, and records the run — the wiring, which is the part that has repeatedly
 * been missing in this repo.
 *
 * Source assertions rather than an executed task: the handler needs a live
 * Playwright browser and an Attentive login. Each one is anchored at the shape
 * that would break, not at a mention of a name.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");
const agent = readFileSync(
  join(process.cwd(), "src/integrations/attentive-agent.ts"),
  "utf-8"
);

/** The sync:attentive handler body, so a match elsewhere in the file cannot pass. */
const handler = worker.match(/"sync:attentive": async \(\) => \{[\s\S]*?\n    \},/);

describe("sync:attentive handler", () => {
  it("exists", () => {
    expect(handler, "no sync:attentive handler found in the worker").not.toBeNull();
  });

  it.each([
    ["campaignMessageCsv", "importCampaignMessages"],
    ["campaignSegmentCsv", "importCampaignSegments"],
    ["journeyMessageCsv", "importJourneyMessages"],
    ["messageCostCsv", "importMessageCosts"],
  ])("imports %s through %s", (csvField, importer) => {
    // Both in one assertion: an importer called with the wrong CSV is the bug
    // this catches, and it would satisfy two separate "is it mentioned" checks.
    expect(handler![0]).toMatch(
      new RegExp(`exportResult\\.${csvField},[^)]*${importer}`, "s")
    );
  });

  /**
   * Without a `sync_runs` row, a run that errored, a run that found nothing
   * and a run that never happened are indistinguishable afterwards. That is
   * how `meta_insights` sat empty for months (#54), and this sync had no row
   * at all until now.
   */
  it("records the run in sync_runs", () => {
    expect(handler![0]).toMatch(/insert\(syncRuns\)/);
    expect(handler![0]).toMatch(/task: "sync:attentive"/);
  });

  it("classifies the outcome from the failures, not from the row count alone", () => {
    expect(handler![0]).toMatch(/classifyOutcome\(\{[\s\S]*?error: failures\[0\]/);
  });

  // An export that failed and an import that rejected rows are both failures
  // of the sync, and folding only one into the outcome hides the other.
  it("counts import errors as failures, not only export errors", () => {
    expect(handler![0]).toMatch(/\[\.\.\.exportResult\.errors,\s*\.\.\.importErrors\]/);
  });
});

describe("attentive agent report coverage", () => {
  it.each([
    ["campaign-aggregate-performance-aggregate-group", "campaign message"],
    ["campaign-performance-by-segment", "campaign segment"],
    ["journeys-message-level-performance-v2", "journey message"],
    ["daily-message-cost", "message cost"],
  ])("exports the %s report", (slug) => {
    expect(agent).toContain(slug);
  });

  /**
   * Attentive renders in-app marketing popups into `#engagement-wrapper`, and
   * they sit over the Export button. Playwright reports the button "visible,
   * enabled and stable" and then retries the click for thirty seconds while
   * the popup swallows every one, so the report fails with a click timeout
   * that names nothing.
   *
   * Hit on all six reports on 2026-09-18. The popups are dismissible and
   * therefore intermittent, which is worse than constant — the sync works
   * until the day someone is shown one.
   */
  it("clears in-app popups before clicking Export", () => {
    const exportFn = agent.match(/async function exportReport\([\s\S]*?\n\}/);
    expect(exportFn, "no exportReport function found").not.toBeNull();
    const dismissAt = exportFn![0].search(/dismissOverlays\(page\)/);
    const clickAt = exportFn![0].search(/page\.click\('button:has-text\("Export"\)'\)/);
    expect(dismissAt, "exportReport never dismisses overlays").toBeGreaterThan(-1);
    expect(clickAt).toBeGreaterThan(-1);
    // Dismissing after the click would be decoration.
    expect(dismissAt).toBeLessThan(clickAt);
  });

  it("removes the engagement wrapper the popups render into", () => {
    expect(agent).toMatch(/getElementById\("engagement-wrapper"\)/);
    expect(agent).toMatch(/querySelectorAll\("\[data-engagement\]"\)/);
  });

  /**
   * One report failing must not cost the other five. The reports are exported
   * in a loop with the error recorded per report, so a partial export is a
   * partial export rather than nothing.
   */
  it("keeps every report's failure separate", () => {
    expect(agent).toMatch(/errors\.push\(`\$\{name\} export failed/);
  });
});
