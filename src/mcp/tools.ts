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

import { randomUUID } from "node:crypto";
import type { Db } from "@/db/client";
import { queryLog } from "@/db/schema";
import type { AnalyticsDb } from "./analytics-db";
import { runQuery, describeViews, ROW_CAP, type QueryDeps } from "./query";
import {
  parseArgs,
  resolveRange,
  McpArgumentError,
  RANGE_SCHEMA,
  type ArgSchema,
  type ParsedArgs,
} from "./args";

import { getDataFreshness } from "@/db/freshness";
import { getDataQuality, anyQualityIssue } from "@/db/quality";
import { getInsightTotals, getInsightsByCampaign, getInsightsByAdCreative } from "@/domain/meta/queries";
import { aggregateAndCompute } from "@/domain/meta/metrics";
import { getOrderSummary, getDailyOrders, getTopProducts } from "@/domain/shopify/queries";
import {
  getSubscriptionFacts,
  getSnapshotFacts,
  getTierChangeFacts,
} from "@/domain/subscriptions/queries";
import {
  summariseActive,
  computeLtv,
  computeChanges,
  type LtvBlock,
  type Granularity,
} from "@/domain/subscriptions/analytics";
import {
  getAttentiveWeekSummary,
  getCampaignMessagePerformance,
  getCampaignSegmentPerformance,
  getJourneyMessagePerformance,
  getMessageCostTotals,
} from "@/domain/attentive/queries";
import { getPostSummary, getPostsByDateRange } from "@/domain/social/queries";
import { getInventoryItems, getPoolVariantRows } from "@/domain/inventory/queries";
import {
  assessPool,
  findUndeclaredPoolCandidates,
  parsePoolDeclaration,
  type PoolVariant,
} from "@/domain/inventory/pools";
import POOL_DECLARATION from "@/domain/inventory/inventory-pools.json";
import { classifyItem } from "@/domain/inventory/checks";
import { computeDailyVelocity, computeDaysOfCover } from "@/domain/inventory/velocity";
import { getEntriesByWeek } from "@/domain/calendar/queries";
import { getAllSamples, getAllRules, getAllBannedWords } from "@/domain/voice/queries";
import {
  foldExperiments,
  validateDeclaration,
  validateResult,
  OUTCOMES,
  type ExperimentStatus,
  type Outcome,
} from "@/domain/experiments/experiments";
import {
  getExperimentDeclarations,
  getExperimentResults,
  experimentExists,
  insertDeclaration,
  insertResult,
} from "@/domain/experiments/queries";
import {
  CHANNELS,
  UNSPECIFIED,
  isChannel,
  rulesForChannel,
  type RuleAudience,
} from "@/domain/voice/rules";
import { selectSamples, describeSampleSelection, type VoiceProfile } from "@/domain/voice/voice";
import { voiceCheck } from "@/domain/voice/voice-check";
import {
  foldDrafts,
  validateDraft,
  validateDecision,
  DECISIONS,
  DRAFT_TYPES,
  type Decision,
  type DraftStatus,
  type DraftType,
} from "@/domain/drafts/drafts";
import type { AttentiveWriteClient } from "@/integrations/attentive-write";
import { computePushPlan, planToken, canPush } from "@/domain/segments/push";
import {
  getSegmentMembers,
  getLastRealPush,
  recordPush,
  getPushHistory,
} from "@/domain/segments/queries";
import { SEED_SEGMENTS } from "@/domain/shopify/segments";
import { isAgentAttribution } from "@/domain/drafts/drafts";
import {
  computeUnitEconomics,
  bandMargins,
  thresholdVerdict,
} from "@/domain/economics/unit-economics";
import {
  getRateSettings,
  getOrdersForEconomics,
  getAdSpend,
  getNewCustomerOrders,
  AD_CHANNELS,
  BUSINESS_LINES,
} from "@/domain/economics/queries";
import { computeAmer } from "@/domain/economics/amer";
import {
  computeTargetCpa,
  realisedChurnedLtv,
  TARGET_LTV_CAC_RATIO,
} from "@/domain/economics/target-cpa";
import {
  getDrafts,
  getDraftDecisions,
  draftExists,
  insertDraft,
  insertDraftDecision,
} from "@/domain/drafts/queries";
import { runAlertChecks } from "@/domain/alerts/runner";
import { CHECK_FAILED_TYPE } from "@/domain/alerts/checks";
import { getPilotEntries, noteExists, appendPilotEntry } from "@/domain/pilot/queries";
import {
  foldNotes,
  validateEntry,
  renderMarkdown,
  NOTE_KINDS,
  type NoteKind,
} from "@/domain/pilot/notes";

