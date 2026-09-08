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
    // Nullable on purpose: Meta omits reach/frequency/cpp for queries that apply
    // breakdowns to start dates >13 months old (change effective 2025-06-10).
    // NULL means "Meta did not report this", which is NOT a measured zero — storing
    // 0 would silently corrupt frequency (impressions/reach) and cost-per-reach.
    reach: bigint("reach", { mode: "number" }),
    frequency: real("frequency"), // impressions per person reached
    cpp: real("cpp"), // cost per 1000 people reached
    cpm: real("cpm"), // cost per 1000 impressions
    cpc: real("cpc"), // cost per click
    ctr: real("ctr"), // click-through rate

    // Conversion events (7-day click attribution, CTC framework)
    purchases: integer("purchases").notNull().default(0),
    purchaseValueCents: integer("purchase_value_cents").notNull().default(0),
    addToCart: integer("add_to_cart").notNull().default(0),
    initiateCheckout: integer("initiate_checkout").notNull().default(0),
    // Which attribution window produced the conversion columns above. Recorded per
    // row so a dashboard can label it: these numbers read ~19% below Ads Manager's
    // default (1d_view + 7d_click) and the difference must be explainable.
    attributionWindow: text("attribution_window").notNull().default("7d_click"),

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

// ─── Sync run records ──────────────────────────────────────────────────

/**
 * One row per sync attempt, written whether the attempt succeeded, failed, or
 * never got off the ground.
 *
 * This exists because a sync that errored, a sync that ran and found nothing,
 * and a sync that never ran at all were previously indistinguishable — all three
 * logged "Done: 0 insights". `meta_insights` sat empty for months because
 * META_AD_ACCOUNT_ID was unset and the task silently returned every day.
 *
 * `outcome` is the load-bearing column. Row counts alone cannot tell you whether
 * zero means "no spend that day" or "auth is dead".
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Task identifier, e.g. "sync:meta" or "backfill:meta".
    task: text("task").notNull(),
    // ok            — ran, wrote data
    // no-data       — ran cleanly, Meta returned nothing (genuinely no delivery)
    // auth-failed   — token rejected/expired (Meta error 190)
    // rate-limited  — throttled (Meta errors 17, 80000, 4, 613)
    // api-error     — any other API or transport failure
    // not-configured— required credentials/account id absent, never called out
    outcome: text("outcome").notNull(),
    // Window the run covered, for backfill chunks. Null for structure-only syncs.
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    rowsWritten: integer("rows_written").notNull().default(0),
    // Human-readable failure detail; null when outcome is ok/no-data.
    errorMessage: text("error_message"),
    // Meta's numeric error code when there was one, for machine classification.
    errorCode: integer("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sync_runs_task_started_idx").on(table.task, table.startedAt),
    index("sync_runs_task_window_idx").on(table.task, table.windowStart),
  ]
);

export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;

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

/**
 * Variant-level stock levels, refreshed on every inventory sync.
 *
 * `tracked` is 0 when Shopify is not tracking stock for the variant — those
 * rows always report quantity 0 and must never be read as a stockout.
 * `quantity` may be negative when a variant has been oversold.
 */
export const shopifyInventory = pgTable(
  "shopify_inventory",
  {
    id: text("id").primaryKey(), // Shopify variant GID
    productId: text("product_id"),
    productTitle: text("product_title").notNull(),
    variantTitle: text("variant_title"),
    sku: text("sku"),
    quantity: integer("quantity").notNull(),
    tracked: integer("tracked").notNull(), // 0/1
    productStatus: text("product_status").notNull(), // ACTIVE, DRAFT, ARCHIVED
    productType: text("product_type"),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("shopify_inventory_product_idx").on(table.productId),
    index("shopify_inventory_status_idx").on(table.productStatus),
  ]
);

export type ShopifyOrder = typeof shopifyOrders.$inferSelect;
export type NewShopifyOrder = typeof shopifyOrders.$inferInsert;

export type ShopifyLineItem = typeof shopifyLineItems.$inferSelect;
export type NewShopifyLineItem = typeof shopifyLineItems.$inferInsert;

export type ShopifyInventoryRow = typeof shopifyInventory.$inferSelect;
export type NewShopifyInventoryRow = typeof shopifyInventory.$inferInsert;

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

// ─── Blog ──────────────────────────────────────────────────────────────

