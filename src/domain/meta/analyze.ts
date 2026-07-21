/**
 * Meta ads analysis — the full pipeline from DB to AI-generated
 * creative-focused recommendations.
 *
 * Focus: which creative styles/concepts are working, what to shoot
 * next. NOT budget tweaks or targeting changes (Advantage+ handles that).
 */

import type { Db } from "@/db/client";
import type { OrchestratorRequest, OrchestratorResult } from "@/ai/orchestrator";
import type { VoicePromptResult } from "@/domain/voice/voice";
import { getInsightsByCampaign, getInsightsByAdCreative } from "./queries";
import { aggregateAndCompute } from "./metrics";
import {
  buildAnalysisRequest,
  type CampaignSummary,
  type CreativeSummary,
} from "./analysis";

export interface AnalyzeDeps {
  db: Db;
  voice: VoicePromptResult;
  runOrchestrator: (request: OrchestratorRequest) => Promise<OrchestratorResult>;
  getKbContext?: () => Promise<string>;
}

export interface AnalyzeResult {
  ok: boolean;
  text: string;
  campaignCount: number;
  creativeCount: number;
  dateRange: { start: string; end: string };
}

/**
 * Run ad performance analysis for the last N days.
 * Returns creative-focused insights — what's working, what to shoot next.
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

  // Step 1: Query DB for campaign-level and creative-level data
  const campaignData = await getInsightsByCampaign(deps.db, startDate, endDate);

  if (campaignData.length === 0) {
    return {
      ok: true,
      text: `No ad data found for ${startStr} to ${endStr}. Make sure Meta sync has run.`,
      campaignCount: 0,
      creativeCount: 0,
      dateRange: { start: startStr, end: endStr },
    };
  }

  // Step 2: Compute campaign metrics
  const campaigns: CampaignSummary[] = campaignData.map((c) => ({
    campaignName: c.campaignName,
    dateRange: { start: startStr, end: endStr },
    metrics: aggregateAndCompute(c.rows),
  }));

  // Step 3: Get creative-level data
  let creatives: CreativeSummary[] = [];
  try {
    const creativeData = await getInsightsByAdCreative(
      deps.db,
      startDate,
      endDate
    );
    creatives = creativeData.map((c) => ({
      adName: c.adName,
      campaignName: c.campaignName,
      creativeTitle: c.creativeTitle,
      creativeBody: c.creativeBody,
      metrics: aggregateAndCompute(c.rows),
    }));
  } catch (err) {
    console.error("[analyze] Failed to get creative-level data:", err);
    // Non-fatal — campaign-level analysis still works
  }

  // Step 4: Get KB context (strategy notes, CTC guidance, goals)
  let additionalContext: string | undefined;
  if (deps.getKbContext) {
    additionalContext = await deps.getKbContext();
  }

  // Step 5: Build the analysis request with creative data
  const request = buildAnalysisRequest({
    campaigns,
    creatives: creatives.length > 0 ? creatives : undefined,
    voice: deps.voice,
    outputType: "analysis",
    additionalContext,
  });

  // Step 6: Run through orchestrator
  const result = await deps.runOrchestrator(request);

  if (!result.ok) {
    const violations = result.guardrailResult.violations
      .map((v) => v.detail)
      .join("; ");
    return {
      ok: false,
      text: `Analysis was blocked by guardrails: ${violations}`,
      campaignCount: campaigns.length,
      creativeCount: creatives.length,
      dateRange: { start: startStr, end: endStr },
    };
  }

  return {
    ok: true,
    text: result.text,
    campaignCount: campaigns.length,
    creativeCount: creatives.length,
    dateRange: { start: startStr, end: endStr },
  };
}
