/**
 * Meta sync transforms — maps raw Meta API responses into schema-valid DB rows.
 *
 * IMPORTANT dollar/cent rules:
 * - Meta budgets (daily_budget, lifetime_budget) are ALREADY in cents from the API.
 * - Insight spend/cpm/cpc are in DOLLARS — must multiply by 100.
 * - Action values (purchase_value) are in DOLLARS — must multiply by 100.
 */

import type {
  MetaApiCampaign,
  MetaApiAdSet,
  MetaApiAd,
  MetaApiCreative,
  MetaApiInsight,
  MetaApiAction,
  MetaApiActionValue,
} from "@/integrations/meta-api";
import type {
  NewMetaCampaign,
  NewMetaAdSet,
  NewMetaAd,
  NewMetaCreative,
  NewMetaInsight,
} from "@/db/schema";

/**
 * Convert a dollar string to cents. Rounds to avoid floating-point drift.
 * Returns 0 for null/undefined/empty.
 */
function dollarsToCents(value: string | undefined | null): number {
  if (!value) return 0;
  return Math.round(parseFloat(value) * 100);
}

/**
 * Parse a string to integer, defaulting to 0 for null/undefined/empty.
 */
function toInt(value: string | undefined | null): number {
  if (!value) return 0;
  return parseInt(value, 10) || 0;
}

/**
 * Parse a string to float, returning null for null/undefined/empty.
 */
function toFloat(value: string | undefined | null): number | null {
  if (!value) return null;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

/**
 * Extract a specific action count from the actions array.
 * Prefers 7d_click attribution (CTC framework), falls back to value.
 */
function extractAction(
  actions: MetaApiAction[] | undefined,
  actionType: string
): number {
  if (!actions) return 0;
  const action = actions.find((a) => a.action_type === actionType);
  if (!action) return 0;
  return toInt(action["7d_click"] ?? action.value);
}

/**
 * Extract a specific action value (in dollars) from the action_values array.
 * Prefers 7d_click attribution, falls back to value. Converts to cents.
 */
function extractActionValueCents(
  actionValues: MetaApiActionValue[] | undefined,
  actionType: string
): number {
  if (!actionValues) return 0;
  const action = actionValues.find((a) => a.action_type === actionType);
  if (!action) return 0;
  return dollarsToCents(action["7d_click"] ?? action.value);
}

export function transformCampaign(
  raw: MetaApiCampaign,
  syncedAt: Date
): NewMetaCampaign {
  return {
    id: raw.id,
    accountId: "act_default", // Will be passed as param in real sync
    name: raw.name,
    status: raw.status,
    objective: raw.objective ?? null,
    buyingType: raw.buying_type ?? null,
    // Meta budgets are already in cents — parse as int, don't multiply
    dailyBudgetCents: raw.daily_budget ? toInt(raw.daily_budget) : null,
    lifetimeBudgetCents: raw.lifetime_budget ? toInt(raw.lifetime_budget) : null,
    startTime: raw.created_time ? new Date(raw.created_time) : null,
    stopTime: null,
    rawJson: raw,
    syncedAt,
  };
}

export function transformAdSet(
  raw: MetaApiAdSet,
  syncedAt: Date
): NewMetaAdSet {
  return {
    id: raw.id,
    campaignId: raw.campaign_id,
    name: raw.name,
    status: raw.status,
    targeting: raw.targeting ?? null,
    optimizationGoal: raw.optimization_goal ?? null,
    billingEvent: raw.billing_event ?? null,
    bidStrategy: raw.bid_strategy ?? null,
    dailyBudgetCents: raw.daily_budget ? toInt(raw.daily_budget) : null,
    lifetimeBudgetCents: raw.lifetime_budget ? toInt(raw.lifetime_budget) : null,
    startTime: raw.created_time ? new Date(raw.created_time) : null,
    stopTime: null,
    rawJson: raw,
    syncedAt,
  };
}

export function transformAd(raw: MetaApiAd, syncedAt: Date): NewMetaAd {
  return {
    id: raw.id,
    adSetId: raw.adset_id,
    campaignId: raw.campaign_id,
    name: raw.name,
    status: raw.status,
    creativeId: raw.creative?.id ?? null,
    rawJson: raw,
    syncedAt,
  };
}

export function transformCreative(
  raw: MetaApiCreative,
  syncedAt: Date
): NewMetaCreative {
  return {
    id: raw.id,
    name: raw.name ?? null,
    title: raw.title ?? null,
    body: raw.body ?? null,
    imageUrl: raw.image_url ?? null,
    videoUrl: raw.thumbnail_url ?? null,
    callToActionType: raw.call_to_action_type ?? null,
    objectType: raw.object_type ?? null,
    rawJson: raw,
    syncedAt,
  };
}

export function transformInsight(
  raw: MetaApiInsight,
  syncedAt: Date
): NewMetaInsight {
  return {
    adId: raw.ad_id,
    campaignId: raw.campaign_id,
    adSetId: raw.adset_id,
    date: new Date(raw.date_start),

    impressions: toInt(raw.impressions),
    clicks: toInt(raw.clicks),
    spendCents: dollarsToCents(raw.spend),
    reach: toInt(raw.reach),
    cpm: toFloat(raw.cpm),
    cpc: toFloat(raw.cpc),
    ctr: toFloat(raw.ctr),

    purchases: extractAction(raw.actions, "purchase"),
    purchaseValueCents: extractActionValueCents(raw.action_values, "purchase"),
    addToCart: extractAction(raw.actions, "add_to_cart"),
    initiateCheckout: extractAction(raw.actions, "initiate_checkout"),

    publisherPlatform: raw.publisher_platform ?? null,
    platformPosition: raw.platform_position ?? null,

    rawJson: raw,
    syncedAt,
  };
}