export const blogTopics = pgTable("blog_topics", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  description: text("description"),
  targetDate: timestamp("target_date", { withTimezone: true }),
  priority: integer("priority").notNull().default(5), // lower = higher priority
  status: text("status").notNull().default("pending"), // pending, generating, published, skipped
  tags: jsonb("tags").$type<string[]>(),
  repeatYearly: integer("repeat_yearly").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const blogGenerations = pgTable(
  "blog_generations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    topicId: text("topic_id")
      .notNull()
      .references(() => blogTopics.id),
    articleHtml: text("article_html").notNull(),
    shopifyDraftUrl: text("shopify_draft_url"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("blog_generations_topic_idx").on(table.topicId),
  ]
);

export type BlogTopic = typeof blogTopics.$inferSelect;
export type NewBlogTopic = typeof blogTopics.$inferInsert;

export type BlogGeneration = typeof blogGenerations.$inferSelect;
export type NewBlogGeneration = typeof blogGenerations.$inferInsert;

// ─── Social (Organic Instagram) ──────────────────────────────────────

export const socialPosts = pgTable(
  "social_posts",
  {
    id: text("id").primaryKey(), // Instagram media ID
    igUserId: text("ig_user_id").notNull(),
    caption: text("caption"),
    mediaType: text("media_type").notNull(), // IMAGE, VIDEO, CAROUSEL_ALBUM
    mediaProductType: text("media_product_type"), // FEED, REELS, STORY
    permalink: text("permalink"),
    thumbnailUrl: text("thumbnail_url"),

    // Engagement (from media object — lightweight, always available)
    likeCount: integer("like_count").notNull().default(0),
    commentsCount: integer("comments_count").notNull().default(0),

    // Insights (from media insights endpoint — richer metrics)
    impressions: integer("impressions").notNull().default(0),
    reach: integer("reach").notNull().default(0),
    saved: integer("saved").notNull().default(0),
    shares: integer("shares").notNull().default(0),
    plays: integer("plays").notNull().default(0), // video/reel only
    totalInteractions: integer("total_interactions").notNull().default(0),

    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("social_posts_posted_idx").on(table.postedAt),
    index("social_posts_media_type_idx").on(table.mediaType),
    index("social_posts_ig_user_idx").on(table.igUserId),
  ]
);

export type SocialPost = typeof socialPosts.$inferSelect;
export type NewSocialPost = typeof socialPosts.$inferInsert;

// ─── Attentive (Email/SMS) ───────────────────────────────────────────

export const attentiveCampaigns = pgTable(
  "attentive_campaigns",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    date: timestamp("date", { withTimezone: true, mode: "date" }).notNull(),
    messageVariant: text("message_variant").notNull(), // Email, SMS
    hasMedia: integer("has_media").notNull().default(0),
    delivered: integer("delivered").notNull().default(0),
    totalClicks: integer("total_clicks").notNull().default(0),
    totalClickRate: real("total_click_rate"),
    conversions: integer("conversions").notNull().default(0),
    conversionRate: real("conversion_rate"),
    revenueCents: integer("revenue_cents").notNull().default(0),
    unsubscribes: integer("unsubscribes").notNull().default(0),
    unsubscribeRate: real("unsubscribe_rate"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("attentive_campaigns_date_idx").on(table.date),
    index("attentive_campaigns_variant_idx").on(table.messageVariant),
    uniqueIndex("attentive_campaigns_dedup_idx").on(table.date, table.messageVariant),
  ]
);

export const attentiveRevenue = pgTable(
  "attentive_revenue",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    date: timestamp("date", { withTimezone: true, mode: "date" }).notNull(),
    conversions: integer("conversions").notNull().default(0),
    revenueCents: integer("revenue_cents").notNull().default(0),
    avgOrderValueCents: integer("avg_order_value_cents").notNull().default(0),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("attentive_revenue_date_idx").on(table.date),
    uniqueIndex("attentive_revenue_dedup_idx").on(table.date),
  ]
);

export type AttentiveCampaign = typeof attentiveCampaigns.$inferSelect;
export type NewAttentiveCampaign = typeof attentiveCampaigns.$inferInsert;

export type AttentiveRevenue = typeof attentiveRevenue.$inferSelect;
export type NewAttentiveRevenue = typeof attentiveRevenue.$inferInsert;

// ─── Voice Profile ───────────────────────────────────────────────────

