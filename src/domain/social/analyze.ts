/**
 * Social analysis — the full pipeline from DB to AI-generated
 * content strategy recommendations.
 *
 * Focus: which content themes and formats drive engagement,
 * what Tara should shoot/post next.
 */

import type { Db } from "@/db/client";
import type { OrchestratorRequest, OrchestratorResult } from "@/ai/orchestrator";
import type { VoicePromptResult } from "@/domain/voice/voice";
import type { InstagramApiClient } from "@/integrations/instagram-api";
import { getPostsByDateRange, toPostRow } from "./queries";
import { computePostMetrics, rankPosts, computeFormatBreakdown } from "./metrics";
import { buildSocialAnalysisRequest, type PostSummaryForPrompt } from "./analysis";

export interface SocialAnalyzeDeps {
  db: Db;
  voice: VoicePromptResult;
  runOrchestrator: (request: OrchestratorRequest) => Promise<OrchestratorResult>;
  igClient?: InstagramApiClient;
  igUserId?: string;
  getKbContext?: () => Promise<string>;
}

export interface SocialAnalyzeResult {
  ok: boolean;
  text: string;
  postCount: number;
  dateRange: { start: string; end: string };
}

/**
 * Run organic social analysis for the last N days.
 * Returns content-focused insights — what's working, what to post next.
 */
export async function analyzeSocialPerformance(
  deps: SocialAnalyzeDeps,
  lookbackDays = 30
): Promise<SocialAnalyzeResult> {
  const endDate = new Date();
  const startDate = new Date(
    endDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000
  );

  const startStr = startDate.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  // Step 1: Query DB for posts
  const posts = await getPostsByDateRange(deps.db, startDate, endDate);

  if (posts.length === 0) {
    return {
      ok: true,
      text: `No Instagram posts found for ${startStr} to ${endStr}. Run \`!sync social\` to pull data.`,
      postCount: 0,
      dateRange: { start: startStr, end: endStr },
    };
  }

  // Step 2: Compute metrics and rank
  const postRows = posts.map(toPostRow);
  const ranked = rankPosts(postRows, "engagementRate");
  const topCount = Math.min(5, posts.length);
  const bottomCount = Math.min(3, Math.max(0, posts.length - topCount));

  // Build post summaries for the prompt
  function toPromptSummary(
    postRow: typeof postRows[number],
    metrics: typeof ranked[number],
    idx: number
  ): PostSummaryForPrompt {
    const record = posts[idx];
    return {
      caption: record.caption,
      mediaType: record.mediaType,
      mediaProductType: record.mediaProductType,
      permalink: record.permalink,
      engagementRate: metrics.engagementRate,
      saveRate: metrics.saveRate,
      shareRate: metrics.shareRate,
      reach: postRow.reach,
      impressions: postRow.impressions,
      plays: postRow.plays,
      isReel: metrics.isReel,
      postedAt: record.postedAt.toISOString().split("T")[0],
    };
  }

  // Map ranked metrics back to post records
  // ranked is sorted by engagement, but we need to find the original post index
  const metricsWithIndex = postRows.map((row, idx) => ({
    row,
    idx,
    metrics: computePostMetrics(row),
  }));
  metricsWithIndex.sort((a, b) => {
    const aVal = a.metrics.engagementRate ?? -Infinity;
    const bVal = b.metrics.engagementRate ?? -Infinity;
    return bVal - aVal;
  });

  const topPosts = metricsWithIndex
    .slice(0, topCount)
    .map((m) => toPromptSummary(m.row, m.metrics, m.idx));

  const bottomPosts = bottomCount > 0
    ? metricsWithIndex
        .slice(-bottomCount)
        .map((m) => toPromptSummary(m.row, m.metrics, m.idx))
    : [];

  // Step 3: Format breakdown
  const breakdown = computeFormatBreakdown(postRows);

  // Step 4: Get follower count if IG client is available
  let followerCount: number | null = null;
  if (deps.igClient && deps.igUserId) {
    try {
      const account = await deps.igClient.getAccountInfo(deps.igUserId);
      followerCount = account.followers_count;
    } catch {
      // Non-fatal — analysis works without follower count
    }
  }

  // Step 5: Get KB context
  let kbContext: string | undefined;
  if (deps.getKbContext) {
    kbContext = await deps.getKbContext();
  }

  // Step 6: Build analysis request
  const request = buildSocialAnalysisRequest({
    topPosts,
    bottomPosts,
    breakdown,
    dateRange: { start: startStr, end: endStr },
    followerCount,
    voice: deps.voice,
    kbContext,
  });

  // Step 7: Run through orchestrator
  const result = await deps.runOrchestrator(request);

  if (!result.ok) {
    const violations = result.guardrailResult.violations
      .map((v) => v.detail)
      .join("; ");
    return {
      ok: false,
      text: `Analysis was blocked by guardrails: ${violations}`,
      postCount: posts.length,
      dateRange: { start: startStr, end: endStr },
    };
  }

  return {
    ok: true,
    text: result.text,
    postCount: posts.length,
    dateRange: { start: startStr, end: endStr },
  };
}