export interface McpToolContext {
  db: Db;
  /** Injected so tests can freeze time — no wall clock inside a tool. */
  now: () => Date;
  /**
   * The read-only connection the `query` tool runs on. Absent when
   * ANALYTICS_DATABASE_URL is unset, in which case that tool reports itself
   * unavailable — it never falls back to `db`, which connects as the owner.
   */
  analytics?: AnalyticsDb;
  /**
   * The Attentive write client. Absent when ATTENTIVE_API_KEY is unset, in
   * which case the push tools report themselves unavailable — they never fall
   * through to a no-op that reads like a push that happened.
   */
  attentive?: AttentiveWriteClient;
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
    "How recently each data source was synced, and whether any is stale. Call this before drawing conclusions — a stale source looks identical to a quiet one. Where a source records its runs, `lastRun.outcome` says why it looks the way it does: ok, no-data (ran, found nothing), auth-failed, rate-limited, api-error, or not-configured (never ran). Zero rows with outcome no-data is a real answer; zero rows with any other outcome is a fault. Attentive (email/SMS) is imported by hand, so its timestamp is the newest data point rather than a sync time. `quality` is a separate axis: rows that arrived through a healthy sync but cannot answer the question being asked of them. A check with status `unknown` inspected nothing and is not a pass.",
  readOnly: true,
  schema: {},
  async run(ctx) {
    const [sources, quality] = await Promise.all([
      getDataFreshness(ctx.db, ctx.now()),
      getDataQuality(ctx.db),
    ]);
    return {
      sources,
      anyStale: sources.some((s) => s.stale),
      quality,
      anyQualityIssue: anyQualityIssue(quality),
    };
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

/** Rounds tenure to something readable without implying false precision. */
const months = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

function describeLtvBlock(block: LtvBlock) {
  return {
    subscribers: block.subscribers,
    tenureIsFloor: block.tenureIsFloor,
    avgTenureMonths: months(block.avgTenureMonths),
    medianTenureMonths: months(block.medianTenureMonths),
    avgLtvDollars: block.avgLtvCents === null ? null : dollars(block.avgLtvCents),
    totalLtvDollars: dollars(block.totalLtvCents),
    byGroup: block.byGroup.map((g) => ({
      tier: g.tier,
      pricingCohort: g.pricingCohort,
      billingCadence: g.billingCadence,
      subscribers: g.subscribers,
      avgTenureMonths: months(g.avgTenureMonths),
      medianTenureMonths: months(g.medianTenureMonths),
      avgLtvDollars: g.avgLtvCents === null ? null : dollars(g.avgLtvCents),
      totalLtvDollars: dollars(g.totalLtvCents),
    })),
  };
}

const subscriptionSummary: McpTool = {
  name: "subscription_summary",
  title: "Subscription summary",
  description:
    "Current state of the Really Awesome Doodles subscription base from Seal: active counts by tier, pricing cohort and billing interval, plus MRR, ARR and how many subscriptions are in dunning. MRR amortises annual plans (annual price / 12) rather than booking the whole charge in the month it renews, and is reported split into monthly-billed and annual-amortised as well as combined. Subscriptions with anomalous prices are counted in the breakdowns but excluded from all money, and reported under `excluded` — check that before quoting MRR.",
  readOnly: true,
  schema: {},
  async run(ctx) {
    const facts = await getSubscriptionFacts(ctx.db);
    const s = summariseActive(facts);

    return {
      activeTotal: s.activeTotal,
      byTier: s.byTier,
      byPricingCohort: s.byPricingCohort,
      byBillingInterval: s.byBillingInterval,
      byGroup: s.byGroup.map((g) => ({
        tier: g.tier,
        pricingCohort: g.pricingCohort,
        billingCadence: g.billingCadence,
        subscribers: g.subscribers,
        mrrDollars: dollars(g.mrrCents),
      })),
      mrr: {
        monthlyBilledDollars: dollars(s.mrr.monthlyBilledCents),
        annualAmortisedDollars: dollars(s.mrr.annualAmortisedCents),
        totalDollars: dollars(s.mrr.totalCents),
      },
      arrDollars: dollars(s.arrCents),
      dunning: s.dunning,
      excluded: {
        priceAnomalies: s.excluded.priceAnomalies,
        anomalousTotalDollars: dollars(s.excluded.anomalousTotalCents),
        missingPrice: s.excluded.missingPrice,
      },
      notes: [
        "A billing interval of '13 month' is a one-time pre-sale correction and counts as annual.",
        "Price anomalies are excluded from MRR and ARR. They are data faults, not revenue.",
      ],
    };
  },
};

const subscriptionLtv: McpTool = {
  name: "subscription_ltv",
  title: "Subscription lifetime value",
  description:
    "Tenure and lifetime value, split so that unfinished subscriptions never contaminate the finished ones. `churned` is the honest number: those runs are complete. `active` is tenure-to-date and is INCOMPLETE by construction — it understates what those subscribers will ultimately be worth, so never quote it as an LTV. Each cohort is split again into `observed` (true signup date known) and `migrated` (the record came from the Color Happy bulk import, so order_placed is the migration date and tenure is a FLOOR, not a measurement — real tenure is longer). Every block breaks down by tier, pricing cohort and billing cadence. LTV is estimated as elapsed billing periods times current price; invoice history is not synced, so it does not reflect mid-run price changes.",
  readOnly: true,
  schema: {},
  async run(ctx) {
    const facts = await getSubscriptionFacts(ctx.db);
    const r = computeLtv(facts, ctx.now());

    return {
      churned: {
        complete: true,
        meaning: "Finished runs. This is the honest LTV and tenure number.",
        observed: describeLtvBlock(r.churned.observed),
        migrated: describeLtvBlock(r.churned.migrated),
      },
      active: {
        complete: false,
        meaning:
          "Tenure to date on runs that have not finished. Understates final LTV; do not compare directly against the churned cohort.",
        observed: describeLtvBlock(r.active.observed),
        migrated: describeLtvBlock(r.active.migrated),
      },
      excluded: r.excluded,
      notes: [
        "Churned and active are never averaged together; doing so is what made the previous version understate tenure.",
        "`migrated` blocks have tenureIsFloor=true: order_placed is the 2026-05/06 migration timestamp, not the original Color Happy signup date.",
        "LTV is an estimate from current price x elapsed billing periods, not collected revenue.",
      ],
    };
  },
};

const subscriptionChanges: McpTool = {
  name: "subscription_changes",
  title: "Subscription movement",
  description:
    "Movement over a date range: new, cancelled, upgraded, downgraded and net change, with the source column named for every number. New subscriptions come from order_placed and EXCLUDE bulk-migrated records, whose order_placed is an import timestamp rather than a signup (counting those would report the migration as a record sales day). Cancellations come from cancelled_on. Tier transitions are read from Seal's per-subscription log, which begins 2026-05-22 and covers the June launch; the daily snapshots (which only began 2026-09-02) are used as corroboration in `snapshotCheck` and nothing else. A window ending before 2026-05-22 returns available=false with a reason rather than a fabricated zero; a window merely REACHING BACK past it is answered with coversRequestedRange=false and a caveat, meaning the counts are a floor. A subscription is counted once by where it ended up, not once per event — `transitions` is the raw event count and `churnedSubscriptions` how many were moved more than once. Watch `grandfatheredSparkToStudio`: that upgrade path is the most important movement number in the business. `mispricedAfterChange` lists ACTIVE subscriptions that moved tier in the window and are STILL not on the grid price for the tier they now sit on — the 14076883 billing bug. These are undercharges as often as overcharges, so the `priceAnomaly` flag (which only fires above 2x expected) does not catch them. Pass granularity for a time series.",
  readOnly: true,
  schema: {
    ...RANGE_SCHEMA,
    granularity: { type: "enum", values: ["day", "week", "month"] as const },
  },
  async run(ctx, args) {
    const range = resolveRange(args, ctx.now(), 30);
    const startDay = range.startDate.toISOString().slice(0, 10);
    const endDay = range.endDate.toISOString().slice(0, 10);

    const [facts, snapshots, tierChanges] = await Promise.all([
      getSubscriptionFacts(ctx.db),
      getSnapshotFacts(ctx.db, startDay, endDay),
      getTierChangeFacts(ctx.db),
    ]);

    const r = computeChanges({
      facts,
      snapshots,
      tierChanges,
      start: range.startDate,
      end: range.endDate,
      granularity: args.granularity as Granularity | undefined,
    });

    return {
      range: describeRange(range),
      newSubscriptions: r.newSubscriptions,
      cancellations: r.cancellations,
      netChange: r.netChange,
      tierTransitions: r.tierTransitions,
      series: r.series,
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

/**
 * Reads the whole voice profile out of the database in one go.
 *
 * Returns `null` when every part of it is empty. Four rules, seven banned words
 * and eighty-four samples is what production holds; all three coming back empty
 * is a read that did not happen, not a brand with no rules — and handing that
 * back as data invites copy written against nothing and checked against
 * nothing. Zero is UNKNOWN until something proves it means zero.
 */
async function readVoiceProfile(ctx: McpToolContext): Promise<VoiceProfile | null> {
  const [samples, rules, bannedWords] = await Promise.all([
    getAllSamples(ctx.db),
    getAllRules(ctx.db),
    getAllBannedWords(ctx.db),
  ]);

  if (samples.length === 0 && rules.length === 0 && bannedWords.length === 0) return null;

  return {
    samples: samples.map((s) => ({
      id: s.id,
      title: s.title,
      content: s.content,
      tags: (s.tags as string[] | null) ?? [],
    })),
    rules: rules.map((r) => r.rule),
    // Split by severity, as the DB loader does. Reading every word as a block
    // here would put the MCP surface back where #60 started.
    bannedWords: bannedWords.filter((b) => b.severity === "block").map((b) => b.word),
    discouragedWords: bannedWords.filter((b) => b.severity !== "block").map((b) => b.word),
  };
}

const EMPTY_CORPUS_ERROR =
  "The voice corpus is empty: no samples, no rules and no banned words. " +
  "Production holds 84 samples, 4 rules and 7 banned words, so this is a failed " +
  "read rather than a brand without rules. Refusing rather than returning an " +
  "empty rule set that would read as permission.";

const brandVoice: McpTool = {
  name: "brand_voice",
  title: "Brand voice rules",
  description:
    "Tara's voice rules, word preferences and writing samples for a given channel. " +
    "bannedWords must never appear — copy containing one is refused. discouragedWords are preferences: worth avoiding where there is a natural alternative, never worth discarding finished copy over. " +
    "Pass the channel you are writing for: rules are scoped, and a rule that is correct on Instagram (\"comments get a link\") is wrong in an inbox. " +
    "Omitting the channel applies every rule, which is the strictest set, not the laxest. " +
    "Each rule says whether anything mechanically enforces it — an unenforced rule is guidance that voice_check will not catch. " +
    "If no sample carries the channel's tag, the whole corpus stands in rather than returning nothing, and samples.source says corpus-fallback. " +
    "Note: blog posts deliberately do NOT use this voice; they are friendly and SEO-oriented instead.",
  readOnly: true,
  schema: {
    channel: { type: "enum", values: CHANNELS },
    includeSamples: { type: "boolean", default: false },
  },
  async run(ctx, args) {
    const profile = await readVoiceProfile(ctx);
    if (!profile) return { error: EMPTY_CORPUS_ERROR };

    const audience: RuleAudience = isChannel(args.channel) ? args.channel : UNSPECIFIED;
    const applicable = rulesForChannel(profile.rules, audience);
    const applicableText = new Set(applicable.map((r) => r.text));
    const selection = selectSamples(profile.samples, audience);
    const includeSamples = args.includeSamples as boolean;

    return {
      audience,
      rules: applicable.map((r) => ({
        text: r.text,
        enforced: r.enforcement.kind === "forbids",
        ...(r.enforcement.kind === "unenforced" ? { unenforcedBecause: r.enforcement.why } : {}),
      })),
      // Named, not merely absent. A rule the caller cannot see cannot be told
      // apart from one that was never written, and the difference matters when
      // the caller is deciding whether a convention is safe to use here.
      excusedOnThisChannel: profile.rules.filter((r) => !applicableText.has(r)),
      bannedWords: profile.bannedWords,
      // Separate lists, because they mean different things. A word here will
      // be flagged, never refused — telling the model both are prohibitions
      // is what made "delight" unpublishable (#60).
      discouragedWords: profile.discouragedWords ?? [],
      samples: {
        source: selection.source.kind,
        explanation: describeSampleSelection(selection),
        // Both what came back and what matched, so a subset is never read as
        // the whole set.
        used: selection.samples.length,
        corpusSize: selection.corpusSize,
        items: includeSamples
          ? selection.samples.map((s) => ({ title: s.title, content: s.content, tags: s.tags }))
          : null,
      },
    };
  },
};

/**
 * The enforcement half of `brand_voice`, exposed so the caller that writes the
 * copy is also the caller that checks it.
 *
 * Rules that cannot be enforced are wishes. Claude has the rules through
 * `brand_voice`; without this it has no way to find out whether what it wrote
 * actually obeys them, and the check would exist for the Figma plugin and the
 * worker but not for the model doing the marketing.
 */
const voiceCheckTool: McpTool = {
  name: "voice_check",
  title: "Check copy against the brand voice",
  description:
    "Checks a piece of copy against Tara's voice rules and banned words for a channel, and returns the violations. " +
    "Run anything you wrote through this before proposing it. Pass the same channel you passed to brand_voice. " +
    "Fails closed: empty text, or a profile with nothing to check, comes back ok:false rather than clean — a check that evaluated nothing has established nothing. " +
    "`advisories` lists discouraged words that appeared; they never affect `ok`. Reword if it is easy, but do not throw away good copy over one. " +
    "Read `enforced` and `unenforced` alongside `ok`: a clean result over three uncheckable rules is not a clean result over three checked ones.",
  readOnly: true,
  schema: {
    text: { type: "string", required: true },
    channel: { type: "enum", values: CHANNELS },
  },
  async run(ctx, args) {
    const profile = await readVoiceProfile(ctx);
    if (!profile) return { error: EMPTY_CORPUS_ERROR };

    const audience: RuleAudience = isChannel(args.channel) ? args.channel : UNSPECIFIED;
    const result = voiceCheck(args.text as string, audience, profile);

    return {
      ok: result.ok,
      // `channel` on the underlying result; named `audience` here because
      // `unspecified` is not a channel.
      audience: result.channel,
      violations: result.violations,
      advisories: result.advisories,
      enforced: result.enforced,
      unenforced: result.unenforced,
    };
  },
};

// ─── Experiments ──────────────────────────────────────────────────────

/** Every status `experiments_list` can filter on, including the derived ones. */
const EXPERIMENT_STATUSES = [...OUTCOMES, "running", "awaiting_result", "all"] as const;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const experimentStart: McpTool = {
  name: "experiment_start",
  title: "Declare an experiment",
  description:
    "Record an experiment BEFORE you know how it turned out. Every recommendation you make that someone acts on should get one of these. " +
    "successCriteria is required and there is no way to change it later: recording a result writes a separate record, and this tool is the only thing that can set it. " +
    "That is deliberate — a bar written after the result is known is not a bar. Same for baselineValue: capture it now, because a baseline computed later is computed by someone who already knows the answer. " +
    "plannedEndDate is required too, so the window cannot be extended until the numbers look good. " +
    "Returns experimentId, which experiment_record_result needs.",
  readOnly: false,
  schema: {
    name: { type: "string", required: true },
    hypothesis: { type: "string", required: true },
    whatWeChanged: { type: "string", required: true },
    successCriteria: { type: "string", required: true },
    primaryMetric: { type: "string", required: true },
    baselineBasis: { type: "string", required: true },
    startDate: { type: "date", required: true },
    plannedEndDate: { type: "date", required: true },
    baselineValue: { type: "number" },
    relatedNoteIds: { type: "string" },
    author: { type: "string", default: "claude" },
  },
  async run(ctx, args) {
    const now = ctx.now();
    const id = `${now.toISOString()}-${randomUUID().slice(0, 8)}`;

    const relatedNoteIds =
      typeof args.relatedNoteIds === "string" && args.relatedNoteIds.trim() !== ""
        ? args.relatedNoteIds.split(",").map((n) => n.trim()).filter(Boolean)
        : [];

    const declaration = {
      id,
      name: args.name as string,
      hypothesis: args.hypothesis as string,
      whatWeChanged: args.whatWeChanged as string,
      successCriteria: args.successCriteria as string,
      primaryMetric: args.primaryMetric as string,
      baselineValue: typeof args.baselineValue === "number" ? args.baselineValue : null,
      baselineBasis: args.baselineBasis as string,
      startDate: isoDay(args.startDate as Date),
      plannedEndDate: isoDay(args.plannedEndDate as Date),
      relatedNoteIds,
      author: args.author as string,
      createdAt: now,
    };

    const validation = validateDeclaration(declaration);
    if (!validation.ok) throw new McpArgumentError(validation.error);

    await insertDeclaration(ctx.db, declaration);

    return {
      written: true,
      experimentId: id,
      successCriteria: declaration.successCriteria,
      plannedEndDate: declaration.plannedEndDate,
      // Said back deliberately: the caller should see the bar it just committed
      // to, because after this there is no tool that can change it.
      note:
        "Declared. successCriteria and baselineValue cannot be changed from here on — " +
        "experiment_record_result writes a separate record and takes neither.",
    };
  },
};

const experimentRecordResult: McpTool = {
  name: "experiment_record_result",
  title: "Record an experiment result",
  description:
    "Record how a declared experiment turned out, judged against the successCriteria it was started with. " +
    "This tool cannot modify the declaration — it takes no hypothesis, no baseline and no success criteria, and passing one is an error rather than something it ignores. " +
    "outcome is win, loss or inconclusive; expect inconclusive to be the most common, because most tests on a business this size will not reach significance. " +
    "learnings is required even then, and especially then: usually the finding is that the metric was wrong, the window too short, or the change too small to detect. " +
    "A correction is another call, not an edit — the newest result decides the status and the earlier one stays visible.",
  readOnly: false,
  schema: {
    experimentId: { type: "string", required: true },
    outcome: { type: "enum", values: OUTCOMES, required: true },
    concludedOn: { type: "date", required: true },
    learnings: { type: "string", required: true },
    resultValue: { type: "number" },
    author: { type: "string", default: "claude" },
  },
  async run(ctx, args) {
    const experimentId = args.experimentId as string;

    // Recording against an experiment that does not exist would fold to an
    // orphan, which is reserved for genuine data damage. A typo'd id should
    // fail here rather than quietly create an unreachable result.
    if (!(await experimentExists(ctx.db, experimentId))) {
      throw new McpArgumentError(
        `No experiment with id "${experimentId}". Call experiments_list to see the declared ones, ` +
          `or experiment_start to declare this one — but note that starting it now means its ` +
          `success criteria would be written after the result is known.`
      );
    }

    const now = ctx.now();
    const entry = {
      id: `${now.toISOString()}-${randomUUID().slice(0, 8)}`,
      experimentId,
      outcome: args.outcome as Outcome,
      resultValue: typeof args.resultValue === "number" ? args.resultValue : null,
      concludedOn: isoDay(args.concludedOn as Date),
      learnings: args.learnings as string,
      author: args.author as string,
      createdAt: now,
    };

    const validation = validateResult(entry);
    if (!validation.ok) throw new McpArgumentError(validation.error);

    await insertResult(ctx.db, entry);

    return { written: true, resultId: entry.id, experimentId, outcome: entry.outcome };
  },
};

const experimentsList: McpTool = {
  name: "experiments_list",
  title: "List experiments",
  description:
    "Every declared experiment with its success criteria, baseline and derived status. " +
    "Status is computed, never stored: 'running' while the declared window is open, 'awaiting_result' once it has closed with nothing recorded, otherwise the recorded outcome. " +
    "'awaiting_result' is the one to act on — an experiment nobody concluded is how a recommendation becomes folklore. " +
    "orphanedResults holds results whose experiment was never declared; that is data damage, not an experiment. " +
    "Reports both returned and matched, so a capped list is never mistaken for the whole set.",
  readOnly: true,
  schema: {
    status: { type: "enum", values: EXPERIMENT_STATUSES, default: "all" },
    limit: { type: "integer", min: 1, max: 500, default: 100 },
  },
  async run(ctx, args) {
    const [declarations, results] = await Promise.all([
      getExperimentDeclarations(ctx.db),
      getExperimentResults(ctx.db),
    ]);

    const { experiments: folded, orphanedResults } = foldExperiments(
      declarations,
      results,
      isoDay(ctx.now())
    );

    const status = args.status as ExperimentStatus | "all";
    const matched = status === "all" ? folded : folded.filter((e) => e.status === status);
    const limit = args.limit as number;
    const page = matched.slice(0, limit);

    // An empty array reads the same whether nobody has run an experiment or the
    // filter excluded everything, and those call for opposite responses.
    const note =
      folded.length === 0
        ? "No experiments have been declared. Use experiment_start before acting on a recommendation."
        : matched.length === 0
          ? `No experiment currently has status "${status}", though ${folded.length} have been declared.`
          : undefined;

    return {
      returned: page.length,
      matched: matched.length,
      totalDeclared: folded.length,
      ...(note ? { note } : {}),
      experiments: page.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        hypothesis: e.hypothesis,
        whatWeChanged: e.whatWeChanged,
        successCriteria: e.successCriteria,
        primaryMetric: e.primaryMetric,
        baselineValue: e.baselineValue,
        baselineBasis: e.baselineBasis,
        startDate: e.startDate,
        plannedEndDate: e.plannedEndDate,
        relatedNoteIds: e.relatedNoteIds,
        author: e.author,
        declaredAt: e.createdAt.toISOString(),
        result: e.result
          ? {
              outcome: e.result.outcome,
              resultValue: e.result.resultValue,
              concludedOn: e.result.concludedOn,
              learnings: e.result.learnings,
              recordedAt: e.result.createdAt.toISOString(),
            }
          : null,
        // Kept rather than overwritten: a reading that changed is itself data.
        supersededResults: e.supersededResults.map((r) => ({
          outcome: r.outcome,
          resultValue: r.resultValue,
          concludedOn: r.concludedOn,
          learnings: r.learnings,
          recordedAt: r.createdAt.toISOString(),
        })),
      })),
      orphanedResults: orphanedResults.map((r) => ({
        id: r.id,
        experimentId: r.experimentId,
        outcome: r.outcome,
        learnings: r.learnings,
        recordedAt: r.createdAt.toISOString(),
      })),
    };
  },
};

// ─── Drafts ───────────────────────────────────────────────────────────

const DRAFT_STATUSES = [...DECISIONS, "draft", "all"] as const;
const DRAFT_AUDIENCES = [...CHANNELS, UNSPECIFIED] as const;

const draftSave: McpTool = {
  name: "draft_save",
  title: "Save a draft",
  description:
    "Save a piece of copy — campaign brief, ad copy, email, SMS, social caption, product description, blog post. " +
    "The body is run through voice_check for the channel you name BEFORE anything is stored, and a draft that fails is not saved: the violations come back instead, so fix the copy and call again. " +
    "Pass the channel the copy is actually for; 'unspecified' applies every rule and is right for a brief nobody publishes. " +
    "Drafts are immutable — a revision is a new draft, so the text Tara reacted to stays readable next to her reaction. " +
    "Saving a draft is not publishing it and not approval. Use draft_record_decision to record what a person decided.",
  readOnly: false,
  schema: {
    type: { type: "enum", values: DRAFT_TYPES, required: true },
    title: { type: "string", required: true },
    channel: { type: "enum", values: DRAFT_AUDIENCES, required: true },
    body: { type: "string", required: true },
    author: { type: "string", default: "claude" },
  },
  async run(ctx, args) {
    const now = ctx.now();
    const draft = {
      id: `${now.toISOString()}-${randomUUID().slice(0, 8)}`,
      type: args.type as DraftType,
      title: args.title as string,
      channel: args.channel as RuleAudience,
      body: args.body as string,
      author: args.author as string,
      createdAt: now,
    };

    const validation = validateDraft(draft);
    if (!validation.ok) throw new McpArgumentError(validation.error);

    const profile = await readVoiceProfile(ctx);
    if (!profile) return { saved: false, error: EMPTY_CORPUS_ERROR };

    // The gate. #26 is explicit that retrofitting this onto a table already
    // full of unchecked rows ends with those rows grandfathered, so nothing
    // reaches the table without passing. It fails closed: an unparseable or
    // unrunnable check blocks the save, because a check that established
    // nothing is not a check that passed.
    //
    // This is the policy flip noted in #64. There, a style violation travels
    // with the text, because nothing auto-publishes and a blocked draft leaves
    // a human with nothing to fix. Here the draft is being *saved*, which is a
    // commitment, so the violation blocks.
    const check = voiceCheck(draft.body, draft.channel, profile);
    if (!check.ok) {
      return {
        saved: false,
        channel: draft.channel,
        violations: check.violations,
        rulesChecked: check.enforced,
        rulesUnenforced: check.unenforced,
        error:
          `Not saved: this copy does not pass the voice check for ${draft.channel}. ` +
          `Fix the copy and call again. If a rule itself is wrong, change it at /voice — ` +
          `do not work around it here, because there is no path that stores an unchecked draft.`,
      };
    }

    await insertDraft(ctx.db, { ...draft, voiceRulesChecked: check.enforced });

    return {
      saved: true,
      draftId: draft.id,
      channel: draft.channel,
      // Words Tara would rather avoid. Present on a SAVED draft deliberately:
      // they are a preference, not a gate, and discarding finished copy over
      // one is how a guardrail that blocks correct copy gets turned off (#60).
      advisories: check.advisories.length > 0 ? check.advisories : undefined,
      // Recorded on the row as well: rules change, and "this passed" means
      // nothing without "passed what".
      rulesChecked: check.enforced,
      rulesUnenforced: check.unenforced.length > 0 ? check.unenforced : undefined,
      note: "Saved as a draft. This is not approval and not publication.",
    };
  },
};

const draftRecordDecision: McpTool = {
  name: "draft_record_decision",
  title: "Record a decision about a draft",
  description:
    "Record what a PERSON decided about a draft: approved, rejected, or shipped. This tool records a decision that was made elsewhere — it does not make one, and nothing in this system publishes anything. " +
    "decidedBy must name the person, and an agent name is refused. " +
    "feedback is required on a rejection and is stored verbatim: a rejected draft plus the reason is the highest-signal record here, because it marks a boundary the model crossed. Do not summarise it. " +
    "Decisions are append-only, so a later approval sits alongside the earlier rejection rather than replacing it.",
  readOnly: false,
  schema: {
    draftId: { type: "string", required: true },
    decision: { type: "enum", values: DECISIONS, required: true },
    decidedBy: { type: "string", required: true },
    feedback: { type: "string", default: "" },
  },
  async run(ctx, args) {
    const draftId = args.draftId as string;

    if (!(await draftExists(ctx.db, draftId))) {
      throw new McpArgumentError(
        `No draft with id "${draftId}". Call drafts_list to see the saved ones.`
      );
    }

    const now = ctx.now();
    const entry = {
      id: `${now.toISOString()}-${randomUUID().slice(0, 8)}`,
      draftId,
      decision: args.decision as Decision,
      feedback: args.feedback as string,
      decidedBy: args.decidedBy as string,
      createdAt: now,
    };

    const validation = validateDecision(entry);
    if (!validation.ok) throw new McpArgumentError(validation.error);

    await insertDraftDecision(ctx.db, entry);

    return {
      recorded: true,
      decisionId: entry.id,
      draftId,
      decision: entry.decision,
      decidedBy: entry.decidedBy,
    };
  },
};

const draftsList: McpTool = {
  name: "drafts_list",
  title: "List drafts",
  description:
    "Saved drafts with their full text, the rules each was checked against, and every decision recorded about them. " +
    "Status is derived from the decisions: 'draft' until someone decides, then whatever they decided most recently. " +
    "Earlier decisions are kept — read feedbackHistory before writing anything new for the same channel, because a rejection and its reason are the clearest statement of what Tara does not want. " +
    "orphanedDecisions holds decisions whose draft does not exist; that is data damage. " +
    "Reports both returned and matched, so a capped list is never mistaken for the whole set.",
  readOnly: true,
  schema: {
    status: { type: "enum", values: DRAFT_STATUSES, default: "all" },
    channel: { type: "enum", values: DRAFT_AUDIENCES },
    type: { type: "enum", values: DRAFT_TYPES },
    limit: { type: "integer", min: 1, max: 200, default: 50 },
  },
  async run(ctx, args) {
    const [rows, decisions] = await Promise.all([getDrafts(ctx.db), getDraftDecisions(ctx.db)]);
    const { drafts: folded, orphanedDecisions } = foldDrafts(rows, decisions);

    const status = args.status as DraftStatus | "all";
    const channel = args.channel as RuleAudience | undefined;
    const type = args.type as DraftType | undefined;

    const matched = folded.filter(
      (d) =>
        (status === "all" || d.status === status) &&
        (channel === undefined || d.channel === channel) &&
        (type === undefined || d.type === type)
    );
    const page = matched.slice(0, args.limit as number);

    const filters = [
      status !== "all" ? `status "${status}"` : null,
      channel ? `channel "${channel}"` : null,
      type ? `type "${type}"` : null,
    ].filter(Boolean);

    const note =
      folded.length === 0
        ? "No drafts have been saved yet."
        : matched.length === 0
          ? `No draft matches ${filters.join(" and ")}, though ${folded.length} have been saved.`
          : undefined;

    return {
      returned: page.length,
      matched: matched.length,
      totalSaved: folded.length,
      ...(note ? { note } : {}),
      drafts: page.map((d) => {
        const stored = rows.find((r) => r.id === d.id);
        return {
          id: d.id,
          type: d.type,
          title: d.title,
          channel: d.channel,
          status: d.status,
          body: d.body,
          voiceRulesChecked: stored?.voiceRulesChecked ?? [],
          author: d.author,
          savedAt: d.createdAt.toISOString(),
          feedbackHistory: d.feedbackHistory,
          decisions: d.decisions.map((x) => ({
            decision: x.decision,
            feedback: x.feedback,
            decidedBy: x.decidedBy,
            decidedAt: x.createdAt.toISOString(),
          })),
        };
      }),
      orphanedDecisions: orphanedDecisions.map((x) => ({
        id: x.id,
        draftId: x.draftId,
        decision: x.decision,
        feedback: x.feedback,
        decidedBy: x.decidedBy,
        decidedAt: x.createdAt.toISOString(),
      })),
    };
  },
};

// ─── Segment push (Attentive) ─────────────────────────────────────────

const SEGMENT_IDS = SEED_SEGMENTS.map((s) => s.id) as [string, ...string[]];
const SAMPLE_SIZE = 5;

/** Addresses never leave this module in bulk — a handful is enough to sanity-check. */
const sample = (emails: string[]) => emails.slice(0, SAMPLE_SIZE);

const NO_CLIENT =
  "The Attentive client is not configured: ATTENTIVE_API_KEY is not set for this process. " +
  "Nothing was pushed and nothing was checked.";

async function buildPlan(
  ctx: McpToolContext,
  segmentId: string,
  opts: { checkReachability?: boolean } = {}
) {
  const definition = SEED_SEGMENTS.find((s) => s.id === segmentId)!.definition;
  const membership = await getSegmentMembers(ctx.db, definition);
  const last = await getLastRealPush(ctx.db, segmentId);

  let reachability = null;
  if (opts.checkReachability && ctx.attentive && membership.emails.length > 0) {
    const elig = await ctx.attentive.getEligibility(membership.emails);
    reachability = {
      checked: elig.length,
      known: elig.filter((e) => e.known).length,
      marketingEligible: elig.filter((e) => e.marketingEligible).length,
    };
  }

  const plan = computePushPlan({
    segmentId,
    externalId: segmentId,
    currentMembers: membership.emails,
    lastPushedMembers: last ? last.members : null,
    membershipError: membership.error,
    reachability,
  });

  return { plan, membership };
}

const segmentPushDryRun: McpTool = {
  name: "segment_push_dry_run",
  title: "Dry-run a segment push to Attentive",
  description:
    "Computes exactly what pushing a segment to Attentive would change, and touches nothing. " +
    "Returns how many people would be added, removed and left alone, a short sample of each, and a planToken. " +
    "segment_push requires that token, so a push can only ever apply the diff a person actually read — if the data moves in between, the token stops matching and you need a fresh dry run. " +
    "Attentive has no endpoint that reads segment membership back, so the diff is computed against what we last pushed; a segment with no push history reports isFirstPush. " +
    "Pass checkReachability to look up how many of the members can actually receive a marketing message — Shopify consent and Attentive eligibility disagree by roughly 13% on the lapsed cohort. It costs one API call per 25 people. " +
    "The full address list is deliberately never returned.",
  readOnly: true,
  schema: {
    segmentId: { type: "enum", values: SEGMENT_IDS, required: true },
    checkReachability: { type: "boolean", default: false },
  },
  async run(ctx, args) {
    const segmentId = args.segmentId as string;
    const checkReachability = args.checkReachability as boolean;

    if (checkReachability && !ctx.attentive) {
      return { error: NO_CLIENT };
    }

    const { plan } = await buildPlan(ctx, segmentId, { checkReachability });
    const token = planToken(plan);
    const now = ctx.now();

    // Recorded even though nothing was sent: "we looked and decided not to" is
    // worth keeping. `members` stays empty — a dry run that stored membership
    // would become the baseline for the next diff and describe a state that
    // never existed.
    await recordPush(ctx.db, {
      id: `${now.toISOString()}-${randomUUID().slice(0, 8)}`,
      segmentId,
      externalId: plan.externalId,
      dryRun: true,
      planToken: token,
      addedCount: plan.adds.length,
      removedCount: plan.removes.length,
      unchangedCount: plan.unchanged.length,
      reachableChecked: plan.reachability?.checked ?? null,
      reachableEligible: plan.reachability?.marketingEligible ?? null,
      batchJobIds: [],
      recordsSucceeded: null,
      recordsFailed: null,
      problem: plan.blockers.length > 0 ? plan.blockers.join(" ") : null,
      pushedBy: "claude",
      createdAt: now,
      members: [],
    });

    return {
      segmentId,
      externalId: plan.externalId,
      isFirstPush: plan.isFirstPush,
      added: plan.adds.length,
      removed: plan.removes.length,
      unchanged: plan.unchanged.length,
      sampleOfAdds: sample(plan.adds),
      sampleOfRemoves: sample(plan.removes),
      reachability: plan.reachability,
      canPush: canPush(plan),
      blockers: plan.blockers,
      planToken: token,
      batchesRequired: plan.addBatches.length + plan.removeBatches.length,
    };
  },
};

const segmentPush: McpTool = {
  name: "segment_push",
  title: "Push a segment to Attentive",
  description:
    "Applies a segment diff to Attentive. This sends nothing itself, but it changes who a future campaign would reach, so it is a deliberate human action: it requires the planToken from a dry run and the name of the person who approved it. " +
    "The plan is recomputed here rather than taken as an argument — you cannot hand this tool a list of addresses. If the recomputed diff no longer matches the token, the push is refused and you need a fresh dry run. " +
    "Attentive's bulk jobs are asynchronous and a COMPLETED job can still have rejected records, so this reads each job's result file and reports per-record counts. When it cannot, it reports null rather than claiming zero failures.",
  readOnly: false,
  schema: {
    segmentId: { type: "enum", values: SEGMENT_IDS, required: true },
    planToken: { type: "string", required: true },
    pushedBy: { type: "string", required: true },
  },
  async run(ctx, args) {
    const segmentId = args.segmentId as string;
    const suppliedToken = args.planToken as string;
    const pushedBy = args.pushedBy as string;

    if (isAgentAttribution(pushedBy)) {
      throw new McpArgumentError(
        `"pushedBy" must name the person who approved this push. Changing who a campaign reaches ` +
          `is a human decision that this tool records — it does not make it.`
      );
    }

    if (!ctx.attentive) return { pushed: false, error: NO_CLIENT };

    const { plan } = await buildPlan(ctx, segmentId);
    const currentToken = planToken(plan);

    // The approval was of a specific diff. If the data moved since the dry
    // run, the human approved something that is no longer what would happen.
    if (currentToken !== suppliedToken) {
      return {
        pushed: false,
        error:
          `The diff has changed since that dry run (token ${suppliedToken} is now ${currentToken}). ` +
          `Nothing was pushed. Run segment_push_dry_run again and approve the new diff.`,
        planToken: currentToken,
      };
    }

    if (!canPush(plan)) {
      return { pushed: false, error: "This plan is blocked.", blockers: plan.blockers };
    }

    const client = ctx.attentive;
    const batchJobIds: string[] = [];

    for (const batch of plan.addBatches) {
      const job = await client.addSegmentMembers(plan.externalId, batch.map((email) => ({ email })));
      batchJobIds.push(job.batchJobId);
    }
    for (const batch of plan.removeBatches) {
      const job = await client.removeSegmentMembers(plan.externalId, batch.map((email) => ({ email })));
      batchJobIds.push(job.batchJobId);
    }

    // COMPLETED is a job state, not a record count. Read the result files.
    let succeeded: number | null = 0;
    let failed: number | null = 0;
    const problems: string[] = [];

    for (const id of batchJobIds) {
      const job = await client.getBulkJob(id);
      if (job.succeeded === null || job.failed === null) {
        succeeded = null;
        failed = null;
      } else if (succeeded !== null && failed !== null) {
        succeeded += job.succeeded;
        failed += job.failed;
      }
      if (job.problem) problems.push(`${id}: ${job.problem}`);
      if (job.status === "IN_PROGRESS") {
        problems.push(`${id}: still running — its outcome is not established yet.`);
      }
    }

    const now = ctx.now();
    const problem = problems.length > 0 ? problems.join(" ") : null;

    await recordPush(ctx.db, {
      id: `${now.toISOString()}-${randomUUID().slice(0, 8)}`,
      segmentId,
      externalId: plan.externalId,
      dryRun: false,
      planToken: currentToken,
      addedCount: plan.adds.length,
      removedCount: plan.removes.length,
      unchangedCount: plan.unchanged.length,
      reachableChecked: plan.reachability?.checked ?? null,
      reachableEligible: plan.reachability?.marketingEligible ?? null,
      batchJobIds,
      recordsSucceeded: succeeded,
      recordsFailed: failed,
      problem,
      pushedBy,
      // What Attentive now holds, and the baseline the next diff is computed
      // against. Recomputing later would answer "who matches now", which
      // cannot produce a correct removal list.
      members: [...plan.adds, ...plan.unchanged].sort(),
      createdAt: now,
    });

    return {
      pushed: true,
      segmentId,
      added: plan.adds.length,
      removed: plan.removes.length,
      batchJobIds,
      recordsSucceeded: succeeded,
      recordsFailed: failed,
      problem,
      pushedBy,
      note:
        succeeded === null
          ? "The jobs were accepted but their per-record outcome could not be established. Do not treat this as a completed push."
          : undefined,
    };
  },
};

const segmentPushHistory: McpTool = {
  name: "segment_push_history",
  title: "Segment push history",
  description:
    "Every dry run and real push recorded for a segment, newest first. This is also the only record of what Attentive holds — it has no endpoint that reads segment membership back — so a push whose outcome was never established shows here with null record counts rather than as a success.",
  readOnly: true,
  schema: {
    segmentId: { type: "enum", values: SEGMENT_IDS },
    limit: { type: "integer", min: 1, max: 100, default: 20 },
  },
  async run(ctx, args) {
    const rows = await getPushHistory(ctx.db, args.segmentId as string | undefined, args.limit as number);
    return {
      returned: rows.length,
      pushes: rows.map((r) => ({
        id: r.id,
        segmentId: r.segmentId,
        dryRun: r.dryRun === 1,
        planToken: r.planToken,
        added: r.addedCount,
        removed: r.removedCount,
        unchanged: r.unchangedCount,
        reachableChecked: r.reachableChecked,
        reachableEligible: r.reachableEligible,
        recordsSucceeded: r.recordsSucceeded,
        recordsFailed: r.recordsFailed,
        problem: r.problem,
        pushedBy: r.pushedBy,
        at: r.createdAt.toISOString(),
      })),
      ...(rows.length === 0 ? { note: "No segment push has ever been recorded." } : {}),
    };
  },
};

// ─── Unit economics ───────────────────────────────────────────────────

const dollarsFrom = (cents: number) => Math.round(cents) / 100;

const unitEconomics: McpTool = {
  name: "unit_economics",
  title: "Cost of delivery and contribution margin",
  description:
    "Cost of delivery, contribution margin and break-even aMER, split by business line and never blended — a single COD across a subscription at ~8% and physical goods at 50-65% is true of neither. " +
    "Revenue EXCLUDES tax; payment fees are charged on the full captured amount including it, and are computed per transaction as (amount x pct) + fixed rather than as a flat rate. That distinction matters here: the 30c fixed fee is the larger half on ~50,000 subscription orders averaging $6.56. " +
    "Read `complete` and `missing` before quoting any figure. Fulfilment costs are not in the database yet, so every COD below is a FLOOR — the real one is higher. " +
    "`cogsCoveragePct` is the share of revenue whose landed product cost is actually recorded; a COD over uncosted orders is a guess.",
  readOnly: true,
  schema: {
    businessLine: { type: "enum", values: BUSINESS_LINES },
    days: { type: "integer", min: 1, max: 730, default: 90 },
  },
  async run(ctx, args) {
    const now = ctx.now();
    const end = new Date(now);
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - (args.days as number));
    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

    // No default rate. A missing one means the seed did not run, and
    // substituting 0.027 would produce a margin that looks computed and is
    // assumed.
    const rates = await getRateSettings(ctx.db, endDate);
    if (!rates) {
      return {
        error:
          "No payment rates are in effect for this date, so nothing was computed. " +
          "rate_settings should hold payment_pct and payment_fixed_cents — see migration 0031.",
      };
    }

    const byLine = await getOrdersForEconomics(ctx.db, startDate, endDate);
    const wanted = args.businessLine as string | undefined;

    const lines = byLine
      .filter((l) => wanted === undefined || l.line === wanted)
      .map(({ line, orders }) => {
        const r = computeUnitEconomics(orders, rates);
        return {
          businessLine: line,
          orders: r.orders,
          revenue: dollarsFrom(r.revenueCents),
          aov: dollarsFrom(r.aovCents),
          costOfDelivery: dollarsFrom(r.codCents),
          codPct: r.codPct === null ? null : Number((100 * r.codPct).toFixed(2)),
          contributionMargin: dollarsFrom(r.contributionMarginCents),
          breakEvenAmer: r.breakEvenAmer === null ? null : Number(r.breakEvenAmer.toFixed(3)),
          components: r.components.map((c) => ({
            label: c.label,
            amount: dollarsFrom(c.cents),
            basis: c.basis,
          })),
          // Split because the fixed half is the non-obvious cost in this business.
          paymentFees: {
            percentage: dollarsFrom(r.paymentFees.percentageCents),
            fixed: dollarsFrom(r.paymentFees.fixedCents),
          },
          cogsCoveragePct: Number((100 * r.cogsCoveragePct).toFixed(1)),
          complete: r.complete,
          missing: r.missing,
          ...(r.note ? { note: r.note } : {}),
        };
      });

    return {
      window: { startDate, endDate, days: args.days },
      rates: { paymentPct: rates.paymentPctRate, paymentFixedCents: rates.paymentFixedCents },
      lines,
      // Repeated at the top level so a caller reading only the summary still
      // sees it. A COD missing a whole cost category is not a COD.
      caveat:
        "Fulfilment (3PL labels, pick/pack, storage) is not yet in the database. " +
        "Every cost of delivery here is a floor and every contribution margin a ceiling.",
    };
  },
};

const marginByOrderValue: McpTool = {
  name: "margin_by_order_value",
  title: "Contribution margin by order value",
  description:
    "Contribution margin banded by order value, for the question #34 poses: is free shipping over $60 subsidising the worst orders? " +
    "Returns a verdict comparing the $50-60 and $60-70 bands directly, plus every band's margin. " +
    "PROVISIONAL by construction: the cost the threshold absorbs is the shipping label, which is not in the database, so this compares margin net of product cost and payment fees only. " +
    "Physical orders only by default — a threshold on shipping means nothing for a subscription or a printable.",
  readOnly: true,
  schema: {
    businessLine: { type: "enum", values: BUSINESS_LINES, default: "physical" },
    days: { type: "integer", min: 1, max: 730, default: 365 },
  },
  async run(ctx, args) {
    const now = ctx.now();
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - (args.days as number));
    const startDate = start.toISOString().slice(0, 10);
    const endDate = now.toISOString().slice(0, 10);

    const rates = await getRateSettings(ctx.db, endDate);
    if (!rates) {
      return {
        error:
          "No payment rates are in effect for this date, so nothing was computed. " +
          "rate_settings should hold payment_pct and payment_fixed_cents — see migration 0031.",
      };
    }

    const byLine = await getOrdersForEconomics(ctx.db, startDate, endDate);
    const line = args.businessLine as string;
    const orders = byLine.find((l) => l.line === line)?.orders ?? [];
    const bands = bandMargins(orders, rates);
    const verdict = thresholdVerdict(bands);

    return {
      window: { startDate, endDate, days: args.days },
      businessLine: line,
      orders: orders.length,
      freeShippingThresholdDollars: 60,
      verdict: {
        subsidising: verdict.subsidising,
        marginBelowThresholdPct:
          verdict.belowPct === null ? null : Number((100 * verdict.belowPct).toFixed(1)),
        marginAboveThresholdPct:
          verdict.abovePct === null ? null : Number((100 * verdict.abovePct).toFixed(1)),
        reason: verdict.reason,
      },
      bands: bands.map((b) => ({
        band: b.label,
        orders: b.orders,
        revenue: dollarsFrom(b.revenueCents),
        productCost: dollarsFrom(b.productCostCents),
        paymentFees: dollarsFrom(b.paymentCents),
        margin: dollarsFrom(b.marginCents),
        marginPct: b.marginPct === null ? null : Number((100 * b.marginPct).toFixed(1)),
      })),
      caveat:
        "Fulfilment (3PL labels, pick/pack, storage) is not in the database. Every margin here " +
        "is a ceiling, and the threshold verdict is provisional until label costs are loaded.",
    };
  },
};