export const voiceSamples = pgTable("voice_samples", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  content: text("content").notNull(),
  tags: jsonb("tags").$type<string[]>().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const voiceRules = pgTable("voice_rules", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  rule: text("rule").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const voiceBannedWords = pgTable("voice_banned_words", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  word: text("word").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VoiceSample = typeof voiceSamples.$inferSelect;
export type VoiceRule = typeof voiceRules.$inferSelect;
export type VoiceBannedWord = typeof voiceBannedWords.$inferSelect;

// ─── Marketing Calendar ──────────────────────────────────────────────

export const calendarEntries = pgTable(
  "calendar_entries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    date: timestamp("date", { withTimezone: true, mode: "date" }).notNull(),
    channel: text("channel").notNull(), // Email, SMS, Ad, Reel, Post, Story, Blog
    title: text("title").notNull(),
    status: text("status").notNull().default("planned"), // idea, planned, scheduled, sent, posted, skipped
    notes: text("notes"),
    aiSuggested: integer("ai_suggested").notNull().default(0), // 0 = human, 1 = AI
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("calendar_entries_date_idx").on(table.date),
    index("calendar_entries_channel_idx").on(table.channel),
    index("calendar_entries_status_idx").on(table.status),
  ]
);

export type CalendarEntry = typeof calendarEntries.$inferSelect;
export type NewCalendarEntry = typeof calendarEntries.$inferInsert;

// ─── Agent Sessions (cookie persistence) ─────────────────────────────

export const agentSessions = pgTable("agent_sessions", {
  id: text("id").primaryKey(), // e.g., "attentive"
  cookiesJson: text("cookies_json").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Seal Subscriptions ────────────────────────────────────────────────

/**
 * Current state, one row per subscription, overwritten every sync.
 *
 * Seal has no `since` filter and silently ignores unknown query params, so
 * every sync is a full crawl of all ~88 pages and every row is rewritten.
 * `manualOrigin` marks the ~92% of records created by the Color Happy → RAD
 * migration, which carry a synthetic "_manual_xxxxx" order id and therefore
 * have no Shopify order to join to.
 */
export const sealSubscriptions = pgTable(
  "seal_subscriptions",
  {
    id: text("id").primaryKey(), // Seal's subscription ID
    orderId: text("order_id").notNull(), // raw, may be "_manual_xxxxx"
    shopifyOrderId: text("shopify_order_id"), // GID form, null when manual origin
    manualOrigin: integer("manual_origin").notNull().default(0), // 0 = false, 1 = true
    email: text("email"),

    // Bare numeric Shopify customer ID, available only from the
    // single-subscription endpoint. shopify_orders holds the same value as a
    // GID, so the join extracts the numeric portion of that.
    customerId: text("customer_id"),
    // When the lookup last ran. Lets "no customer behind this subscription" be
    // told apart from "never looked up" — without it, a failed backfill and a
    // genuinely customer-less record are indistinguishable.
    customerIdCheckedAt: timestamp("customer_id_checked_at", { withTimezone: true }),

    status: text("status").notNull(), // ACTIVE, CANCELLED

    // Tier and cohort come from variant_id — never from price or selling plan.
    tier: text("tier").notNull(), // spark, studio, unknown
    pricingCohort: text("pricing_cohort").notNull(), // grandfathered, current, unknown
    variantId: text("variant_id"),
    productId: text("product_id"),
    variantSku: text("variant_sku"),
    productTitle: text("product_title"),

    // Corroboration only. Empty on ~90% of records.
    sellingPlanId: text("selling_plan_id"),
    sellingPlanName: text("selling_plan_name"),
    planConflict: integer("plan_conflict").notNull().default(0), // plan name disagrees with variant

    priceCents: bigint("price_cents", { mode: "number" }),
    priceAnomaly: integer("price_anomaly").notNull().default(0), // excluded from MRR/LTV
    currency: text("currency").notNull().default("USD"),

    billingInterval: text("billing_interval").notNull(), // raw: "1 month", "12 month", "13 month"
    billingCadence: text("billing_cadence").notNull(), // monthly, annual, other
    // Set when the cadence was normalised from a non-canonical interval — e.g.
    // the 13-month pre-sale correction that counts as annual.
    cadenceNote: text("cadence_note"),

    orderPlaced: timestamp("order_placed", { withTimezone: true }),
    nextBillingDate: timestamp("next_billing_date", { withTimezone: true }),
    cancelledOn: timestamp("cancelled_on", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),

    // Seal's own audit trail: [{ content, created }], newest first. Only the
    // single-subscription endpoint carries it. This is the ONLY record of tier
    // changes that predate our daily snapshots — an upgrade edits the existing
    // subscription in place, so order_placed, status and the current-state row
    // look identical before and after. Without this, the June-onward
    // Spark→Studio movement is unrecoverable.
    log: jsonb("log"),
    /** Shopify tags as a string array. */
    tags: jsonb("tags"),
    // When log/tags were last fetched. Deliberately separate from
    // customer_id_checked_at: every row already has that set from the earlier
    // customer-ID backfill, so reusing it would make "log captured" and "log
    // never fetched" indistinguishable and the crawl unresumable.
    detailCheckedAt: timestamp("detail_checked_at", { withTimezone: true }),

    // Derived from billing_attempts[].status === "error" only. A completed
    // attempt can carry a stale error_code, so the code is stored for the
    // campaign copy but never used to decide the boolean.
    inDunning: integer("in_dunning").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),

    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("seal_subscriptions_status_idx").on(table.status),
    index("seal_subscriptions_tier_idx").on(table.tier, table.pricingCohort),
    index("seal_subscriptions_dunning_idx").on(table.inDunning),
    index("seal_subscriptions_shopify_order_idx").on(table.shopifyOrderId),
    index("seal_subscriptions_next_billing_idx").on(table.nextBillingDate),
    index("seal_subscriptions_customer_idx").on(table.customerId),
  ]
);

export type SealSubscriptionRecord = typeof sealSubscriptions.$inferSelect;
export type NewSealSubscriptionRecord = typeof sealSubscriptions.$inferInsert;

/**
 * One row per subscription per sync day.
 *
 * The current-state table above overwrites itself, so an upgrade from Spark to
 * Studio, or a move from grandfathered to current pricing, leaves no trace
 * there. This is what makes real cohort retention answerable rather than
 * inferred.
 */
export const sealSubscriptionSnapshots = pgTable(
  "seal_subscription_snapshots",
  {
    id: text("id").primaryKey(), // "<snapshotDate>:<subscriptionId>"
    snapshotDate: text("snapshot_date").notNull(), // YYYY-MM-DD, UTC
    subscriptionId: text("subscription_id").notNull(),

    status: text("status").notNull(),
    tier: text("tier").notNull(),
    pricingCohort: text("pricing_cohort").notNull(),
    billingInterval: text("billing_interval").notNull(),
    billingCadence: text("billing_cadence").notNull(),
    cadenceNote: text("cadence_note"),
    priceCents: bigint("price_cents", { mode: "number" }),
    inDunning: integer("in_dunning").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("seal_snapshots_date_idx").on(table.snapshotDate),
    index("seal_snapshots_subscription_idx").on(table.subscriptionId),
    uniqueIndex("seal_snapshots_date_sub_idx").on(table.snapshotDate, table.subscriptionId),
  ]
);

export type SealSubscriptionSnapshot = typeof sealSubscriptionSnapshots.$inferSelect;
export type NewSealSubscriptionSnapshot = typeof sealSubscriptionSnapshots.$inferInsert;

// ─── Pilot notes ───────────────────────────────────────────────────────

/**
 * An append-only log of observations about the system and the business.
 *
 * This is the one table anything on the MCP server can write to, which is why
 * it is a log of ENTRIES rather than a table of notes with a mutable status.
 * Nothing is ever updated or deleted: opening a note, adding context and
 * resolving it are three separate rows sharing a `note_id`, and a note's
 * current status is derived by folding its entries in time order.
 *
 * The alternative — a `status` column flipped in place — would let a bad write
 * erase the reasoning that produced a note, and leave no trace that it had.
 * Here the worst a bad write can do is append something wrong, which is
 * visible and correctable by appending again.
 */
export const pilotNotes = pgTable(
  "pilot_notes",
  {
    id: text("id").primaryKey(),
    /** Groups the entries belonging to one note. The opening entry's id. */
    noteId: text("note_id").notNull(),

    // open      — creates the note. Carries the title.
    // comment   — adds context without changing status.
    // resolution — closes the note. Carries why.
    kind: text("kind").notNull(),

    /** Set on the opening entry; null on later ones, which inherit it. */
    title: text("title"),
    body: text("body").notNull(),
    /** Free-form grouping: "meta", "subscriptions", "data-quality", etc. */
    category: text("category"),
    /** Who wrote it — "claude" for agent-authored, or a person's name. */
    author: text("author").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pilot_notes_note_idx").on(table.noteId),
    index("pilot_notes_created_idx").on(table.createdAt),
    index("pilot_notes_category_idx").on(table.category),
  ]
);

export type PilotNoteEntry = typeof pilotNotes.$inferSelect;
export type NewPilotNoteEntry = typeof pilotNotes.$inferInsert;

/**
 * Tier changes read out of Seal's log, materialised.
 *
 * The fold that produces these lives in src/domain/subscriptions/tier-changes.ts
 * and is covered by its own tests. Re-deriving it in SQL for the analytics views
 * would create a second implementation that can silently disagree with the
 * subscription_changes tool — two different upgrade counts for the same month,
 * with nothing to say which is right. So the parser stays the single source and
 * writes its result here.
 *
 * Rebuilt wholesale from the stored logs on every sync rather than appended to:
 * a re-parse of a corrected log has to be able to remove events, not just add.
 */
export const sealTierChangeEvents = pgTable(
  "seal_tier_change_events",
  {
    /** subscriptionId + timestamp — deterministic, so a rebuild is idempotent. */
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    fromTier: text("from_tier").notNull(),
    toTier: text("to_tier").notNull(),
    /** upgrade, downgrade, or none when either side is an unrecognised tier. */
    direction: text("direction").notNull(),
    /**
     * Whether Seal logged a price edit beside this change. False on every event
     * on record — Seal writes no price entry when the price follows the variant
     * — so it is stored to make that verifiable rather than as a live signal.
     */
    priceChangeLogged: integer("price_change_logged").notNull().default(0),
    /** The subscription's cohort today. The log does not record cohort. */
    pricingCohort: text("pricing_cohort").notNull(),
    builtAt: timestamp("built_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("seal_tier_change_events_sub_idx").on(table.subscriptionId),
    index("seal_tier_change_events_at_idx").on(table.changedAt),
  ]
);

/**
 * Every statement the `query` MCP tool ran. Written by the tool itself, not by
 * the read-only role, which has no INSERT anywhere.
 */
export const queryLog = pgTable(
  "query_log",
  {
    id: text("id").primaryKey(),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull(),
    sqlText: text("sql_text").notNull(),
    /** Rows handed back, which is capped and so may be fewer than matched. */
    rowCount: integer("row_count").notNull(),
    truncated: integer("truncated").notNull().default(0),
    durationMs: integer("duration_ms").notNull(),
    /** Null when the statement succeeded. */
    errorMessage: text("error_message"),
  },
  (table) => [index("query_log_ran_at_idx").on(table.ranAt)]
);

/**
 * What each process found in its own environment when it last started.
 *
 * Three features have shipped tested and green with their variable unset in
 * production — SEAL_API_TOKEN, META_AD_ACCOUNT_ID, ANALYTICS_DATABASE_URL — and
 * in every case the code degraded politely and nothing downstream ever said so.
 * A process can only read its own `process.env`, so this table is how the
 * worker's environment becomes visible to the MCP, which is where anyone asking
 * "why is this empty?" is actually looking.
 *
 * One row per surface, overwritten on each check: the question is what is true
 * now, and a log of every startup would bury it. `checked_at` therefore doubles
 * as a liveness signal — the worker rewrites it daily, so a row that stops
 * advancing means the process stopped running.
 *
 * Names only. No value is ever written here.
 */
export const envChecks = pgTable("env_checks", {
  /** "worker" | "web" | "mcp" — see SURFACES in src/lib/env-manifest.ts. */
  surface: text("surface").primaryKey(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  /** 1 when nothing required or feature-disabling was absent. Optionals excluded. */
  ok: integer("ok").notNull(),
  /** How many variables this surface expects, so a shrunken manifest is visible. */
  expected: integer("expected").notNull(),
  /** Names only — the surface cannot function without these. */
  missingRequired: jsonb("missing_required").$type<string[]>().notNull(),
  /** Names only — the surface runs, but a named feature is off. */
  missingDegraded: jsonb("missing_degraded").$type<string[]>().notNull(),
});

export type SealTierChangeEvent = typeof sealTierChangeEvents.$inferSelect;
export type QueryLogRow = typeof queryLog.$inferSelect;
export type EnvCheckRow = typeof envChecks.$inferSelect;
