/**
 * Email design handler — the vertical integration point for "!email design".
 *
 * Wires together: product lookup → email brief → voice prompt →
 * creative prompt → orchestrator → JSON parse → Slack response.
 *
 * Dependencies injected for full mockability.
 */

import { buildEmailCreativeRequest, type EmailBrief, type ProductInfo } from "@/domain/email/creative";
import type { VoicePromptResult } from "@/domain/voice/voice";
import type { OrchestratorRequest, OrchestratorResult } from "@/ai/orchestrator";
import { formatOrchestratorResult, type SlackResponse } from "../formatter";

export interface EmailDesignDeps {
  getProducts: () => Promise<ProductInfo[]>;
  runOrchestrator: (request: OrchestratorRequest) => Promise<OrchestratorResult>;
  voice: VoicePromptResult;
}

export interface EmailDesignParams {
  brief: string;
  discount?: { code: string; percentOff: number };
  segment?: string;
}

export async function handleEmailDesign(
  deps: EmailDesignDeps,
  params: EmailDesignParams
): Promise<SlackResponse> {
  // Step 1: Get products
  const products = await deps.getProducts();

  // Step 2: Build the email brief
  const brief: EmailBrief = {
    campaignName: params.brief,
    goal: "drive sales",
    products,
    discount: params.discount,
    segment: params.segment,
  };

  // Step 3: Build the creative request (wires voice + guardrails)
  const request = buildEmailCreativeRequest(brief, deps.voice);

  // Step 4: Run through the orchestrator
  const result = await deps.runOrchestrator(request);

  // Step 5: Format for Slack
  return formatOrchestratorResult(result, "Email Creative");
}
