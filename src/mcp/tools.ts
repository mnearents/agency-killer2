/**
 * MCP tool surface — structured reads over the domain query layer.
 *
 * Deliberately NOT a wrapper around the Slack handlers. Those take string
 * arguments and return prose formatted for Tara (`*bold*`, bullets, plain
 * language). A model handed pre-chewed prose cannot check the reasoning behind
 * it — which is the entire point of this server. So every tool here returns
 * data, and whoever is reading does their own analysis.
 *
 * Conventions that exist to prevent specific misreads:
 *  - Money is DOLLARS. `spendCents: 250000` misread as "$250,000" is a
 *    plausible and expensive mistake; there is no cents-denominated field.
 *  - Dates are ISO strings.
 *  - Any capped list reports both what came back and what matched, so a sample
 *    is never mistaken for the whole set.
 *  - Every tool echoes the date window it used, so a number is attributable.
 */

import type { Db } from "@/db/client";
import { parseArgs, resolveRange, RANGE_SCHEMA, type ArgSchema, type ParsedArgs } from "./args";

import { getDataFreshness } from "@/db/freshness";
import { getInsightTotals, getInsightsByCampaign, getInsightsByAdCreative } from "@/domain/meta/queries";
import { aggregateAndCompute } from "@/domain/meta/metrics";
import { getOrderSummary, getDailyOrders, getTopProducts, getSubscriptionOrders } from "@/domain/shopify/queries";
import { computeLtvSummary } from "@/domain/shopify/subscription-ltv";
import { getAttentiveWeekSummary } from "@/domain/attentive/queries";
import { getPostSummary, getPostsByDateRange } from "@/domain/social/queries";
import { getInventoryItems } from "@/domain/inventory/queries";
import { classifyItem } from "@/domain/inventory/checks";
import { computeDailyVelocity, computeDaysOfCover } from "@/domain/inventory/velocity";
import { getEntriesByWeek } from "@/domain/calendar/queries";
import { getAllSamples, getAllRules, getAllBannedWords } from "@/domain/voice/queries";
import { runAlertChecks } from "@/domain/alerts/runner";
import { CHECK_FAILED_TYPE } from "@/domain/alerts/checks";

