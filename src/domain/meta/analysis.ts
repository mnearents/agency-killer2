/**
 * Meta ads analysis — assembles analysis prompts from computed metrics
 * and configures guardrails appropriately per output type.
 *
 * KEY DESIGN DECISIONS:
 * 1. Analysis output contains real numbers — fabricated-stats guardrail OFF
 * 2. Focus is CREATIVE PERFORMANCE, not budget/targeting tweaks
 *    (Advantage+ handles targeting; the human lever is better creative)
 * 3. The analysis should answer: "What creative should we shoot next?"
 */

import type { DerivedMetrics, LtvAdjustedMetrics } from "@/domain/meta/metrics";
import { aggregateAndCompute, type InsightRow } from "@/domain/meta/metrics";
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

export interface CreativeSummary {
  adName: string;
  campaignName: string;
  creativeTitle: string | null;
  creativeBody: string | null;
  metrics: DerivedMetrics;
}

export interface AnalysisPromptInput {
  campaigns: CampaignSummary[];
  creatives?: CreativeSummary[];
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

export function formatCreativeBlock(creatives: CreativeSummary[]): string {
  if (creatives.length === 0) return "";

  // Sort by ROAS descending so best performers are first
  const sorted = [...creatives].sort((a, b) => {
    const aRoas = a.metrics.roas ?? -1;
    const bRoas = b.metrics.roas ?? -1;
    return bRoas - aRoas;
  });

  const lines = ["## Creative Performance (ranked by ROAS)\n"];

  for (const c of sorted) {
    const m = c.metrics;
    lines.push(`### ${c.adName}`);
    lines.push(`Campaign: ${c.campaignName}`);
    if (c.creativeTitle) lines.push(`Headline: ${c.creativeTitle}`);
    if (c.creativeBody) lines.push(`Copy: ${c.creativeBody.slice(0, 200)}${c.creativeBody.length > 200 ? "..." : ""}`);
    lines.push(`ROAS: ${fmt(m.roas)} | Spend: ${fmtDollars(m.spendDollars)} | Revenue: ${fmtDollars(m.revenueDollars)}`);
    lines.push(`CTR: ${fmtPct(m.ctr)} | CPC: ${fmtDollars(m.cpc)} | Conv Rate: ${fmtPct(m.conversionRate)}`);
    lines.push("");
  }

  return lines.join("\n");
}

const CREATIVE_ANALYSIS_SYSTEM = `You are a creative strategist for Rad & Happy, a stationery and lifestyle brand running Meta ads with Advantage+.

IMPORTANT CONTEXT:
- Advantage+ handles all targeting and budget optimization automatically
- The only lever the team pulls is CREATIVE — what content to shoot, what styles to test
- Do NOT suggest budget changes, audience targeting, or campaign structure changes
- Focus entirely on creative insights: what's working, what's not, and what to shoot next

Your analysis should answer these questions:
1. Which creative styles/concepts are winning? (UGC vs studio, talking head vs product shots, etc.)
2. Which ad copy/headlines resonate? What tone or hooks perform best?
3. What creative should they shoot next based on what's working?
4. Are any creatives dying (declining performance) that should be replaced?
5. Are there creative gaps — types of content they haven't tried that might work?

Be specific and actionable. Reference actual ad names and numbers from the data. Talk like a creative director reviewing the work, not a media buyer adjusting spreadsheets.`;

export function buildAnalysisRequest(
  input: AnalysisPromptInput
): OrchestratorRequest {
  const metricsBlock = formatMetricsBlock(input.campaigns);
  const creativeBlock = input.creatives
    ? formatCreativeBlock(input.creatives)
    : "";

  let prompt = `Analyze the following Meta ads performance data. Focus on CREATIVE performance — what styles and concepts are working, and what we should shoot next.\n\n`;
  prompt += metricsBlock;

  if (creativeBlock) {
    prompt += `\n${creativeBlock}`;
  }

  if (input.additionalContext) {
    prompt += `\n\n## Additional Context\n${input.additionalContext}`;
  }

  const guardrails = buildGuardrailsForOutputType(
    input.voice.guardrailOptions,
    input.outputType
  );

  // Use creative analysis system prompt for analysis output
  const system = input.outputType === "analysis"
    ? CREATIVE_ANALYSIS_SYSTEM + "\n\n" + input.voice.systemPrompt
    : input.voice.systemPrompt;

  return {
    prompt,
    system,
    guardrails,
  };
}