/**
 * `target_cpa` deliberately does NOT take the LTV from any cohort but the
 * churned, observed one — see #34 and `target-cpa.ts`. The cohort is chosen
 * inside `realisedChurnedLtv`, which reads one block and cannot be pointed at
 * another from here.
 */
const targetCpa: McpTool = {
  name: "target_cpa",
  title: "Target cost per acquisition",
  description:
    "What an acquisition may cost, per business line, at break-even and at 3:1 LTV:CAC. " +
    "Both figures are taken over CONTRIBUTION, not revenue — the same words over revenue give a number larger by the entire cost of delivery. " +
    "Subscriptions are priced off realised churned-cohort LTV (finished, non-migrated runs only); the active cohort is excluded because those runs are unfinished, and reading it would roughly double every figure here. " +
    "Read `bound` on each basis before spending anything. `ceiling` means the CPA is too generous (a cost category is missing); `floor` means it is too conservative (the churned cohort is truncated by a short observation window); `indeterminate` means both apply and neither dominates, so the direction of the error is unknown. " +
    "Physical and digital lines are priced on a single order — repeat purchases are not counted, so those figures are conservative.",
  readOnly: true,
  schema: {
    businessLine: { type: "enum", values: BUSINESS_LINES },
    days: { type: "integer", min: 1, max: 730, default: 90 },
  },
  async run(ctx, args) {
    const now = ctx.now();
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - (args.days as number));
    const startDate = start.toISOString().slice(0, 10);
    const endDate = now.toISOString().slice(0, 10);

    const rates = await getRateSettings(ctx.db, endDate);
    if (!rates) {
      return {
        error:
          "No payment rates are in effect for this date, so nothing was computed. " +
          "rate_settings should hold payment_pct and payment_fixed_cents — see migration 0031.",
      };
    }

    const byLine = await getOrdersForEconomics(ctx.db, startDate, endDate);

    // Read once, for the subscription line only. `realisedChurnedLtv` picks
    // the cohort; nothing here can hand it a different one.
    const ltv = realisedChurnedLtv(await getSubscriptionFacts(ctx.db), now);

    const wanted = args.businessLine as string | undefined;

    const lines = byLine
      .filter((l) => wanted === undefined || l.line === wanted)
      .map(({ line, orders }) => {
        const economics = computeUnitEconomics(orders, rates);
        const r = computeTargetCpa({
          businessLine: line,
          economics,
          ltv: line === "subscription" ? ltv : null,
        });

        return {
          businessLine: r.businessLine,
          orders: economics.orders,
          aov: dollarsFrom(economics.aovCents),
          codPct: r.codPct === null ? null : Number((100 * r.codPct).toFixed(2)),
          ratioBasis: r.ratioBasis,
          recommendedBasis: r.recommendedBasis,
          bases: r.bases.map((b) => ({
            basis: b.basis,
            label: b.label,
            valuePerCustomer: dollarsFrom(b.perCustomerRevenueCents),
            contributionPerCustomer:
              b.contributionPerCustomerCents === null
                ? null
                : dollarsFrom(b.contributionPerCustomerCents),
            breakEvenCpa: b.breakEvenCpaCents === null ? null : dollarsFrom(b.breakEvenCpaCents),
            targetCpaAt3to1:
              b.targetCpa3to1Cents === null ? null : dollarsFrom(b.targetCpa3to1Cents),
            bound: b.bound,
            boundReasons: b.boundReasons,
            cohortSize: b.cohortSize,
            caveats: b.caveats,
          })),
          blockers: r.blockers,
        };
      });

    return {
      window: { startDate, endDate, days: args.days },
      ratio: `${TARGET_LTV_CAC_RATIO}:1 LTV:CAC, taken over contribution`,
      ...(ltv
        ? {
            subscriptionLtv: {
              cohort: ltv.cohort,
              subscribers: ltv.subscribers,
              avgLtv: dollarsFrom(ltv.avgLtvCents),
              avgTenureMonths: Number(ltv.avgTenureMonths.toFixed(1)),
              observationWindowMonths: Number(ltv.observationWindowMonths.toFixed(1)),
              unfinishedRuns: ltv.unfinishedRuns,
              isFloor: ltv.isFloor,
            },
          }
        : {
            subscriptionLtv: null,
            subscriptionLtvNote:
              "No finished, non-migrated subscription run is on record, so realised LTV could not be computed.",
          }),
      lines,
      caveat:
        "Fulfilment (3PL labels, pick/pack, storage) is not yet in the database, so every cost of " +
        "delivery behind these figures is a floor and every CPA built on one is a ceiling.",
    };
  },
};

