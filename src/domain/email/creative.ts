/**
 * Email creative prompt assembly — generates prompts for email marketing
 * creative: subject lines, preview text, body copy, and image template data.
 *
 * The output is structured JSON that the orchestrator validates, then the
 * image composition layer (Playwright) renders into email images.
 *
 * Guardrails: creative output uses fabricated-stats ON, PII ON, banned words ON,
 * expectJson ON. This is the opposite of analysis output.
 */

import type { GuardrailOptions } from "@/ai/guardrails";
import type { OrchestratorRequest } from "@/ai/orchestrator";
import type { VoicePromptResult } from "@/domain/voice/voice";

export interface ProductInfo {
  title: string;
  description: string;
  priceCents: number;
  imageUrl?: string;
  productType?: string;
}

export interface EmailBrief {
  campaignName: string;
  goal: string;
  products: ProductInfo[];
  segment?: string;
  discount?: { code: string; percentOff: number };
  scheduledDate?: string;
}

export interface EmailCreativeSpec {
  subjectLine: string;
  previewText: string;
  headline: string;
  bodyCopy: string;
  ctaText: string;
  ctaUrl: string;
  altText: string;
  imageTemplateData: Record<string, string>;
}

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function buildEmailGuardrails(
  voiceGuardrails: GuardrailOptions
): GuardrailOptions {
  return {
    ...voiceGuardrails,
    checkFabricatedStats: true,
    checkPii: true,
    expectJson: true,
  };
}

export function formatProductBlock(products: ProductInfo[]): string {
  return products
    .map((p) => {
      let block = `- **${p.title}** — ${centsToDollars(p.priceCents)}\n`;
      block += `  ${p.description}\n`;
      if (p.imageUrl) {
        block += `  Image: ${p.imageUrl}\n`;
      }
      if (p.productType) {
        block += `  Type: ${p.productType}\n`;
      }
      return block;
    })
    .join("\n");
}

export function buildEmailCreativeRequest(
  brief: EmailBrief,
  voice: VoicePromptResult
): OrchestratorRequest {
  const productBlock = formatProductBlock(brief.products);

  let prompt = `Generate email creative for the "${brief.campaignName}" campaign.\n\n`;
  prompt += `## Goal\n${brief.goal}\n\n`;
  prompt += `## Products\n${productBlock}\n`;

  if (brief.segment) {
    prompt += `\n## Target Segment\n${brief.segment}\n`;
  }

  if (brief.discount) {
    prompt += `\n## Discount\nCode: ${brief.discount.code} — ${brief.discount.percentOff}% off\n`;
  }

  if (brief.scheduledDate) {
    prompt += `\n## Scheduled Send Date\n${brief.scheduledDate}\n`;
  }

  prompt += `\nReturn your response as a JSON object with these fields:
{
  "subjectLine": "...",
  "previewText": "...",
  "headline": "...",
  "bodyCopy": "...",
  "ctaText": "...",
  "ctaUrl": "...",
  "altText": "...",
  "imageTemplateData": { "headline": "...", "subheadline": "...", "ctaText": "...", "heroImageUrl": "..." }
}`;

  const guardrails = buildEmailGuardrails(voice.guardrailOptions);

  return {
    prompt,
    system: voice.systemPrompt,
    guardrails,
  };
}
