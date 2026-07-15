/**
 * Database schema — Drizzle ORM table definitions.
 *
 * Conventions:
 * - Money is stored in cents (integer) to avoid floating-point drift.
 * - All tables have createdAt/updatedAt timestamps.
 * - Raw API responses are stored as JSONB for audit trail and schema evolution.
 * - syncedAt tracks when data was last pulled from the external source.
 */

import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  real,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ─── Meta Ads ──────────────────────────────────────────────────────────

export const metaCampaigns = pgTable("meta_campaigns", {
  id: text("id").primaryKey(), // Meta's campaign ID
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(), // ACTIVE, PAUSED, ARCHIVED, DELETED
  objective: text("objective"), // CONVERSIONS, REACH, etc.
  buyingType: text("buying_type"), // AUCTION, RESERVED
  dailyBudgetCents: integer("daily_budget_cents"),
  lifetimeBudgetCents: integer("lifetime_budget_cents"),
  startTime: timestamp("start_time", { withTimezone: true }),
  stopTime: timestamp("stop_time", { withTimezone: true }),
  rawJson: jsonb("raw_json"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const metaAdSets = pgTable("meta_adsets", {
  id: text("id").primaryKey(), // Meta's adset ID
  campaignId: text("campaign_id")
    .notNull()
    .references(() => metaCampaigns.id),
  name: text("name").notNull(),
  status: text("status").notNull(),
  targeting: jsonb("targeting"), // Targeting spec JSON
  optimizationGoal: text("optimization_goal"),
  billingEvent: text("billing_event"),
  bidStrategy: text("bid_strategy"),
  dailyBudgetCents: integer("daily_budget_cents"),
  lifetimeBudgetCents: integer("lifetime_budget_cents"),
  startTime: timestamp("start_time", { withTimezone: true }),
  stopTime: timestamp("stop_time", { withTimezone: true }),
  rawJson: jsonb("raw_json"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const metaAds = pgTable("meta_ads", {
  id: text("id").primaryKey(), // Meta's ad ID
  adSetId: text("adset_id")
    .notNull()
    .references(() => metaAdSets.id),
  campaignId: text("campaign_id")
    .notNull()
    .references(() => metaCampaigns.id),
  name: text("name").notNull(),
  status: text("status").notNull(),
  creativeId: text("creative_id"),
  rawJson: jsonb("raw_json"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const metaCreatives = pgTable("meta_creatives", {
  id: text("id").primaryKey(), // Meta's creative ID
  name: text("name"),
  title: text("title"),
  body: text("body"),
  imageUrl: text("image_url"),
  videoUrl: text("video_url"),
  callToActionType: text("call_to_action_type"),
  objectType: text("object_type"),
  rawJson: jsonb("raw_json"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const metaInsights = pgTable(
  "meta_insights",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    adId: text("ad_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    adSetId: text("adset_id").notNull(),
    date: timestamp("date", { withTimezone: true, mode: "date" }).notNull(),

    // Performance metrics
    impressions: bigint("impressions", { mode: "number" }).notNull().default(0),
    clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
    spendCents: integer("spend_cents").notNull().default(0),
    reach: bigint("reach", { mode: "number" }).notNull().default(0),
    cpm: real("cpm"), // cost per 1000 impressions
    cpc: real("cpc"), // cost per click
    ctr: real("ctr"), // click-through rate

    // Conversion events (7-day click attribution, CTC framework)
    purchases: integer("purchases").notNull().default(0),
    purchaseValueCents: integer("purchase_value_cents").notNull().default(0),
    addToCart: integer("add_to_cart").notNull().default(0),
    initiateCheckout: integer("initiate_checkout").notNull().default(0),

    // Breakdown dimensions
    publisherPlatform: text("publisher_platform"), // facebook, instagram, audience_network
    platformPosition: text("platform_position"), // feed, stories, reels, etc.

    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Prevent duplicate rows when re-syncing the same day's data
    uniqueIndex("meta_insights_dedup_idx").on(
      table.adId,
      table.date,
      table.publisherPlatform,
      table.platformPosition
    ),
    index("meta_insights_date_idx").on(table.date),
    index("meta_insights_campaign_idx").on(table.campaignId),
    index("meta_insights_ad_idx").on(table.adId),
  ]
);

// ─── Type exports for use in domain logic ──────────────────────────────

export type MetaCampaign = typeof metaCampaigns.$inferSelect;
export type NewMetaCampaign = typeof metaCampaigns.$inferInsert;

export type MetaAdSet = typeof metaAdSets.$inferSelect;
export type NewMetaAdSet = typeof metaAdSets.$inferInsert;

export type MetaAd = typeof metaAds.$inferSelect;
export type NewMetaAd = typeof metaAds.$inferInsert;

export type MetaCreative = typeof metaCreatives.$inferSelect;
export type NewMetaCreative = typeof metaCreatives.$inferInsert;

export type MetaInsight = typeof metaInsights.$inferSelect;
export type NewMetaInsight = typeof metaInsights.$inferInsert;