const amerTool: McpTool = {
  name: "amer",
  title: "aMER against break-even",
  description:
    "New-customer order revenue divided by ad spend, measured against the break-even aMER of the customers that spend actually bought. " +
    "aMER alone is a ratio with no scale: the paid era ran between 0.51 and 5.33, and whether 2.0 is good depends on a cost of delivery that differs by a factor of six across the three business lines. So break-even is computed over the NEW-CUSTOMER revenue mix in the window, not blended across all orders and not taken from one line. " +
    "`verdict` is withheld as `undecidable` when aMER sits above break-even while a cost category is missing — break-even is a floor then, and clearing an understated bar is not evidence of clearing the real one. A `below-break-even` verdict survives that, because below a floor is below the real figure too. " +
    "A first-ever order means the customer's Shopify lifetime order count equals the number of orders we hold; order history begins 2025-07-22, so the earliest order we hold is routinely a repeat purchase. " +
    "Meta is the only channel in the warehouse. There has been NO ad spend since 2026-03-29, so any window inside the last six months returns a null aMER — undefined, not infinite.",
  readOnly: true,
  schema: {
    days: { type: "integer", min: 1, max: 730, default: 90 },
    channel: { type: "enum", values: AD_CHANNELS },
  },
  async run(ctx, args) {
    const now = ctx.now();
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - (args.days as number));
    const startDate = start.toISOString().slice(0, 10);
    const endDate = now.toISOString().slice(0, 10);

    const rates = await getRateSettings(ctx.db, endDate);
    if (!rates) {
      return {
        error:
          "No payment rates are in effect for this date, so nothing was computed. " +
          "rate_settings should hold payment_pct and payment_fixed_cents — see migration 0031.",
      };
    }

    const spendRows = await getAdSpend(
      ctx.db,
      startDate,
      endDate,
      args.channel as "meta" | undefined
    );
    const spendCents = spendRows.reduce((sum, r) => sum + r.spendCents, 0);

    const { byLine, undecidableOrders } = await getNewCustomerOrders(ctx.db, startDate, endDate);
    const r = computeAmer({ spendCents, rates, byLine });

    return {
      window: { startDate, endDate, days: args.days },
      spend: {
        total: dollarsFrom(r.spendCents),
        byChannel: spendRows.map((c) => ({
          channel: c.channel,
          spend: dollarsFrom(c.spendCents),
          daysWithSpend: c.daysWithSpend,
        })),
        // Absent channels are absent from our data, not from the world.
        coverage:
          "Meta only. No other ad channel is synced, so this denominator is Meta spend even when no channel is named.",
      },
      newCustomers: {
        orders: r.newOrders,
        revenue: dollarsFrom(r.newRevenueCents),
        definition:
          "First-ever orders: the customer's Shopify lifetime order count equals the number of orders we hold. Order history begins 2025-07-22.",
        ...(undecidableOrders > 0
          ? {
              undecidableOrders,
              undecidableNote:
                "Orders whose customer has no lifetime order count in Shopify. Counted as neither new nor repeat.",
            }
          : {}),
      },
      amer: r.amer === null ? null : Number(r.amer.toFixed(3)),
      breakEvenAmer: r.breakEvenAmer === null ? null : Number(r.breakEvenAmer.toFixed(3)),
      breakEvenBound: r.breakEvenBound,
      codPct: r.codPct === null ? null : Number((100 * r.codPct).toFixed(2)),
      verdict: r.verdict,
      reason: r.reason,
      lines: r.lines.map((l) => ({
        businessLine: l.line,
        newOrders: l.newOrders,
        newRevenue: dollarsFrom(l.newRevenueCents),
        shareOfNewRevenuePct: Number((100 * l.shareOfNewRevenue).toFixed(1)),
      })),
      missing: r.missing,
    };
  },
};

