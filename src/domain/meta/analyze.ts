/**
 * Meta ads analysis — the full pipeline from DB to AI-generated recommendations.
 *
 * Reads real data from the database, computes metrics, assembles the
 * analysis prompt with voice profile, runs through the orchestrator
 * (with guardrails), and returns the result.
 *
 * This is the function the scheduled task and Slack handler both call.
 */

import type { Db } from "@/db/client";
import type { OrchestratorResult } from "@/ai/orchestrator";
import type { VoicePromptResult } from "@/domain/voice/voice";
import { getInsightsByCampaign } from "./queries";
import { aggregateAndCompute } from "./metrics";
import { buildAnalysisRequest, type CampaignSummary } from "./analysis";

export interface AnalyzeDeps {
  db: Db;
  voice: VoicePromptResult;
  runOrchestrator: (request: {
    prompt: string;
    system?: string;
    guardrails?: Record<string, unknown>;
  }) => Promise<OrchestratorResult>;
}

export interface AnalyzeResult {
  ok: boolean;
  text: string;
  campaignCount: number;
  dateRange: { start: string; end: string };
}

/**
 * Run ad performance analysis for the last N days.
 */
export async function analyzeAdPerformance(
  deps: AnalyzeDeps,
  lookbackDays = 7
): Promise<AnalyzeResult> {
  const endDate = new Date();
  const startDate = new Date(
    endDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000
  );

  const startStr = startDate.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  // Step 1: Query DB for insights grouped by campaign
  const campaignData = await getInsightsByCampaign(deps.db, startDate, endDate);

  if (campaignData.length === 0) {
    return {
      ok: true,
      text: `No ad data found for ${startStr} to ${endStr}. Make sure Meta sync has run.`,
      campaignCount: 0,
      dateRange: { start: startStr, end: endStr },
    };
  }

  // Step 2: Compute metrics per campaign
  const campaigns: CampaignSummary[] = campaignData.map((c) => ({
    campaignName: c.campaignName,
    dateRange: { start: startStr, end: endStr },
    metrics: aggregateAndCompute(c.rows),
  }));

  // Step 3: Build the analysis request
  const request = buildAnalysisRequest({
    campaigns,
    voice: deps.voice,
    outputType: "analysis",
  });

  // Step 4: Run through orchestrator
  const result = await deps.runOrchestrator(request);

  if (!result.ok) {
    const violations = result.guardrailResult.violations
      .map((v) => v.detail)
      .join("; ");
    return {
      ok: false,
      text: `Analysis was blocked by guardrails: ${violations}`,
      campaignCount: campaigns.length,
      dateRange: { start: startStr, end: endStr },
    };
  }

  return {
    ok: true,
    text: result.text,
    campaignCount: campaigns.length,
    dateRange: { start: startStr, end: endStr },
  };
}
