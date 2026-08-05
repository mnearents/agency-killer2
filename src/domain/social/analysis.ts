/**
 * Social analysis — assembles analysis prompts from organic IG metrics
 * and configures guardrails. Parallel to meta/analysis.ts.
 *
 * KEY DESIGN DECISIONS:
 * 1. Analysis output contains real numbers — fabricated-stats guardrail OFF
 * 2. Focus is CONTENT STRATEGY: what themes/formats drive engagement
 * 3. Tara-friendly language — she reads this in Slack
 */

import type { FormatBreakdown } from "@/domain/social/metrics";
import type { GuardrailOptions } from "@/ai/guardrails";
import type { OrchestratorRequest } from "@/ai/orchestrator";
import type { VoicePromptResult } from "@/domain/voice/voice";

export interface PostSummaryForPrompt {
  caption: string | null;
  mediaType: string;
  mediaProductType: string | null;
  permalink: string | null;
  engagementRate: number | null;
  saveRate: number | null;
  shareRate: number | null;
  reach: number;
  impressions: number;
  plays: number;
  isReel: boolean;
  postedAt: string;
}

export interface StatusBlockInput {
  totalPosts: number;
  totalReach: number;
  totalImpressions: number;
  totalEngagements: number;
  avgEngagementRate: number | null;
  dateRange: { start: string; end: string };
  followerCount: number | null;
}

export interface SocialAnalysisInput {
  topPosts: PostSummaryForPrompt[];
  bottomPosts: PostSummaryForPrompt[];
  breakdown: FormatBreakdown[];
  dateRange: { start: string; end: string };
  followerCount: number | null;
  voice: VoicePromptResult;
  kbContext?: string;
}

function fmtPct(value: number | null): string {
  if (value === null) return "N/A";
  return `${value.toFixed(2)}%`;
}

function fmtNum(value: number): string {
  return value.toLocaleString("en-US");
}

function getFormatLabel(mediaType: string, mediaProductType: string | null): string {
  if (mediaProductType === "REELS") return "Reel";
  if (mediaProductType === "STORY") return "Story";
  if (mediaType === "CAROUSEL_ALBUM") return "Carousel";
  if (mediaType === "VIDEO") return "Video";
  return "Image";
}

function truncateCaption(caption: string | null, maxLen = 120): string {
  if (!caption) return "(no caption)";
  if (caption.length <= maxLen) return caption;
  return caption.slice(0, maxLen) + "...";
}

export function formatPostsBlock(posts: PostSummaryForPrompt[]): string {
  if (posts.length === 0) return "(no posts)";

  return posts
    .map((p, i) => {
      const format = getFormatLabel(p.mediaType, p.mediaProductType);
      let block = `### ${i + 1}. ${format} — ${p.postedAt}\n`;
      block += `Caption: ${truncateCaption(p.caption)}\n`;
      block += `Engagement: ${fmtPct(p.engagementRate)} | Saves: ${fmtPct(p.saveRate)} | Shares: ${fmtPct(p.shareRate)}\n`;
      block += `Reach: ${fmtNum(p.reach)} | Impressions: ${fmtNum(p.impressions)}\n`;
      if (p.isReel && p.plays > 0) {
        block += `${fmtNum(p.plays)} plays\n`;
      }
      if (p.permalink) {
        block += `Link: ${p.permalink}\n`;
      }
      return block;
    })
    .join("\n");
}

export function formatBreakdownBlock(breakdown: FormatBreakdown[]): string {
  if (breakdown.length === 0) return "(no data)";

  return breakdown
    .map((b) => {
      let line = `- **${b.format}**: ${b.count} posts, avg engagement ${fmtPct(b.avgEngagementRate)}, avg saves ${fmtPct(b.avgSaveRate)}, avg reach ${fmtNum(b.avgReach)}`;
      if (b.avgPlays > 0) {
        line += `, avg plays ${fmtNum(b.avgPlays)}`;
      }
      return line;
    })
    .join("\n");
}

export function formatStatusBlock(input: StatusBlockInput): string {
  if (input.totalPosts === 0) {
    return `No posts found (${input.dateRange.start} to ${input.dateRange.end}). Run \`!sync social\` to pull Instagram data.`;
  }

  const lines = [
    `*Organic Social* (${input.dateRange.start} to ${input.dateRange.end})`,
    "",
    `• *${input.totalPosts}* posts`,
    `• *${fmtNum(input.totalReach)}* total reach`,
    `• *${fmtNum(input.totalImpressions)}* impressions`,
    `• *${fmtNum(input.totalEngagements)}* engagements`,
    `• Avg engagement rate: *${fmtPct(input.avgEngagementRate)}*`,
  ];

  if (input.followerCount !== null) {
    lines.push(`• *${fmtNum(input.followerCount)}* followers`);
  }

  return lines.join("\n");
}

const SOCIAL_ANALYSIS_SYSTEM = `You are a creative strategist for Rad & Happy, a stationery and lifestyle brand on Instagram.

IMPORTANT CONTEXT:
- Tara (the CEO/creative director) reads these reports directly — use friendly, non-technical language
- Focus on CONTENT INSIGHTS: what themes, styles, and formats get the most engagement
- Saves are the #1 signal — a save means someone found it valuable enough to come back to
- Shares mean the content resonated enough to send to a friend — virality signal
- Engagement rate = (likes + comments + saves + shares) / reach

Your analysis should answer:
1. Which content themes are winning? (product shots, behind-the-scenes, lifestyle, UGC, tips, etc.)
2. Which formats work best? (Reels vs carousels vs single images)
3. What makes the top posts special? What do they have in common?
4. What should Tara shoot/post next based on what's working?
5. Are there any patterns in timing, captions, or hashtags?
6. What's NOT working that she should stop or change?

Be specific — reference actual post captions and numbers. Talk like a creative director reviewing the feed, not a data analyst reading a spreadsheet.`;

export function buildSocialAnalysisRequest(
  input: SocialAnalysisInput
): OrchestratorRequest {
  const topBlock = formatPostsBlock(input.topPosts);
  const bottomBlock = formatPostsBlock(input.bottomPosts);
  const breakdownBlock = formatBreakdownBlock(input.breakdown);

  let prompt = `Analyze the following organic Instagram performance data. Focus on content themes and formats — what should we post more of?\n\n`;
  prompt += `## Date Range\n${input.dateRange.start} to ${input.dateRange.end}\n\n`;

  if (input.followerCount !== null) {
    prompt += `## Account\n${fmtNum(input.followerCount)} followers\n\n`;
  }

  prompt += `## Format Breakdown\n${breakdownBlock}\n\n`;
  prompt += `## Top Performing Posts (by engagement rate)\n${topBlock}\n`;

  if (input.bottomPosts.length > 0) {
    prompt += `\n## Lowest Performing Posts\n${bottomBlock}\n`;
  }

  if (input.kbContext) {
    prompt += `\n## Additional Context\n${input.kbContext}\n`;
  }

  const guardrails: GuardrailOptions = {
    ...input.voice.guardrailOptions,
    checkFabricatedStats: false,
  };

  const system = SOCIAL_ANALYSIS_SYSTEM + "\n\n" + input.voice.systemPrompt;

  return {
    prompt,
    system,
    guardrails,
  };
}
