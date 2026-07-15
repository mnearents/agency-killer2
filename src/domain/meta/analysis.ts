/**
 * Meta ads analysis — assembles analysis prompts from computed metrics
 * and configures guardrails appropriately per output type.
 *
 * KEY DESIGN DECISION: Analysis output contains real numbers from the data.
 * The fabricated-stats guardrail must be DISABLED for analysis (it would
 * false-positive on real metrics). It stays ENABLED for creative/copy output.
 */

import type { DerivedMetrics, LtvAdjustedMetrics } from "@/domain/meta/metrics";
import type { GuardrailOptions } from "@/ai/guardrails";
import type { OrchestratorRequest } from "@/ai/orchestrator";
import type { VoicePromptResult } from "@/domain/voice/voice";

export type OutputType = "analysis" | "creative";

export interface CampaignSummary {
  campaignName: string;
  dateRange: { start: string; end: string };
  metrics: DerivedMetrics;
  ltvMetrics?: LtvAdjustedMetrics;
}

export interface AnalysisPromptInput {
  campaigns: CampaignSummary[];
  voice: VoicePromptResult;
  outputType: OutputType;
  additionalContext?: string;
}

function fmt(value: number | null, decimals = 2): string {
  if (value === null) return "N/A";
  return value.toFixed(decimals);
}

function fmtDollars(value: number | null): string {
  if (value === null) return "N/A";
  return `$${value.toFixed(2)}`;
}

function fmtPct(value: number | null): string {
  if (value === null) return "N/A";
  return `${value.toFixed(2)}%`;
}

export function buildGuardrailsForOutputType(
  baseGuardrails: GuardrailOptions,
  outputType: OutputType
): GuardrailOptions {
  return {
    ...baseGuardrails,
    // Analysis output contains real numbers — fabricated-stats check
    // would false-positive. Creative output must NOT contain stats
    // the model invented.
    checkFabricatedStats: outputType === "creative",
  };
}

export function formatMetricsBlock(campaigns: CampaignSummary[]): string {
  return campaigns
    .map((c) => {
      const m = c.metrics;
      let block = `## ${c.campaignName}\nDate range: ${c.dateRange.start} to ${c.dateRange.end}\n`;
      block += `- Spend: ${fmtDollars(m.spendDollars)}\n`;
      block += `- Revenue: ${fmtDollars(m.revenueDollars)}\n`;
      block += `- ROAS: ${fmt(m.roas)}\n`;
      block += `- Cost per purchase: ${fmtDollars(m.costPerPurchaseDollars)}\n`;
      block += `- CTR: ${fmtPct(m.ctr)}\n`;
      block += `- CPM: ${fmtDollars(m.cpm)}\n`;
      block += `- CPC: ${fmtDollars(m.cpc)}\n`;
      block += `- Conversion rate: ${fmtPct(m.conversionRate)}\n`;
      block += `- Add-to-cart rate: ${fmtPct(m.addToCartRate)}\n`;
      block += `- Checkout rate: ${fmtPct(m.checkoutRate)}\n`;

      if (c.ltvMetrics) {
        block += `- Raw ROAS: ${fmt(c.ltvMetrics.rawRoas)}\n`;
        block += `- LTV-adjusted ROAS: ${fmt(c.ltvMetrics.ltvAdjustedRoas)}\n`;
        block += `- Profitable with LTV: ${c.ltvMetrics.profitableWithLtv ? "Yes" : "No"}\n`;
      }

      return block;
    })
    .join("\n");
}

export function buildAnalysisRequest(
  input: AnalysisPromptInput
): OrchestratorRequest {
  const metricsBlock = formatMetricsBlock(input.campaigns);

  let prompt = `Analyze the following Meta ads performance data and provide actionable recommendations:\n\n${metricsBlock}`;

  if (input.additionalContext) {
    prompt += `\n\n## Additional Context\n${input.additionalContext}`;
  }

  const guardrails = buildGuardrailsForOutputType(
    input.voice.guardrailOptions,
    input.outputType
  );

  return {
    prompt,
    system: input.voice.systemPrompt,
    guardrails,
  };
}