/**
 * ─── Campaign and journey detail (#23) ────────────────────────────────
 *
 * `email_sms_performance` answers "did email do anything this month". These
 * answer "which send worked" and "which step of which flow drops people",
 * which is what anyone can act on.
 */
const emailCampaignDetail: McpTool = {
  name: "email_campaign_detail",
  title: "Per-campaign email and SMS performance",
  description:
    "Every campaign send in a window, named, with delivered, opens, clicks, conversions, revenue AND unsubscribes — ordered by revenue. " +
    "Read unsubscribes beside revenue on every row: a campaign with strong revenue and a spike in unsubscribes borrowed from future sends rather than earning anything, and on revenue alone it looks like a win worth repeating. " +
    "`bySegment` breaks the same sends out by the audience they went to; its revenue is the SAME money as `campaigns`, counted a second way, so never add the two together. " +
    "`messagingCost` is the SMS carrier cost over the window, which is a daily figure and cannot be attributed to a particular campaign. " +
    "Scraped from the Attentive UI, not an API — check `data_freshness` before reading a quiet window as a quiet month.",
  readOnly: true,
  schema: { ...RANGE_SCHEMA },
  async run(ctx, args) {
    const range = resolveRange(args, ctx.now(), 30);
    const [campaigns, bySegment, cost] = await Promise.all([
      getCampaignMessagePerformance(ctx.db, range.startDate, range.endDate),
      getCampaignSegmentPerformance(ctx.db, range.startDate, range.endDate),
      getMessageCostTotals(ctx.db, range.startDate, range.endDate),
    ]);

    return {
      range: describeRange(range),
      campaigns: campaigns.map((c) => ({
        date: c.date,
        campaign: c.campaign,
        message: c.message,
        channel: c.channel,
        delivered: c.delivered,
        emailUniqueOpens: c.emailUniqueOpens,
        clicks: c.totalClicks,
        conversions: c.conversions,
        revenue: dollarsFrom(c.revenueCents),
        unsubscribes: c.unsubscribes,
        // Per thousand delivered, so a small send and a large one compare.
        unsubscribesPerThousandDelivered:
          c.delivered === 0 ? null : Number(((1000 * c.unsubscribes) / c.delivered).toFixed(2)),
      })),
      bySegment: bySegment.map((s) => ({
        date: s.date,
        message: s.message,
        segment: s.segment,
        channel: s.channel,
        delivered: s.delivered,
        clicks: s.totalClicks,
        conversions: s.conversions,
        revenue: dollarsFrom(s.revenueCents),
        unsubscribes: s.unsubscribes,
      })),
      messagingCost: {
        total: dollarsFrom(cost.totalCents),
        campaign: dollarsFrom(cost.campaignCostCents),
        automatedSend: dollarsFrom(cost.automatedSendCostCents),
        received: dollarsFrom(cost.receivedCostCents),
        carrierFees: dollarsFrom(cost.carrierFeesCents),
        daysWithData: cost.days,
        // Zero days is a gap. Zero dollars over thirty days is a free month.
        ...(cost.days === 0
          ? { note: "No message-cost rows in this window, so the cost is unknown rather than zero." }
          : {}),
      },
      ...(campaigns.length === 0
        ? {
            note:
              "No campaign-level rows in this window. The detail reports began syncing on 2026-09-18, " +
              "so an earlier window is empty because nothing was collected, not because nothing was sent.",
          }
        : {}),
    };
  },
};

