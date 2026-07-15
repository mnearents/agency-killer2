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
  vector,
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

// ─── Shopify ───────────────────────────────────────────────────────────

export const shopifyOrders = pgTable(
  "shopify_orders",
  {
    id: text("id").primaryKey(), // Shopify's order ID
    orderNumber: text("order_number"),
    currency: text("currency").notNull().default("USD"),

    // Money in cents
    totalPriceCents: bigint("total_price_cents", { mode: "number" }).notNull(),
    subtotalPriceCents: bigint("subtotal_price_cents", { mode: "number" }),
    totalTaxCents: bigint("total_tax_cents", { mode: "number" }),
    totalDiscountsCents: bigint("total_discounts_cents", { mode: "number" }),

    // Status
    financialStatus: text("financial_status"),
    fulfillmentStatus: text("fulfillment_status"),

    // Customer & attribution
    customerId: text("customer_id"),
    sourceName: text("source_name"),
    referringSite: text("referring_site"),

    // UTM parameters (for attributing orders to ad campaigns)
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),

    // Subscription tracking
    isRecurring: integer("is_recurring").notNull().default(0), // 0 = false, 1 = true
    tags: jsonb("tags"),
    discountCodes: jsonb("discount_codes"),

    orderCreatedAt: timestamp("order_created_at", { withTimezone: true }),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("shopify_orders_created_idx").on(table.orderCreatedAt),
    index("shopify_orders_customer_idx").on(table.customerId),
    index("shopify_orders_utm_idx").on(
      table.utmSource,
      table.utmMedium,
      table.utmCampaign
    ),
  ]
);

export const shopifyLineItems = pgTable(
  "shopify_line_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => shopifyOrders.id),
    productId: text("product_id"),
    variantId: text("variant_id"),
    productType: text("product_type"),
    sku: text("sku"),
    title: text("title").notNull(),
    quantity: integer("quantity").notNull(),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(), // unit price
    rawJson: jsonb("raw_json"),
  },
  (table) => [index("shopify_line_items_product_idx").on(table.productId)]
);

export type ShopifyOrder = typeof shopifyOrders.$inferSelect;
export type NewShopifyOrder = typeof shopifyOrders.$inferInsert;

export type ShopifyLineItem = typeof shopifyLineItems.$inferSelect;
export type NewShopifyLineItem = typeof shopifyLineItems.$inferInsert;

// ─── Knowledge Base ────────────────────────────────────────────────────

export const kbDocuments = pgTable(
  "kb_documents",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    content: text("content").notNull(),
    category: text("category").notNull(), // brand, strategy, meeting-notes, etc.
    subcategory: text("subcategory"),
    sourceFile: text("source_file"), // Dropbox path or manual entry ID
    contentHash: text("content_hash").notNull(), // SHA-256 for change detection
    chunkIndex: integer("chunk_index").notNull().default(0),
    totalChunks: integer("total_chunks").notNull().default(1),
    contextPrefix: text("context_prefix").notNull(),
    documentDate: timestamp("document_date", { withTimezone: true }),
    embedding: vector("embedding", { dimensions: 1536 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("kb_documents_category_idx").on(table.category),
    index("kb_documents_source_idx").on(table.sourceFile),
    index("kb_documents_hash_idx").on(table.contentHash),
  ]
);

export type KbDocument = typeof kbDocuments.$inferSelect;
export type NewKbDocument = typeof kbDocuments.$inferInsert;
