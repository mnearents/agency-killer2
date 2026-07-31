/**
 * Social report handler — the vertical integration point for "!social analyze".
 *
 * Wires together: DB queries → metrics → analysis prompt → orchestrator →
 * Slack response formatting.
 *
 * Dependencies are injected (not imported) so everything is mockable.
 */

import type { OrchestratorRequest, OrchestratorResult } from "@/ai/orchestrator";
import type { VoicePromptResult } from "@/domain/voice/voice";
import type { Db } from "@/db/client";
import type { InstagramApiClient } from "@/integrations/instagram-api";
import { analyzeSocialPerformance } from "@/domain/social/analyze";
import { formatStatusBlock } from "@/domain/social/analysis";
import { getPostSummary } from "@/domain/social/queries";
import { formatOrchestratorResult, type SlackResponse } from "../formatter";

export interface SocialReportDeps {
  db: Db;
  voice: VoicePromptResult;
  runOrchestrator: (request: OrchestratorRequest) => Promise<OrchestratorResult>;
  igClient?: InstagramApiClient;
  igUserId?: string;
  getKbContext?: () => Promise<string>;
}

export async function handleSocialAnalyze(
  deps: SocialReportDeps,
  lookbackDays = 30
): Promise<SlackResponse> {
  const result = await analyzeSocialPerformance(
    {
      db: deps.db,
      voice: deps.voice,
      runOrchestrator: deps.runOrchestrator,
      igClient: deps.igClient,
      igUserId: deps.igUserId,
      getKbContext: deps.getKbContext,
    },
    lookbackDays
  );

  return { text: result.text, isError: !result.ok };
}

export async function handleSocialStatus(
  deps: { db: Db; igClient?: InstagramApiClient; igUserId?: string },
  lookbackDays = 30
): Promise<SlackResponse> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  const summary = await getPostSummary(deps.db, lookbackDays);

  let followerCount: number | null = null;
  if (deps.igClient && deps.igUserId) {
    try {
      const account = await deps.igClient.getAccountInfo(deps.igUserId);
      followerCount = account.followers_count;
    } catch {
      // Non-fatal
    }
  }

  const text = formatStatusBlock({
    ...summary,
    dateRange: { start: startStr, end: endStr },
    followerCount,
  });

  return { text, isError: false };
}