const emailJourneyDetail: McpTool = {
  name: "email_journey_detail",
  title: "Per-message journey performance",
  description:
    "Every message inside every journey, rolled up over the window and ordered by revenue. " +
    "This is where silent ongoing loss lives: a journey runs unattended for months, and nobody re-reads a flow that was set up and left running, so a step that stopped converting keeps sending. " +
    "`sendDays` is how many days that step actually sent — a step that ran twice must not be read as one that ran all month. " +
    "Unsubscribes are per step, which is what makes 'this message is where people leave' answerable. " +
    "Scraped from the Attentive UI, not an API.",
  readOnly: true,
  schema: { ...RANGE_SCHEMA },
  async run(ctx, args) {
    const range = resolveRange(args, ctx.now(), 30);
    const rows = await getJourneyMessagePerformance(ctx.db, range.startDate, range.endDate);

    return {
      range: describeRange(range),
      messages: rows.map((r) => ({
        journey: r.journeyName,
        trigger: r.triggerName,
        message: r.message,
        channel: r.channel,
        sendDays: Number(r.sendDays),
        delivered: Number(r.delivered),
        clicks: Number(r.totalClicks),
        conversions: Number(r.conversions),
        revenue: dollarsFrom(Number(r.revenueCents)),
        unsubscribes: Number(r.unsubscribes),
        // Null rather than 0 when nothing was delivered: a rate over no sends
        // is undefined, and 0% reads as "nobody clicked".
        clickRatePct:
          Number(r.delivered) === 0
            ? null
            : Number(((100 * Number(r.totalClicks)) / Number(r.delivered)).toFixed(2)),
        unsubscribesPerThousandDelivered:
          Number(r.delivered) === 0
            ? null
            : Number(((1000 * Number(r.unsubscribes)) / Number(r.delivered)).toFixed(2)),
      })),
      ...(rows.length === 0
        ? {
            note:
              "No journey rows in this window. The journey report began syncing on 2026-09-18, " +
              "so an earlier window is empty because nothing was collected, not because no journey ran.",
          }
        : {}),
    };
  },
};

