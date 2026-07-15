/**
 * Ads report handler — the vertical integration point for "!ads report".
 *
 * Wires together: metrics computation → voice prompt → analysis prompt →
 * orchestrator → Slack response formatting.
 *
 * Dependencies are injected (not imported) so everything is mockable.
 */

import { aggregateAndCompute, type InsightRow } from "@/domain/meta/metrics";
import { buildAnalysisRequest, type CampaignSummary } from "@/domain/meta/analysis";
import type { VoicePromptResult } from "@/domain/voice/voice";
import type { OrchestratorRequest, OrchestratorResult } from "@/ai/orchestrator";
import { formatOrchestratorResult, type SlackResponse } from "../formatter";

export interface AdsReportDeps {
  getInsightRows: (dateRange: { start: string; end: string }) => Promise<InsightRow[]>;
  getCampaignName: (campaignId: string) => Promise<string>;
  runOrchestrator: (request: OrchestratorRequest) => Promise<OrchestratorResult>;
  voice: VoicePromptResult;
}

export interface AdsReportParams {
  dateRange: { start: string; end: string };
}

export async function handleAdsReport(
  deps: AdsReportDeps,
  params: AdsReportParams
): Promise<SlackResponse> {
  // Step 1: Get insight data
  const rows = await deps.getInsightRows(params.dateRange);

  // Step 2: Compute aggregate metrics
  const metrics = aggregateAndCompute(rows);

  // Step 3: Get campaign name
  const campaignName = await deps.getCampaignName("default");

  // Step 4: Build the campaign summary
  const campaign: CampaignSummary = {
    campaignName,
    dateRange: params.dateRange,
    metrics,
  };

  // Step 5: Build the analysis request (wires voice + guardrails)
  const request = buildAnalysisRequest({
    campaigns: [campaign],
    voice: deps.voice,
    outputType: "analysis",
  });

  // Step 6: Run through the orchestrator
  const result = await deps.runOrchestrator(request);

  // Step 7: Format for Slack
  return formatOrchestratorResult(result, "Ads Report");
}