export interface McpToolContext {
  db: Db;
  /** Injected so tests can freeze time — no wall clock inside a tool. */
  now: () => Date;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  schema: ArgSchema;
  run(ctx: McpToolContext, args: ParsedArgs): Promise<unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const dollars = (cents: number) => Math.round(Number(cents)) / 100;

function describeRange(range: { startDate: Date; endDate: Date }) {
  return {
    startDate: range.startDate.toISOString(),
    endDate: range.endDate.toISOString(),
  };
}

const SALES_WINDOW_DAYS = 30;

// ─── Tools ────────────────────────────────────────────────────────────

const dataFreshness: McpTool = {
  name: "data_freshness",
  title: "Data freshness",
  description:
    "How recently each data source was synced, and whether any is stale. Call this before drawing conclusions — a stale source looks identical to a quiet one. Attentive (email/SMS) is imported by hand, so its timestamp is the newest data point rather than a sync time.",
  readOnly: true,
  schema: {},
  async run(ctx) {
    const sources = await getDataFreshness(ctx.db, ctx.now());
    return { sources, anyStale: sources.some((s) => s.stale) };
  },
};

const adsPerformance: McpTool = {
  name: "ads_performance",
  title: "Meta ads performance",
  description:
    "Meta ad spend, revenue, ROAS and funnel rates for a date range, in total and per campaign (ranked by spend). Defaults to the last 30 days.",
  readOnly: true,
  schema: { ...RANGE_SCHEMA },
  async run(ctx, args) {
    const range = resolveRange(args, ctx.now(), 30);
    const [totalRows, campaigns] = await Promise.all([
      getInsightTotals(ctx.db, range.startDate, range.endDate),
      getInsightsByCampaign(ctx.db, range.startDate, range.endDate),
    ]);

    return {
      range: describeRange(range),
      totals: aggregateAndCompute(totalRows),
      campaigns: campaigns
        .map((c) => ({
          campaignId: c.campaignId,
          campaignName: c.campaignName,
          ...aggregateAndCompute(c.rows),
        }))
        .sort((a, b) => b.spendDollars - a.spendDollars),
    };
  },
};

const adsCreativePerformance: McpTool = {
  name: "ads_creative_performance",
  title: "Meta ad creative performance",
  description:
    "Per-ad performance with the creative headline, body copy and image URL attached. This is the tool for diagnosing creative fatigue — spend and ROAS per individual creative rather than per campaign.",
  readOnly: true,
  schema: { ...RANGE_SCHEMA, limit: { type: "integer", min: 1, max: 200, default: 25 } },
  async run(ctx, args) {
    const range = resolveRange(args, ctx.now(), 30);
    const limit = args.limit as number;
    const ads = await getInsightsByAdCreative(ctx.db, range.startDate, range.endDate);

    const ranked = ads
      .map((a) => ({
        adId: a.adId,
        adName: a.adName,
        campaignName: a.campaignName,
        creativeTitle: a.creativeTitle,
        creativeBody: a.creativeBody,
        creativeImageUrl: a.creativeImageUrl,
        ...aggregateAndCompute(a.rows),
      }))
      .sort((a, b) => b.spendDollars - a.spendDollars);

    return {
      range: describeRange(range),
      adsMatched: ranked.length,
      adsReturned: Math.min(limit, ranked.length),
      ads: ranked.slice(0, limit),
    };
  },
};

const storePerformance: McpTool = {
  name: "store_performance",
  title: "Shopify store performance",
  description:
    "Shopify order volume and revenue for a date range, split by one-off versus subscription, plus a daily breakdown for spotting trends and anomalies. Defaults to the last 30 days.",
  readOnly: true,
  schema: { ...RANGE_SCHEMA },
  async run(ctx, args) {
    const range = resolveRange(args, ctx.now(), 30);
    const days = Math.max(
      1,
      Math.round((range.endDate.getTime() - range.startDate.getTime()) / (24 * 60 * 60 * 1000))
    );

    const [summary, daily] = await Promise.all([
      getOrderSummary(ctx.db, days),
      getDailyOrders(ctx.db, range.startDate, range.endDate),
    ]);

    return {
      range: describeRange(range),
      summary: {
        totalOrders: summary.totalOrders,
        totalRevenueDollars: dollars(summary.totalRevenueCents),
        subscriptionOrders: summary.subscriptionOrders,
        subscriptionRevenueDollars: dollars(summary.subscriptionRevenueCents),
      },
      daily: daily.map((d) => ({
        date: d.date,
        orders: d.orders,
        revenueDollars: dollars(d.revenueCents),
        subscriptionOrders: d.subscriptionOrders,
      })),
    };
  },
};

const storeTopProducts: McpTool = {
  name: "store_top_products",
  title: "Top selling products",
  description:
    "The best-selling products by order frequency, with price and product type. Useful for picking what to feature in an email or bundle with slow stock.",
  readOnly: true,
  schema: { limit: { type: "integer", min: 1, max: 100, default: 10 } },
  async run(ctx, args) {
    const products = await getTopProducts(ctx.db, args.limit as number);
    return {
      products: products.map((p) => ({
        title: p.title,
        productType: p.productType ?? null,
        priceDollars: dollars(p.priceCents),
      })),
    };
  },
};

const subscriptionLtv: McpTool = {
  name: "subscription_ltv",
  title: "Subscription lifetime value",
  description:
    "Lifetime value, tenure and churn for the Really Awesome Doodles subscription, broken down by pricing tier. Use this to judge whether ad spend is profitable on an LTV basis rather than first-order ROAS.",
  readOnly: true,
  schema: { churnThresholdDays: { type: "integer", min: 1, max: 400 } },
  async run(ctx, args) {
    const orders = await getSubscriptionOrders(ctx.db);
    const summary = computeLtvSummary(
      orders,
      ctx.now(),
      args.churnThresholdDays as number | undefined
    );

    return {
      totalSubscribers: summary.totalSubscribers,
      activeSubscribers: summary.activeSubscribers,
      churnedSubscribers: summary.churnedSubscribers,
      avgTenureMonths: summary.avgTenureMonths,
      medianTenureMonths: summary.medianTenureMonths,
      avgLtvDollars: dollars(summary.avgLtvCents),
      avgMonthlyRevenueDollars: dollars(summary.avgMonthlyRevenueCents),
      tiers: summary.tiers.map((t) => ({
        tier: t.tier,
        monthlyPrice: t.monthlyPrice,
        subscribers: t.subscribers,
        active: t.active,
        churned: t.churned,
        avgTenureMonths: t.avgTenureMonths,
        avgLtvDollars: dollars(t.avgLtvCents),
        avgMonthlyRevenueDollars: dollars(t.avgMonthlyRevenueCents),
      })),
    };
  },
};

const emailSmsPerformance: McpTool = {
  name: "email_sms_performance",
  title: "Email and SMS performance",
  description:
    "Attentive email and SMS delivery, clicks, conversions, revenue and unsubscribes for a date range. This data is imported manually — check data_freshness before treating a quiet week as a real result.",
  readOnly: true,
  schema: { ...RANGE_SCHEMA },
  async run(ctx, args) {
    const range = resolveRange(args, ctx.now(), 30);
    const s = await getAttentiveWeekSummary(ctx.db, range.startDate, range.endDate);

    return {
      range: describeRange(range),
      email: {
        delivered: s.emailDelivered,
        clicks: s.emailClicks,
        conversions: s.emailConversions,
        revenueDollars: dollars(s.emailRevenueCents),
        unsubscribes: s.emailUnsubscribes,
      },
      sms: {
        delivered: s.smsDelivered,
        clicks: s.smsClicks,
        conversions: s.smsConversions,
        revenueDollars: dollars(s.smsRevenueCents),
        unsubscribes: s.smsUnsubscribes,
      },
      attributed: {
        conversions: s.totalAttributedConversions,
        revenueDollars: dollars(s.totalAttributedRevenueCents),
      },
    };
  },
};

const socialPerformance: McpTool = {
  name: "social_performance",
  title: "Organic social performance",
  description:
    "Instagram and Facebook organic post performance for a date range: aggregate reach and engagement, plus the top posts ranked by engagement rate. Use it to find a concept worth turning into an ad.",
  readOnly: true,
  schema: { ...RANGE_SCHEMA, limit: { type: "integer", min: 1, max: 100, default: 20 } },
  async run(ctx, args) {
    const range = resolveRange(args, ctx.now(), 30);
    const limit = args.limit as number;
    const days = Math.max(
      1,
      Math.round((range.endDate.getTime() - range.startDate.getTime()) / (24 * 60 * 60 * 1000))
    );

    const [summary, posts] = await Promise.all([
      getPostSummary(ctx.db, days),
      getPostsByDateRange(ctx.db, range.startDate, range.endDate),
    ]);

    const ranked = posts
      .map((p) => {
        const engagements = p.likeCount + p.commentsCount + p.saved + p.shares;
        return {
          id: p.id,
          caption: p.caption,
          format: p.mediaProductType ?? p.mediaType,
          permalink: p.permalink,
          postedAt: p.postedAt.toISOString(),
          reach: p.reach,
          impressions: p.impressions,
          likes: p.likeCount,
          comments: p.commentsCount,
          saves: p.saved,
          shares: p.shares,
          plays: p.plays,
          engagementRate: p.reach > 0 ? (engagements / p.reach) * 100 : null,
        };
      })
      .sort((a, b) => (b.engagementRate ?? -1) - (a.engagementRate ?? -1));

    return {
      range: describeRange(range),
      summary,
      postsMatched: ranked.length,
      postsReturned: Math.min(limit, ranked.length),
      posts: ranked.slice(0, limit),
    };
  },
};

const inventoryStatus: McpTool = {
  name: "inventory_status",
  title: "Inventory status",
  description:
    "Stock levels with days of cover and a classification per variant: stockout, critical-cover (too late to reorder), low-cover (reorder now), slow-mover (cash tied up) or healthy. Untracked and non-active variants are ignored because Shopify reports them as zero. Returns only problems unless includeHealthy is set.",
  readOnly: true,
  schema: {
    includeHealthy: { type: "boolean", default: false },
    reorderLeadTimeDays: { type: "integer", min: 1, max: 365 },
    criticalCoverDays: { type: "integer", min: 1, max: 365 },
  },
  async run(ctx, args) {
    const items = await getInventoryItems(ctx.db);
    const options = {
      reorderLeadTimeDays: args.reorderLeadTimeDays as number | undefined,
      criticalCoverDays: args.criticalCoverDays as number | undefined,
    };

    const classified = items.map((item) => {
      const velocity = computeDailyVelocity(item.unitsSoldLast30d, SALES_WINDOW_DAYS);
      return {
        variantId: item.variantId,
        productTitle: item.productTitle,
        variantTitle: item.variantTitle,
        sku: item.sku,
        quantity: item.quantity,
        unitsSoldLast30d: item.unitsSoldLast30d,
        dailyVelocity: velocity,
        daysOfCover: computeDaysOfCover(item.quantity, velocity),
        classification: classifyItem(item, options),
      };
    });

    const includeHealthy = args.includeHealthy as boolean;
    const shown = includeHealthy
      ? classified
      : classified.filter((i) => i.classification !== "healthy" && i.classification !== "ignored");

    return {
      variantsChecked: classified.length,
      itemsReturned: shown.length,
      items: shown,
    };
  },
};

const calendarEntriesTool: McpTool = {
  name: "calendar_entries",
  title: "Marketing calendar",
  description:
    "Planned and past marketing calendar entries — email, SMS, ads, reels, posts, blogs — with channel, status and notes. Defaults to the next 30 days; pass explicit dates to look backwards.",
  readOnly: true,
  schema: { ...RANGE_SCHEMA },
  async run(ctx, args) {
    const range = resolveRange(args, ctx.now(), 30, "forward");
    const entries = await getEntriesByWeek(ctx.db, range.startDate, range.endDate);

    return {
      range: describeRange(range),
      entries: entries.map((e) => ({
        id: e.id,
        date: e.date.toISOString(),
        channel: e.channel,
        title: e.title,
        status: e.status,
        notes: e.notes,
        aiSuggested: e.aiSuggested === 1,
      })),
    };
  },
};

const brandVoice: McpTool = {
  name: "brand_voice",
  title: "Brand voice rules",
  description:
    "Tara's voice rules and banned words, which all marketing copy must respect, plus optionally the writing samples used for few-shot prompting. Note: blog posts deliberately do NOT use this voice — they are friendly and SEO-oriented instead.",
  readOnly: true,
  schema: { includeSamples: { type: "boolean", default: false } },
  async run(ctx, args) {
    const [samples, rules, bannedWords] = await Promise.all([
      getAllSamples(ctx.db),
      getAllRules(ctx.db),
      getAllBannedWords(ctx.db),
    ]);

    const includeSamples = args.includeSamples as boolean;
    return {
      rules: rules.map((r) => r.rule),
      bannedWords: bannedWords.map((b) => b.word),
      sampleCount: samples.length,
      samples: includeSamples
        ? samples.map((s) => ({ title: s.title, content: s.content, tags: s.tags ?? [] }))
        : null,
    };
  },
};

const currentAlerts: McpTool = {
  name: "current_alerts",
  title: "Current alerts",
  description:
    "Runs every deterministic alert check right now and returns what fires, as structured data — the same checks the daily scheduled run uses. If someChecksFailed is true, a check errored and the result is incomplete: do not read it as an all-clear.",
  readOnly: true,
  schema: {},
  async run(ctx) {
    const alerts = await runAlertChecks(ctx.db);
    return {
      alerts,
      someChecksFailed: alerts.some((a) => a.type === CHECK_FAILED_TYPE),
    };
  },
};

export const READ_TOOLS: McpTool[] = [
  dataFreshness,
  adsPerformance,
  adsCreativePerformance,
  storePerformance,
  storeTopProducts,
  subscriptionLtv,
  emailSmsPerformance,
  socialPerformance,
  inventoryStatus,
  calendarEntriesTool,
  brandVoice,
  currentAlerts,
];

// ─── Dispatch ─────────────────────────────────────────────────────────

export interface JsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

export function toJsonSchema(schema: ArgSchema): JsonSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const [key, spec] of Object.entries(schema)) {
    switch (spec.type) {
      case "date":
        properties[key] = { type: "string", format: "date", description: "YYYY-MM-DD" };
        break;
      case "enum":
        properties[key] = { type: "string", enum: [...spec.values] };
        break;
      case "integer":
        properties[key] = {
          type: "integer",
          ...(spec.min !== undefined ? { minimum: spec.min } : {}),
          ...(spec.max !== undefined ? { maximum: spec.max } : {}),
        };
        break;
      default:
        properties[key] = { type: spec.type };
    }
    if ("default" in spec && spec.default !== undefined) {
      properties[key].default = spec.default;
    }
    if (spec.required) required.push(key);
  }

  return { type: "object", properties, required };
}

export function findTool(name: string): McpTool | undefined {
  return READ_TOOLS.find((t) => t.name === name);
}

export async function dispatchTool(
  ctx: McpToolContext,
  name: string,
  rawArgs: Record<string, unknown> | undefined
): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) {
    throw new Error(
      `Unknown tool "${name}". Available tools: ${READ_TOOLS.map((t) => t.name).join(", ")}`
    );
  }
  // Validation runs before the query so a bad argument costs nothing and,
  // more importantly, cannot half-apply.
  return tool.run(ctx, parseArgs(rawArgs, tool.schema));
}