/**
 * ─── Shared inventory pools (#9) ──────────────────────────────────────
 */
const inventoryPools: McpTool = {
  name: "inventory_pools",
  title: "Shared inventory pools",
  description:
    "Quantity-break variants that sell the same physical stock through separate Shopify inventory items, and whether their counts still agree. " +
    "A pack variant's quantity is how many N-PACKS can be made, not how many units are held — so 796, 398 and 31 across the 1, 2 and 25 packs are the SAME 796 bags, and adding the rows gives 3,049, which is a quantity of nothing. NEVER sum quantity across a pool. " +
    "`poolUnits` is the real figure. `diverged` is true only when a member is short by more than its own pack size could truncate away, so a correctly synced pool never raises an alarm. " +
    "Nothing in Shopify keeps these in step — a Mechanic task did, and it was uninstalled — so divergence is the signal that stock is being oversold. " +
    "`monitoredByOrdinaryChecks` is false when every member is UNLISTED, which means `inventory_status` classifies them all as `ignored` while they continue to sell. " +
    "`undeclaredCandidates` are quantity-break products that look like pools and are not in the declaration; grouping is declared data, never inferred, so these need a human to confirm before they count.",
  readOnly: true,
  schema: {},
  async run(ctx) {
    const since = new Date(ctx.now());
    since.setUTCDate(since.getUTCDate() - 30);

    const rows = await getPoolVariantRows(ctx.db, since);
    const declared = parsePoolDeclaration(POOL_DECLARATION);

    // A multimap, not a map. 17 SKUs in this catalogue belong to more than one
    // variant — `BAGHLLWN2023` is an ACTIVE "Default Title" product AND an
    // UNLISTED "Spooky Spells / 1" variant, two separate inventory items over
    // the same bags. Keeping one would drop the other silently, and those two
    // items diverging is precisely the failure this tool exists to catch.
    const bySku = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.sku ?? "";
      const list = bySku.get(key);
      if (list) list.push(r);
      else bySku.set(key, [r]);
    }

    const pools = declared.map((pool) => {
      const missing: string[] = [];
      const variants: PoolVariant[] = [];

      for (const v of pool.variants) {
        const matches = bySku.get(v.sku) ?? [];
        if (matches.length === 0) {
          // A declared SKU the catalogue no longer has is a stale declaration,
          // not an empty pool. Silently dropping it would shrink the pool and
          // change the answer without saying so.
          missing.push(v.sku);
          continue;
        }
        for (const row of matches) {
          variants.push({
            variantId: row.variantId,
            sku: v.sku,
            variantTitle: row.variantTitle ?? "",
            packSize: v.packSize,
            quantity: row.quantity,
            productStatus: row.productStatus,
            unitsSoldLast30d: Number(row.unitsSoldLast30d),
          });
        }
      }

      const a = assessPool(pool.groupKey, variants);
      return {
        group: pool.groupKey,
        productTitle: pool.productTitle,
        ...(pool.note ? { note: pool.note } : {}),
        poolUnits: a.poolUnits,
        diverged: a.diverged,
        driftUnits: a.worstDriftUnits,
        worstVariant: a.worst ? { sku: a.worst.sku, shortBy: a.worst.driftUnits } : null,
        rawSpreadUnits: a.rawSpreadUnits,
        rawSpreadNote:
          "High minus low across members. Integer division alone produces a spread; only `driftUnits` is real disagreement.",
        unitsSoldLast30d: a.unitsSoldLast30d,
        monitoredByOrdinaryChecks: a.monitoredByOrdinaryChecks,
        members: a.members.map((m) => ({
          sku: m.sku,
          variantTitle: m.variantTitle,
          productStatus: m.productStatus,
          packSize: m.packSize,
          packsHeld: m.quantity,
          impliedUnits: m.impliedUnits,
          shortBy: m.driftUnits,
        })),
        ...(missing.length > 0
          ? {
              declaredButNotInCatalogue: missing,
              staleDeclarationNote:
                "These SKUs are declared here but absent from shopify_inventory, so the pool was assessed without them.",
            }
          : {}),
        ...(a.reason ? { reason: a.reason } : {}),
      };
    });

    const candidates = findUndeclaredPoolCandidates(
      rows.map((r) => ({
        variantId: r.variantId,
        sku: r.sku ?? "",
        variantTitle: r.variantTitle,
        quantity: r.quantity,
        productStatus: r.productStatus,
        unitsSoldLast30d: Number(r.unitsSoldLast30d),
      })),
      declared.map((p) => p.groupKey)
    );

    return {
      pools,
      undeclaredCandidates: candidates,
      ...(candidates.length > 0
        ? {
            candidatesNote:
              "These look like quantity-break products and are NOT declared, so they are unmonitored. " +
              "Grouping is a fact about fulfilment rather than about naming, so a human confirms one before it counts.",
          }
        : {}),
      declaration: "src/domain/inventory/inventory-pools.json",
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

// ─── Pilot notes ──────────────────────────────────────────────────────

const pilotNotesGet: McpTool = {
  name: "pilot_notes_get",
  title: "Read pilot notes",
  description:
    "The running log of observations about this system and the business. Returns open notes by default — pass status to see closed or orphaned ones, or 'all'. Each note carries its full entry history, oldest first, so the reasoning behind it is visible rather than just its current state. A note with status 'orphaned' means an entry referenced a note that was never opened; treat that as data damage, not as a note.",
  readOnly: true,
  schema: {
    status: { type: "enum", values: ["open", "closed", "orphaned", "all"] as const, default: "open" },
    category: { type: "string" },
    limit: { type: "integer", min: 1, max: 500, default: 100 },
  },
  async run(ctx, args) {
    const { status, category, limit } = args as {
      status: "open" | "closed" | "orphaned" | "all";
      category?: string;
      limit: number;
    };

    const all = foldNotes(await getPilotEntries(ctx.db));
    const matched = all.filter(
      (n) => (status === "all" || n.status === status) && (!category || n.category === category)
    );

    return {
      filters: { status, category: category ?? null },
      // Both numbers, always: a capped list read as the whole set is how a
      // "there are only 3 open notes" conclusion gets drawn from 100 of 400.
      matched: matched.length,
      returned: Math.min(matched.length, limit),
      notes: matched.slice(0, limit).map((n) => ({
        noteId: n.noteId,
        title: n.title,
        category: n.category,
        status: n.status,
        openedAt: n.openedAt.toISOString(),
        lastActivityAt: n.lastActivityAt.toISOString(),
        resolution: n.resolution,
        entries: n.entries.map((e) => ({
          kind: e.kind,
          body: e.body,
          author: e.author,
          createdAt: e.createdAt.toISOString(),
        })),
      })),
    };
  },
};

const pilotNotesAdd: McpTool = {
  name: "pilot_notes_add",
  title: "Add a pilot note",
  description:
    "Append an entry to the pilot notes log. This is the ONLY tool on this server that writes anything. The log is append-only: nothing can be edited or deleted, so a mistake is corrected by appending a correction. Use kind 'open' with a title to raise something new, 'comment' with a noteId to add context, and 'resolution' with a noteId to close one. Returns the noteId, which is what later entries attach to.",
  readOnly: false,
  schema: {
    kind: { type: "enum", values: [...NOTE_KINDS], default: "open" },
    title: { type: "string" },
    body: { type: "string", required: true },
    category: { type: "string" },
    author: { type: "string", default: "claude" },
    noteId: { type: "string" },
  },
  async run(ctx, args) {
    const { kind, title, body, category, author, noteId } = args as {
      kind: NoteKind;
      title?: string;
      body: string;
      category?: string;
      author: string;
      noteId?: string;
    };

    const draft = {
      kind,
      title: title ?? null,
      body,
      category: category ?? null,
      author,
      noteId: noteId ?? null,
    };

    const validation = validateEntry(draft);
    if (!validation.ok) {
      throw new McpArgumentError(validation.error);
    }

    // Appending to a note that does not exist would fold to an orphan, which
    // is reserved for genuine data damage. A typo in a noteId should fail
    // here, loudly, rather than quietly create an unreachable entry.
    if (noteId && !(await noteExists(ctx.db, noteId))) {
      throw new McpArgumentError(
        `No pilot note with id "${noteId}". Call pilot_notes_get to list existing notes, ` +
          `or omit noteId to open a new one.`
      );
    }

    const now = ctx.now();
    // Time-ordered and unique. The fold sorts on createdAt and breaks ties on
    // id, so a monotonic prefix keeps two entries written in the same
    // millisecond in the order they were actually written.
    const id = `${now.toISOString()}-${randomUUID().slice(0, 8)}`;

    await appendPilotEntry(ctx.db, {
      id,
      noteId: noteId ?? id,
      kind,
      title: title ?? null,
      body,
      category: category ?? null,
      author,
      createdAt: now,
    });

    return {
      written: true,
      entryId: id,
      noteId: noteId ?? id,
      kind,
      createdAt: now.toISOString(),
    };
  },
};

const pilotNotesExport: McpTool = {
  name: "pilot_notes_export",
  title: "Export pilot notes as markdown",
  description:
    "The whole pilot notes log as a markdown document, grouped into open, closed and orphaned sections. This is the one tool that returns prose rather than data, because its output is meant for a person to read or paste somewhere. Returns an explicit 'no notes' line when the log is empty, rather than an empty document that could read as an all-clear.",
  readOnly: true,
  schema: {
    status: { type: "enum", values: ["open", "closed", "orphaned", "all"] as const, default: "all" },
    category: { type: "string" },
  },
  async run(ctx, args) {
    const { status, category } = args as {
      status: "open" | "closed" | "orphaned" | "all";
      category?: string;
    };

    const all = foldNotes(await getPilotEntries(ctx.db));
    const matched = all.filter(
      (n) => (status === "all" || n.status === status) && (!category || n.category === category)
    );

    return {
      filters: { status, category: category ?? null },
      noteCount: matched.length,
      markdown: renderMarkdown(matched, ctx.now()),
    };
  },
};

// ─── Ad-hoc SQL ───────────────────────────────────────────────────────

/**
 * The purpose-built tools above are not replaced by this one. They encode
 * decisions — how MRR amortises an annual plan, how dunning is derived from
 * billing attempts rather than error codes — that should not be re-derived
 * differently every time somebody asks. Use SQL for the questions nobody
 * anticipated, and the named tools for the ones that were.
 */
const query: McpTool = {
  name: "query",
  title: "Query the warehouse",
  readOnly: true,
  description:
    `Run read-only SQL against the "analytics" schema, or list what is in it.\n\n` +
    `Call with action="describe" FIRST if you do not already know the schema: it ` +
    `returns every view, its columns and types, and a comment recording how to ` +
    `read it correctly. That listing comes from the live catalog, so it cannot ` +
    `drift from what is actually there.\n\n` +
    `The connection is a role with SELECT on these views and nothing else — no ` +
    `base tables, no writes, no DDL. Customer email, names, phone, address, card ` +
    `details and raw API payloads are not in the views at all, so they cannot be ` +
    `selected. customer_id IS available, already resolved to its numeric form, ` +
    `for joining subscriptions to orders.\n\n` +
    `Rules: one statement, which must be a SELECT or WITH...SELECT. Queries time ` +
    `out after 30 seconds. At most ${ROW_CAP} rows come back, and the result says ` +
    `so when there were more — prefer an aggregate over pulling rows. Money is ` +
    `stored in CENTS in these views, unlike every other tool here, because they ` +
    `are the raw columns: divide by 100 yourself.`,
  schema: {
    action: { type: "enum", values: ["query", "describe"], default: "query" },
    sql: { type: "string" },
  },
  async run(ctx, args) {
    const action = args.action as "query" | "describe";
    const sql = args.sql as string | undefined;

    // Never `?? ctx.db`. The owner pool can read every base table, so a
    // fallback would quietly turn this into arbitrary SQL over the PII the
    // views exist to exclude.
    if (!ctx.analytics) {
      return {
        ok: false,
        error:
          "The query tool is not available: ANALYTICS_DATABASE_URL is not set. It " +
          "needs its own read-only connection and deliberately does not fall back " +
          "to the main one.",
      };
    }

    const deps: QueryDeps = {
      analytics: ctx.analytics,
      // Written on the owner connection: the read-only role has no INSERT
      // anywhere, including on its own audit trail.
      log: (entry) => ctx.db.insert(queryLog).values(entry),
    };

    if (action === "describe") {
      if (sql !== undefined) {
        return {
          ok: false,
          error: `The "describe" action does not take a "sql" argument. Drop it, or use action="query" to run the statement.`,
        };
      }
      return describeViews(deps);
    }

    if (sql === undefined) {
      return { ok: false, error: `"sql" is required when action is "query".` };
    }
    return runQuery(deps, sql, ctx.now());
  },
};

/**
 * Every tool on the server. All but `pilot_notes_add` are read-only; that one
 * appends to the pilot notes log and can do nothing else. Anything that spends
 * money or sends a message still does not exist here.
 */
export const ALL_TOOLS: McpTool[] = [
  dataFreshness,
  adsPerformance,
  adsCreativePerformance,
  storePerformance,
  storeTopProducts,
  subscriptionSummary,
  subscriptionLtv,
  subscriptionChanges,
  emailSmsPerformance,
  emailCampaignDetail,
  emailJourneyDetail,
  socialPerformance,
  inventoryStatus,
  inventoryPools,
  calendarEntriesTool,
  brandVoice,
  voiceCheckTool,
  experimentStart,
  experimentRecordResult,
  experimentsList,
  draftSave,
  draftRecordDecision,
  draftsList,
  segmentPushDryRun,
  segmentPush,
  segmentPushHistory,
  unitEconomics,
  marginByOrderValue,
  targetCpa,
  amerTool,
  currentAlerts,
  pilotNotesGet,
  pilotNotesAdd,
  pilotNotesExport,
  query,
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
      case "number":
        properties[key] = {
          type: "number",
          ...(spec.min !== undefined ? { minimum: spec.min } : {}),
          ...(spec.max !== undefined ? { maximum: spec.max } : {}),
        };
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
  return ALL_TOOLS.find((t) => t.name === name);
}

export async function dispatchTool(
  ctx: McpToolContext,
  name: string,
  rawArgs: Record<string, unknown> | undefined
): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) {
    throw new Error(
      `Unknown tool "${name}". Available tools: ${ALL_TOOLS.map((t) => t.name).join(", ")}`
    );
  }
  // Validation runs before the query so a bad argument costs nothing and,
  // more importantly, cannot half-apply.
  return tool.run(ctx, parseArgs(rawArgs, tool.schema));
}
