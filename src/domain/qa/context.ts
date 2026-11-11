/**
 * Smart Q&A context — detects what a question is about and pulls
 * relevant live data from the DB to include in the AI prompt.
 *
 * This is the bridge between "chatbot that searches documents" and
 * "agency that knows your numbers." When Tara asks "how are our
 * reels doing," the system pulls actual engagement data, not just
 * a knowledge base article about Instagram strategy.
 */

import type { Db } from "@/db/client";
import { getAdsStatus, formatAdsStatus } from "@/domain/meta/status";
import { getOrderSummary, getTopProducts } from "@/domain/shopify/queries";
import { getPostSummary } from "@/domain/social/queries";

export type Topic = "ads" | "shopify" | "social" | "email";

const TOPIC_PATTERNS: Record<Topic, RegExp[]> = {
  ads: [
    /\bads?\b/i, /\broas\b/i, /\bcampaign/i, /\bmeta\b/i,
    /\bad spend/i, /\bcpc\b/i, /\bctr\b/i, /\bcpm\b/i,
    /\badvertis/i, /\bcreative/i, /\bimpression/i,
    /\bconversion/i, /\bpurchase/i,
  ],
  shopify: [
    /\border/i, /\brevenue/i, /\bsales?\b/i, /\bproduct/i,
    /\bsubscription/i, /\baov\b/i, /\baverage order/i,
    /\bshopify/i, /\bselling/i, /\bstore\b/i,
  ],
  social: [
    /\breel/i, /\binstagram/i, /\bsocial\b/i, /\bpost/i,
    /\bengagement/i, /\bsave rate/i, /\bsaves?\b/i,
    /\bshare rate/i, /\bfollower/i, /\bcarousel/i,
    /\bstory\b/i, /\bstories\b/i, /\breach\b/i,
  ],
  email: [
    /\bemail/i, /\bsms\b/i, /\btext\s*(message)?/i,
    /\battentive/i, /\bunsubscrib/i, /\bclick rate/i,
    /\bopen rate/i, /\bdeliver/i, /\bnewsletter/i,
    /\bsend\b/i, /\bsent\b/i,
  ],
};

// Broad questions that should get everything
const BROAD_PATTERNS = [
  /\boverall\b/i, /\beverything\b/i, /\bhow.*doing\b/i,
  /\bsummary\b/i, /\bthis week\b/i, /\blast week\b/i,
  /\bwhat.*(should|next|plan)/i, /\bstatus\b/i,
  /\bbusiness\b/i, /\bperformance\b/i,
];

export function detectTopics(question: string): Topic[] {
  const matched = new Set<Topic>();

  for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(question)) {
        matched.add(topic as Topic);
        break;
      }
    }
  }

  // Broad questions get all topics
  if (matched.size === 0) {
    for (const pattern of BROAD_PATTERNS) {
      if (pattern.test(question)) {
        return ["ads", "shopify", "social", "email"];
      }
    }
    // Fallback: still include shopify and social as most generally useful
    return ["shopify", "social"];
  }

  return Array.from(matched);
}

function fmtDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtNum(v: number): string {
  return v.toLocaleString("en-US");
}

/**
 * Pull live data for the detected topics and format as context
 * that goes into the AI prompt alongside the KB context.
 */
export async function buildLiveContext(
  db: Db,
  topics: Topic[]
): Promise<string> {
  const sections: string[] = [];

  for (const topic of topics) {
    try {
      switch (topic) {
        case "ads": {
          const status = await getAdsStatus(db, 7);
          if (status.campaigns.length > 0) {
            sections.push(
              `## Live Ad Data (last 7 days)\n${formatAdsStatus(status)}`
            );
          } else {
            sections.push("## Ads\nNo active campaigns in the last 7 days.");
          }
          break;
        }

        case "shopify": {
          const summary = await getOrderSummary(db, 7);
          const products = await getTopProducts(db, 5);
          const lines = [
            "## Live Shopify Data (last 7 days)",
            `${summary.totalOrders} orders | ${fmtDollars(summary.totalRevenueCents)} revenue`,
            `${summary.subscriptionOrders} subscriptions (${fmtDollars(summary.subscriptionRevenueCents)})`,
            summary.totalOrders > 0
              ? `AOV: ${fmtDollars(summary.totalRevenueCents / summary.totalOrders)}`
              : "",
          ];
          if (products.length > 0) {
            lines.push("", "Top products:");
            for (const p of products) {
              lines.push(`  - ${p.title}`);
            }
          }
          sections.push(lines.filter(Boolean).join("\n"));
          break;
        }

        case "social": {
          const social = await getPostSummary(db, 7);
          if (social.totalPosts > 0) {
            sections.push([
              "## Live Instagram Data (last 7 days)",
              `${social.totalPosts} posts | ${fmtNum(social.totalReach)} reach | ${fmtNum(social.totalImpressions)} impressions`,
              `${fmtNum(social.totalEngagements)} engagements | Engagement rate: ${social.avgEngagementRate?.toFixed(1) ?? "N/A"}%`,
            ].join("\n"));
          } else {
            sections.push("## Instagram\nNo posts in the last 7 days.");
          }
          break;
        }

        case "email": {
          // Read from Attentive's own connector now; said, so no figure is invented.
          sections.push("## Email/SMS\nNot collected by this system — email and SMS results are in Attentive.");
          break;
        }
      }
    } catch (err) {
      console.error(`[qa] Failed to fetch ${topic} data:`, err);
    }
  }

  if (sections.length === 0) return "";

  return "--- LIVE DATA (from database — these are real numbers) ---\n\n" +
    sections.join("\n\n");
}
