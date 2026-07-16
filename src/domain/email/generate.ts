/**
 * Email creative generation — full pipeline from brief to generated creative.
 *
 * Takes a text brief (from Slack "!email design <brief>"), fetches product
 * data from the DB, builds the creative prompt, runs through the orchestrator,
 * and returns structured email creative specs.
 */

import type { Db } from "@/db/client";
import type { OrchestratorRequest, OrchestratorResult } from "@/ai/orchestrator";
import type { VoicePromptResult } from "@/domain/voice/voice";
import { buildEmailCreativeRequest, type ProductInfo, type EmailBrief } from "./creative";
import { shopifyLineItems } from "@/db/schema";
import { sql } from "drizzle-orm";

export interface EmailGenerateDeps {
  db: Db;
  voice: VoicePromptResult;
  runOrchestrator: (request: OrchestratorRequest) => Promise<OrchestratorResult>;
}

export interface EmailGenerateResult {
  ok: boolean;
  text: string;
  brief: string;
}

/**
 * Get top products from DB for inclusion in email creative prompts.
 */
async function getTopProducts(db: Db, limit = 5): Promise<ProductInfo[]> {
  try {
    const products = await db
      .selectDistinctOn([shopifyLineItems.productId], {
        title: shopifyLineItems.title,
        productType: shopifyLineItems.productType,
        priceCents: shopifyLineItems.priceCents,
      })
      .from(shopifyLineItems)
      .limit(limit);

    return products.map((p) => ({
      title: p.title,
      description: "", // Line items don't have descriptions
      priceCents: Number(p.priceCents),
      productType: p.productType ?? undefined,
    }));
  } catch {
    // If Shopify data hasn't been synced yet, return empty
    return [];
  }
}

/**
 * Generate email creative from a text brief.
 */
export async function generateEmailCreative(
  deps: EmailGenerateDeps,
  briefText: string
): Promise<EmailGenerateResult> {
  // Step 1: Get product data
  const products = await getTopProducts(deps.db);

  // Step 2: Build the email brief
  const brief: EmailBrief = {
    campaignName: briefText,
    goal: "drive sales",
    products: products.length > 0
      ? products
      : [{ title: "Rad & Happy Products", description: "Our stationery collection", priceCents: 0 }],
  };

  // Step 3: Build the creative request
  const request = buildEmailCreativeRequest(brief, deps.voice);

  // Step 4: Run through orchestrator
  const result = await deps.runOrchestrator(request);

  if (!result.ok) {
    const violations = result.guardrailResult.violations
      .map((v) => v.detail)
      .join("; ");
    return {
      ok: false,
      text: `Email creative was blocked by guardrails: ${violations}`,
      brief: briefText,
    };
  }

  return {
    ok: true,
    text: result.text,
    brief: briefText,
  };
}
