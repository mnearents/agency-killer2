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
  date,
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
    variantTitle: text("variant_title"),
    vendor: text("vendor"),
    quantity: integer("quantity").notNull(),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(), // unit price
    /**
     * Discount allocated to this line. Per-product revenue computed from
     * price_cents alone is GROSS, and overstates what a product earned in any
     * period with a promotion running. Net is price_cents * quantity minus this.
     *
     * Nullable rather than defaulted to 0: rows synced before the backfill have
     * no discount data, and a 0 there is indistinguishable from a real
     * undiscounted line. Null says "unknown", which is the truth.
     */
    totalDiscountCents: bigint("total_discount_cents", { mode: "number" }),
    /** 0/1, null when unknown. Separates physical goods from digital printables. */
    requiresShipping: integer("requires_shipping"),
    rawJson: jsonb("raw_json"),
  },
  (table) => [index("shopify_line_items_product_idx").on(table.productId)]
);

/**
 * One row per Shopify customer — the entity that lets a person be followed
 * across orders and subscriptions. Without it, "who buys this" has no subject.
 *
 * PII lives here and is excluded from the analytics view, per the structural
 * approach in migration 0015: base tables are unreachable by `claude_readonly`,
 * and the view is the only way in. Email is stored because the identity join to
 * `seal_subscriptions` needs it and because pushing an audience to a sending
 * platform needs it — not because anything analytical reads it.
 *
 * The `*_derived` fields are a materialised rollup, refreshed by the sync. They
 * are a cache of what the orders and subscriptions tables already say, kept
 * because the alternative is a five-way join in every question anyone asks.
 * `days_since_last_order` is deliberately NOT stored: it would be wrong the
 * moment a day passed, and a stale number that looks fresh is worse than a
 * join. The view computes it.
 */
export const shopifyCustomers = pgTable(
  "shopify_customers",
  {
    id: text("id").primaryKey(), // GID form: gid://shopify/Customer/123

    // ─── PII — excluded from the analytics view ───
    email: text("email"),
    firstName: text("first_name"),
    lastName: text("last_name"),

    // ─── Shopify's own counters ───
    // Kept alongside our derived equivalents rather than instead of them: when
    // the two disagree it means our order history is incomplete, which is a
    // fact worth being able to see rather than one to paper over.
    ordersCount: integer("orders_count"),
    totalSpentCents: bigint("total_spent_cents", { mode: "number" }),

    /**
     * Shopify's CUSTOMER tags — deliberately not called `tags`.
     *
     * `shopify_orders.tags` is a different thing that shares the name: those
     * are the *product's* tags copied onto the order, so `homeschool` sits on
     * 42,094 of 54,225 orders. Customer tags are the opposite — they carry
     * subscription lifecycle state written by the subscription apps
     * (`inactive_subscriber`, `inactive-subscriber`, `active-subscriber`,
     * `paused-subscriber`, `appstle`, `color_happy_imported`, tier tags), and
     * they are the authoritative source for who has lapsed. Two columns both
     * named `tags` is what let one be queried in place of the other.
     */
    customerTags: jsonb("customer_tags").$type<string[]>(),
    /** 0/1, null when Shopify does not report a consent state. */
    acceptsMarketing: integer("accepts_marketing"),

    // ─── Geography ───
    // City/state/country only. Analytically useful and not identifying at this
    // granularity. Street address is deliberately not synced at all.
    city: text("city"),
    state: text("state"),
    country: text("country"),

    customerCreatedAt: timestamp("customer_created_at", { withTimezone: true }),

    // ─── Derived from orders ───
    firstOrderAt: timestamp("first_order_at", { withTimezone: true }),
    lastOrderAt: timestamp("last_order_at", { withTimezone: true }),
    lifetimeOrders: integer("lifetime_orders"),
    /**
     * Split, never a single total. A customer worth $25.79 once and a customer
     * worth $60-180 recurring at near-zero COGS are different businesses, and
     * one lifetime_revenue number averages them into something that describes
     * neither. This is the same distinction that makes the Meta attribution
     * question answerable.
     */
    subscriptionRevenueCents: bigint("subscription_revenue_cents", { mode: "number" }),
    oneOffRevenueCents: bigint("one_off_revenue_cents", { mode: "number" }),
    /** Distinct product types across all line items. */
    productTypesPurchased: jsonb("product_types_purchased"),

    /**
     * Proxies for signup and cancellation, from orders of a product whose
     * product_type is 'Subscription'.
     *
     * Real subscription dates did not survive two subscription-app migrations,
     * so these are the only dates the lapsed population has. They are weak in a
     * specific way: order history begins 2025-07-22, so 85.7% of lapsed
     * customers have no subscription order at all and both columns stay NULL —
     * which is the honest answer, not a reason to substitute first_order_at.
     * A customer whose first subscription order sits at the start of that
     * window was already subscribing when it opened, so the span between these
     * two is a floor on tenure and never a measurement of it.
     */
    firstSubscriptionOrderAt: timestamp("first_subscription_order_at", { withTimezone: true }),
    lastSubscriptionOrderAt: timestamp("last_subscription_order_at", { withTimezone: true }),

    // ─── Derived from Seal ───
    /** 0/1. Joined via split_part(id, '/', 5) — Seal stores the bare numeric ID. */
    isSubscriber: integer("is_subscriber"),
    subscriptionTier: text("subscription_tier"), // spark, studio, unknown
    subscriptionStatus: text("subscription_status"), // ACTIVE, CANCELLED
    /** When the rollup last ran. Distinguishes "no orders" from "never computed". */
    derivedAt: timestamp("derived_at", { withTimezone: true }),

    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("shopify_customers_last_order_idx").on(table.lastOrderAt),
    index("shopify_customers_subscriber_idx").on(table.isSubscriber),
    index("shopify_customers_last_sub_order_idx").on(table.lastSubscriptionOrderAt),
  ]
);

/**
 * Named audience definitions, writable by Claude.
 *
 * The point is that "teachers" means the same thing in every analysis rather
 * than being redefined ad hoc each time. Two analyses that both say "teachers"
 * and mean different populations produce a contradiction nobody can debug,
 * because the definition lives in whichever conversation produced it. Storing
 * the predicate makes the number reproducible and, more usefully, arguable —
 * you can disagree with a definition you can read.
 *
 * A segment IS its definition. `member_count` and `last_evaluated_at` are a
 * cache of what that definition returned last time it ran, never the truth.
 * Reading a count without checking when it was evaluated is how a stale number
 * gets quoted as a current one.
 */
export const segments = pgTable(
  "segments",
  {
    id: text("id").primaryKey(), // slug, e.g. "teachers"
    name: text("name").notNull(),
    /** SQL predicate evaluated against the customer view. */
    definition: text("definition").notNull(),
    /** Why this definition and not another — the arguable part. */
    notes: text("notes"),
    memberCount: integer("member_count"),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    /** Set when the last evaluation failed, so a stale count is not read as current. */
    lastEvaluationError: text("last_evaluation_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }
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
    /**
     * Shopify InventoryItem GID — the stock pool, not the variant. Several
     * variants pointing at one id sell the same physical units, so summing
     * their quantities counts that stock once per variant. Null until the
     * first sync after migration 0020, and null for variants Shopify returns
     * without an inventoryItem.
     */
    inventoryItemId: text("inventory_item_id"),
    /**
     * Shopify's "Cost per item" in cents — landed product cost, meaning
     * invoice plus freight plus duty. The input every cost-of-delivery figure
     * rests on (#34).
     *
     * NULL means no cost is recorded; 0 means it genuinely costs nothing.
     * Digital products, gift cards and subscriptions are legitimately 0 and
     * make up 181 of 232 active variants, so a naive "how many have a cost"
     * count reports ~18% and describes a catalogue that is mostly zero-COGS by
     * design rather than a data gap. Among physical variants the figure is
     * 82.4% (42 of 51). Always say which population a coverage number is over.
     */
    unitCostCents: integer("unit_cost_cents"),
    productStatus: text("product_status").notNull(), // ACTIVE, DRAFT, ARCHIVED
    productType: text("product_type"),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("shopify_inventory_product_idx").on(table.productId),
    index("shopify_inventory_status_idx").on(table.productStatus),
    index("shopify_inventory_item_idx").on(table.inventoryItemId),
  ]
);

export type ShopifyOrder = typeof shopifyOrders.$inferSelect;
export type NewShopifyOrder = typeof shopifyOrders.$inferInsert;

export type ShopifyLineItem = typeof shopifyLineItems.$inferSelect;
export type NewShopifyLineItem = typeof shopifyLineItems.$inferInsert;

export type ShopifyInventoryRow = typeof shopifyInventory.$inferSelect;
export type NewShopifyInventoryRow = typeof shopifyInventory.$inferInsert;

export type ShopifyCustomer = typeof shopifyCustomers.$inferSelect;
export type NewShopifyCustomer = typeof shopifyCustomers.$inferInsert;

export type Segment = typeof segments.$inferSelect;
export type NewSegment = typeof segments.$inferInsert;

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

/**
 * ─── Campaign, journey and cost detail (#23) ──────────────────────────
 *
 * `attentive_campaigns` above is one row per day per channel despite its name:
 * it has no campaign id and no campaign name, so a winning launch email and
 * four filler sends average into one mediocre number and both facts disappear.
 * These three tables hold what the aggregate cannot.
 *
 * They are separate tables rather than columns on the old one because the
 * grain is different — per message, per journey step, per day of cost — and
 * because `attentive_campaigns_dedup_idx` is applied in production on
 * (date, message_variant), which a campaign-level row would collide with.
 */
export const attentiveCampaignMessages = pgTable(
  "attentive_campaign_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    date: timestamp("date", { withTimezone: true, mode: "date" }).notNull(),
    campaign: text("campaign").notNull(),
    message: text("message").notNull(),
    messageVariant: text("message_variant").notNull().default(""),
    channel: text("channel").notNull(),
    hasMedia: integer("has_media").notNull().default(0),
    delivered: integer("delivered").notNull().default(0),
    emailSends: integer("email_sends").notNull().default(0),
    emailUniqueOpens: integer("email_unique_opens").notNull().default(0),
    emailUniqueClicks: integer("email_unique_clicks").notNull().default(0),
    totalClicks: integer("total_clicks").notNull().default(0),
    conversions: integer("conversions").notNull().default(0),
    revenueCents: integer("revenue_cents").notNull().default(0),
    /** Null when there were no orders. Zero would say the orders were free. */
    avgOrderValueCents: integer("avg_order_value_cents"),
    /** The cost side of every send. #23 calls this the one most likely to be dropped. */
    unsubscribes: integer("unsubscribes").notNull().default(0),
    emailHardBounces: integer("email_hard_bounces").notNull().default(0),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("attentive_campaign_messages_date_idx").on(table.date),
    index("attentive_campaign_messages_campaign_idx").on(table.campaign),
    uniqueIndex("attentive_campaign_messages_dedup_idx").on(
      table.date,
      table.campaign,
      table.message,
      table.channel
    ),
  ]
);

/**
 * The same sends, broken out by the audience they went to.
 *
 * A separate table rather than a `segment` column on the rows above, for two
 * reasons. A nullable column in a unique index does not dedupe — Postgres
 * treats every NULL as distinct, so an unsegmented send would insert afresh on
 * every import and `onConflictDoUpdate` would never fire. And the grain really
 * is different: these rows sum to the same revenue as the campaign rows, so
 * holding both in one table is an invitation to count it twice.
 */
export const attentiveCampaignSegments = pgTable(
  "attentive_campaign_segments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    date: timestamp("date", { withTimezone: true, mode: "date" }).notNull(),
    message: text("message").notNull(),
    /** "All Subscribers" for a whole-list send — Attentive's own wording. */
    segment: text("segment").notNull(),
    channel: text("channel").notNull(),
    delivered: integer("delivered").notNull().default(0),
    totalClicks: integer("total_clicks").notNull().default(0),
    conversions: integer("conversions").notNull().default(0),
    revenueCents: integer("revenue_cents").notNull().default(0),
    unsubscribes: integer("unsubscribes").notNull().default(0),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("attentive_campaign_segments_date_idx").on(table.date),
    index("attentive_campaign_segments_segment_idx").on(table.segment),
    uniqueIndex("attentive_campaign_segments_dedup_idx").on(
      table.date,
      table.message,
      table.segment,
      table.channel
    ),
  ]
);

export const attentiveJourneyMessages = pgTable(
  "attentive_journey_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    date: timestamp("date", { withTimezone: true, mode: "date" }).notNull(),
    journeyName: text("journey_name").notNull(),
    triggerName: text("trigger_name").notNull().default(""),
    message: text("message").notNull(),
    channel: text("channel").notNull(),
    delivered: integer("delivered").notNull().default(0),
    totalClicks: integer("total_clicks").notNull().default(0),
    conversions: integer("conversions").notNull().default(0),
    revenueCents: integer("revenue_cents").notNull().default(0),
    avgOrderValueCents: integer("avg_order_value_cents"),
    unsubscribes: integer("unsubscribes").notNull().default(0),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("attentive_journey_messages_date_idx").on(table.date),
    index("attentive_journey_messages_journey_idx").on(table.journeyName),
    uniqueIndex("attentive_journey_messages_dedup_idx").on(
      table.date,
      table.journeyName,
      table.message,
      table.channel
    ),
  ]
);

/**
 * Daily SMS cost — not on #23's list, and the cheapest thing in the export.
 *
 * #34 needs it: a journey's revenue and its revenue net of carrier fees are
 * different numbers, and only one of them is a margin.
 */
export const attentiveMessageCosts = pgTable(
  "attentive_message_costs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    date: timestamp("date", { withTimezone: true, mode: "date" }).notNull(),
    campaignCostCents: integer("campaign_cost_cents").notNull().default(0),
    automatedSendCostCents: integer("automated_send_cost_cents").notNull().default(0),
    receivedCostCents: integer("received_cost_cents").notNull().default(0),
    carrierFeesCents: integer("carrier_fees_cents").notNull().default(0),
    /** As reported. The rounded parts do not always add to it. */
    totalCents: integer("total_cents").notNull().default(0),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("attentive_message_costs_dedup_idx").on(table.date)]
);

/**
 * What each surface found in its environment at boot (#35).
 *
 * The worker runs on Railway and the MCP is spawned by Claude Desktop on
 * Matt's Mac, so `process.env` in one says nothing about the other — and two
 * of the three variables that shipped unset were the worker's. The worker
 * records its own check here so `data_freshness` can report it from anywhere.
 *
 * `variables` holds names and a present flag and NOTHING else. The analytics
 * role can read this, so it has to be safe to expose by construction rather
 * than by review.
 *
 * One row per surface, replaced on each boot. `recordedAt` is what makes a
 * stale record read as stale instead of as current.
 */
export const envChecks = pgTable("env_checks", {
  surface: text("surface").primaryKey(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  /** `[{ "name": "SEAL_API_TOKEN", "present": false }]` — never a value. */
  variables: jsonb("variables").notNull(),
  missingRequired: integer("missing_required").notNull().default(0),
  missingDegraded: integer("missing_degraded").notNull().default(0),
});

export type EnvCheckRow = typeof envChecks.$inferSelect;

export type AttentiveCampaignMessage = typeof attentiveCampaignMessages.$inferSelect;
export type AttentiveCampaignSegment = typeof attentiveCampaignSegments.$inferSelect;
export type AttentiveJourneyMessage = typeof attentiveJourneyMessages.$inferSelect;
export type AttentiveMessageCost = typeof attentiveMessageCosts.$inferSelect;

export type AttentiveCampaign = typeof attentiveCampaigns.$inferSelect;
export type NewAttentiveCampaign = typeof attentiveCampaigns.$inferInsert;

export type AttentiveRevenue = typeof attentiveRevenue.$inferSelect;
export type NewAttentiveRevenue = typeof attentiveRevenue.$inferInsert;

// ─── Voice Profile ───────────────────────────────────────────────────

export const voiceSamples = pgTable("voice_samples", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // Identifies the seed-file entry this row came from. NULL means a person
  // wrote it — through /voice, the API, or `!voice add` — and the seed file has
  // no authority to rewrite or delete it. See domain/voice/corpus-sync.ts.
  sourceKey: text("source_key").unique(),
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
  /** The rule text, when seed-authored. NULL for rules a person added. */
  sourceKey: text("source_key").unique(),
  rule: text("rule").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const voiceBannedWords = pgTable("voice_banned_words", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  /** The word, when seed-authored. NULL for words a person added. */
  sourceKey: text("source_key").unique(),
  word: text("word").notNull(),
  /**
   * `block` — do not publish this; copy containing it is refused.
   * `avoid`  — a preference; flagged, never blocking.
   *
   * Defaults to `avoid` because every word Tara listed is a style preference,
   * and treating one as a prohibition meant a finished draft containing
   * "delight" could not be saved at all (#60). Her words: "Delight shouldn't
   * be a hard ban, I just would rather not use that word. But it shouldn't
   * cause an entire response to fail."
   *
   * Nothing is `block` today. The one genuinely unpublishable category,
   * vulgarity, is a rule with its own regex rather than a word-list entry — so
   * `block` exists for a case that has not arisen rather than for these.
   */
  severity: text("severity").notNull().default("avoid"),
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
 * Experiments — the accountability layer.
 *
 * Two tables, both insert-only, and that split is the whole design. The
 * declaration is written before the answer is known; results are written after.
 * Keeping them apart means **there is no code path that can edit success
 * criteria once a result exists**, because recording a result writes a
 * different table. A convention saying "don't move the bar" is a wish; not
 * having an UPDATE is a guarantee.
 *
 * Same reasoning as `pilot_notes` being a log of entries rather than a table
 * with a mutable status, and it applies here with more force: the entire value
 * of the record is that one field was written before the outcome was known.
 *
 * There is deliberately no `outcome` column. Status is derived in
 * `src/domain/experiments/experiments.ts` from the declared window and the
 * results, so a stored `running` cannot sit there going stale — and the fold
 * can tell an experiment that is genuinely in flight from one whose window
 * closed and that nobody ever concluded.
 *
 * Calendar dates are DATE, not timestamptz. A declared window is a calendar
 * thing; storing it as an instant invites the off-by-one-day that comes with
 * every timezone conversion.
 */
export const experiments = pgTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    hypothesis: text("hypothesis").notNull(),
    whatWeChanged: text("what_we_changed").notNull(),

    /**
     * NOT NULL, and required by `experiment_start`. The one non-negotiable
     * constraint on this table: the moment it can be deferred it will be
     * deferred on exactly the experiments whose outcome is least certain,
     * which are the ones where it matters most.
     */
    successCriteria: text("success_criteria").notNull(),

    primaryMetric: text("primary_metric").notNull(),

    /** Nullable: some experiments genuinely have no prior number. */
    baselineValue: real("baseline_value"),
    /**
     * Never nullable. How the baseline was computed, or why there isn't one.
     * A silent null cannot be told apart from an oversight, and there is no
     * path to fill either in later.
     */
    baselineBasis: text("baseline_basis").notNull(),

    startDate: date("start_date", { mode: "string" }).notNull(),
    /** Declared up front, so the window cannot be extended until it looks good. */
    plannedEndDate: date("planned_end_date", { mode: "string" }).notNull(),

    /** Pilot notes this experiment came out of. */
    relatedNoteIds: jsonb("related_note_ids").$type<string[]>().notNull().default([]),

    author: text("author").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("experiments_created_idx").on(table.createdAt),
    index("experiments_planned_end_idx").on(table.plannedEndDate),
  ]
);

export type Experiment = typeof experiments.$inferSelect;
export type NewExperiment = typeof experiments.$inferInsert;

/**
 * Recorded results. Append-only: a correction is a new row, not an edit.
 *
 * The newest row decides the experiment's status and the earlier ones stay
 * visible, because a reading that changed is itself the interesting part —
 * overwriting it would erase the fact that it changed.
 *
 * Carries nothing from the declaration. That is what makes the pre-declaration
 * real rather than decorative.
 */
export const experimentResults = pgTable(
  "experiment_results",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id").notNull(),

    /** win | loss | inconclusive. Never "running" — that is the absence of a row. */
    outcome: text("outcome").notNull(),
    resultValue: real("result_value"),
    concludedOn: date("concluded_on", { mode: "string" }).notNull(),

    /**
     * NOT NULL. Inconclusive is expected to be the most common outcome on a
     * business this size, and this is where it earns its keep — usually the
     * finding is that the metric was wrong, the window too short, or the
     * change too small to detect.
     */
    learnings: text("learnings").notNull(),

    author: text("author").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("experiment_results_experiment_idx").on(table.experimentId),
    index("experiment_results_created_idx").on(table.createdAt),
  ]
);

export type ExperimentResultRow = typeof experimentResults.$inferSelect;
export type NewExperimentResultRow = typeof experimentResults.$inferInsert;

/**
 * Drafts — where Claude's copy work lives.
 *
 * Insert-only, like everything else Claude writes. A revision is a new draft,
 * not an edit: the body that Tara reacted to has to still be readable next to
 * the reaction, or the feedback is attached to text nobody can see any more.
 *
 * `status` is NOT a column here. It is derived from `draft_decisions`, because
 * a mutable status column would overwrite a rejection the moment a rewrite got
 * approved — deleting the highest-signal record in the system at the exact
 * point it became useful. See src/domain/drafts/drafts.ts.
 *
 * Claude writes drafts. Claude never publishes. Nothing in this system moves a
 * draft to `shipped`, and nothing downstream reads `approved` as authorisation
 * to send; Attentive, Meta and Shopify remain strictly read-only.
 */
export const drafts = pgTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    /** campaign_brief | ad_copy | email | sms | social_caption | product_description | blog_post */
    type: text("type").notNull(),
    title: text("title").notNull(),
    /**
     * The voice audience this copy was written for — a channel, or
     * 'unspecified'. Shared vocabulary with the voice rules, so a draft is
     * checked against the rules that actually apply to it.
     */
    channel: text("channel").notNull(),
    body: text("body").notNull(),

    /**
     * The voice rules this draft was checked against when it was saved.
     * Recorded rather than recomputed: the rules change, and "this passed"
     * means nothing without "passed what". A draft cannot be saved unless the
     * check ran and came back clean, so an empty array here would mean a row
     * that got in before the gate existed.
     */
    voiceRulesChecked: jsonb("voice_rules_checked").$type<string[]>().notNull(),

    author: text("author").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("drafts_created_idx").on(table.createdAt),
    index("drafts_type_idx").on(table.type),
    index("drafts_channel_idx").on(table.channel),
  ]
);

export type DraftRow = typeof drafts.$inferSelect;
export type NewDraftRow = typeof drafts.$inferInsert;

/**
 * Human decisions about drafts. Append-only.
 *
 * `feedback` is the valuable column and the reason this is a log rather than a
 * status flip. Tara is the voice being replicated, so her rejections are the
 * highest-signal training data available — a rejected draft plus the reason
 * marks a boundary the model crossed. Stored verbatim: a summarised reason
 * loses the phrasing, and the phrasing is the point when the subject is voice.
 *
 * `decided_by` names a person. `validateDecision` refuses an agent
 * attribution, because the realistic failure is not impersonation — it is a
 * write tool defaulting this field the way every other one defaults `author`,
 * and a draft reaching `approved` with no human in the loop.
 */
export const draftDecisions = pgTable(
  "draft_decisions",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id").notNull(),
    /** approved | rejected | shipped. Never 'draft' — that is having no row. */
    decision: text("decision").notNull(),
    feedback: text("feedback").notNull().default(""),
    decidedBy: text("decided_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("draft_decisions_draft_idx").on(table.draftId),
    index("draft_decisions_created_idx").on(table.createdAt),
  ]
);

export type DraftDecisionRow = typeof draftDecisions.$inferSelect;
export type NewDraftDecisionRow = typeof draftDecisions.$inferInsert;

/**
 * Segment pushes to Attentive — the history that makes a diff possible at all.
 *
 * Attentive exposes no endpoint that reads segment membership back. That
 * absence is why #23 inverted into #32, and it means "what is in the segment
 * right now" is not knowable from Attentive. The only possible basis for a
 * diff is a record of what we last sent, which is this table.
 *
 * Removals depend entirely on it. A segment that is only ever added to is
 * wrong the moment someone resubscribes, and they keep receiving win-back
 * campaigns as a paying customer.
 *
 * Append-only, like every other table Claude writes. A dry run is recorded
 * too, with `dry_run = 1`, because "we looked and decided not to" is worth
 * keeping — but only a completed real push defines what Attentive holds.
 */
export const segmentPushes = pgTable(
  "segment_pushes",
  {
    id: text("id").primaryKey(),
    segmentId: text("segment_id").notNull(),
    /** The externalId the segment carries in Attentive. */
    externalId: text("external_id").notNull(),

    /** 1 for a dry run, 0 for a real push. Only real pushes define membership. */
    dryRun: integer("dry_run").notNull(),

    /** The fingerprint of the diff that was approved. See planToken. */
    planToken: text("plan_token").notNull(),

    addedCount: integer("added_count").notNull(),
    removedCount: integer("removed_count").notNull(),
    unchangedCount: integer("unchanged_count").notNull(),

    /**
     * How many of the members a marketing message would actually reach, and
     * how many were checked to find out. Null means it was not measured —
     * never 0, which would claim nobody is reachable.
     */
    reachableChecked: integer("reachable_checked"),
    reachableEligible: integer("reachable_eligible"),

    /** Attentive job ids, so an outcome can be chased after the fact. */
    batchJobIds: jsonb("batch_job_ids").$type<string[]>().notNull().default([]),

    /**
     * Per-record outcome, read from each job's result file. Null means the
     * outcome was never established — the API's COMPLETED status alone does
     * not establish it, so null is the honest value rather than 0 failures.
     */
    recordsSucceeded: integer("records_succeeded"),
    recordsFailed: integer("records_failed"),

    /** Non-null when the push did not do what it appears to have done. */
    problem: text("problem"),

    /** The person who approved it. Never an agent — see drafts.ts. */
    pushedBy: text("pushed_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("segment_pushes_segment_idx").on(table.segmentId),
    index("segment_pushes_created_idx").on(table.createdAt),
  ]
);

export type SegmentPushRow = typeof segmentPushes.$inferSelect;
export type NewSegmentPushRow = typeof segmentPushes.$inferInsert;

/**
 * The membership a real push sent, one row per member.
 *
 * Stored rather than recomputed, because the underlying customer data moves:
 * re-running the predicate later answers "who matches now", not "who did we
 * send". Only the second one can produce a correct removal list.
 */
export const segmentPushMembers = pgTable(
  "segment_push_members",
  {
    pushId: text("push_id").notNull(),
    email: text("email").notNull(),
  },
  (table) => [
    index("segment_push_members_push_idx").on(table.pushId),
    uniqueIndex("segment_push_members_unique").on(table.pushId, table.email),
  ]
);

export type SegmentPushMemberRow = typeof segmentPushMembers.$inferSelect;

/**
 * Google Search Console, the only source that answers "did anyone arrive".
 *
 * Every other feed answers what happened after they did, which is how a 62%
 * year-over-year traffic collapse stayed invisible to this system until a human
 * exported a CSV by hand.
 *
 * ## One table, not five
 *
 * Storing the cross-product of query × page × device × country × date would
 * explode and answer questions nobody asks. Search Console itself aggregates
 * each dimension separately, so this mirrors that: one row per day per
 * dimension per value, with `dimension = 'total'` carrying the daily headline.
 *
 * Measured against the live property: ~327 rows/day across all dimensions,
 * so the full 12-month backfill is ~119,000 rows.
 *
 * ## The retention clock
 *
 * The available window runs from 2025-09-14 and advances one day every day.
 * Anything that rolls off is gone at any price, by anyone, permanently — which
 * is why the backfill runs before the daily sync rather than after it.
 *
 * Data lags two to three days: on 2026-09-15 the latest available date was
 * 2026-09-13. An absent recent day is normal, not a broken sync.
 */
export const gscDaily = pgTable(
  "gsc_daily",
  {
    date: date("date", { mode: "string" }).notNull(),
    /** total | query | page | device | country */
    dimension: text("dimension").notNull(),
    /** The query text, URL, device or country code. Empty string for `total`. */
    value: text("value").notNull(),

    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    /** Stored as Search Console reports it — a rate, not a percentage. */
    ctr: real("ctr").notNull(),
    /** Average position. Lower is better; 1.0 is the top organic result. */
    position: real("position").notNull(),

    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gsc_daily_unique").on(table.date, table.dimension, table.value),
    index("gsc_daily_date_idx").on(table.date),
    index("gsc_daily_dimension_idx").on(table.dimension),
  ]
);

export type GscDailyRow = typeof gscDaily.$inferSelect;
export type NewGscDailyRow = typeof gscDaily.$inferInsert;

/**
 * Web sessions — "did anyone arrive", which no other feed answers.
 *
 * ## Why `source` is part of the key
 *
 * Shopify Analytics and GA4 disagree, and not slightly. Over the same 28 days:
 * Shopify reports 7,469 sessions with 70% direct; GA4 reports 4,614 with 42%
 * direct. Different session definitions, different consent handling, different
 * channel logic — the cause is not settled.
 *
 * Blending them would produce a number nobody can defend and would hide the
 * disagreement. Keeping `source` in the primary key means both are stored,
 * both are queryable, and the gap stays visible until someone explains it.
 *
 * Shopify is the historical source: 37 months back to September 2023, where
 * GA4's property was only created 2026-08-24 and cannot answer a
 * year-over-year question at all.
 */
export const webSessions = pgTable(
  "web_sessions",
  {
    date: date("date", { mode: "string" }).notNull(),
    /** shopify | ga4 — never blended, see above. */
    source: text("source").notNull(),
    /** total | referrer_source | referrer_name | landing_page */
    dimension: text("dimension").notNull(),
    /** The channel, referrer or path. Empty string for `total`. */
    value: text("value").notNull(),

    sessions: integer("sessions").notNull(),
    /** A rate as reported, not a percentage. Null where the source omits it. */
    conversionRate: real("conversion_rate"),

    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("web_sessions_unique").on(table.date, table.source, table.dimension, table.value),
    index("web_sessions_date_idx").on(table.date),
    index("web_sessions_dimension_idx").on(table.source, table.dimension),
  ]
);

export type WebSessionRow = typeof webSessions.$inferSelect;
export type NewWebSessionRow = typeof webSessions.$inferInsert;

/**
 * Effective-dated constants for the unit economics engine (#34).
 *
 * Dated rather than overwritten because a margin computed for March has to use
 * March's rates. Editing in place would silently restate history — the same
 * reason `recurring_costs` closes a row and opens a new one rather than
 * updating.
 *
 * Payment processing is modelled per transaction as `(amount x pct) + fixed`,
 * never as a flat percentage. The fixed fee dominates at low price points and
 * this business bills ~50,000 subscription orders averaging $6.56, so the
 * fixed half is larger than the percentage half on a product with otherwise
 * no COGS.
 */
export const rateSettings = pgTable(
  "rate_settings",
  {
    id: text("id").primaryKey(),
    /** payment_pct | payment_fixed_cents | free_shipping_threshold_cents */
    name: text("name").notNull(),
    /**
     * Stored as text so a rate (0.027) and a cent amount (30) share a column
     * without one being coerced into the other's units. The reader parses it
     * knowing which it asked for.
     */
    value: text("value").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    /** Null while current. Closing a row is how a rate changes. */
    effectiveTo: date("effective_to", { mode: "string" }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("rate_settings_name_idx").on(table.name, table.effectiveFrom),
  ]
);

export type RateSettingRow = typeof rateSettings.$inferSelect;

/**
 * The 3PL charge ledger, one row per charge (#34).
 *
 * The export is charge-grained, not shipment-grained: each row carries a
 * charge plus context from whichever entity produced it — a shipment, a
 * product, a storage bin, a return, the bill itself. Irrelevant blocks are
 * blank, so a storage row has no tracking number and a pick row has no bin.
 *
 * Stored at that grain deliberately. Splitting it into shipments, storage and
 * returns on import would mean a charge type nobody anticipated is dropped by
 * an importer that still reports success; kept whole, a new type arrives as
 * rows with an unfamiliar `fee` that a query can find.
 *
 * Note what the first live bill does NOT contain: any carrier postage.
 * `billed_label_cost_cents` and `reconciled_label_cost_cents` were empty on
 * all 201 rows while 162 carried tracking numbers, so the 3PL bills handling
 * and postage is paid somewhere else. Both columns exist because the export
 * declares them, and a future bill may populate them — but physical COD is not
 * complete from this table alone, and `threepl_charges` must never be read as
 * if it were the whole cost of delivery.
 */
export const threeplCharges = pgTable(
  "threepl_charges",
  {
    /** Deterministic over the bill and the row's content, so re-import is idempotent. */
    id: text("id").primaryKey(),

    billNumber: text("bill_number").notNull(),
    periodStart: date("period_start", { mode: "string" }),
    periodEnd: date("period_end", { mode: "string" }),

    chargeDate: date("charge_date", { mode: "string" }),
    /** storage | order | recurring | returns | ad_hoc — as the export spells it. */
    category: text("category"),
    /** The human label: INVENTORY STORAGE, STANDARD PICK FEE, API CONNECTION… */
    fee: text("fee"),
    /** The machine type: storing_by_location_charge, first_pick_charge… */
    type: text("type"),
    label: text("label"),
    description: text("description"),

    unitRateCents: integer("unit_rate_cents"),
    quantity: real("quantity"),
    /**
     * Null where the export gave no amount. Never coerced to 0 — a charge with
     * no recorded cost and a charge of zero need opposite handling (#91).
     */
    totalCents: integer("total_cents"),

    /** Resolved to `RH######`; joins `shopify_orders.order_number`. */
    orderNumber: text("order_number"),
    /** Which export column it came from. The first bill used `Order # (shipment)`. */
    orderNumberSource: text("order_number_source"),
    orderDate: date("order_date", { mode: "string" }),

    trackingNumber: text("tracking_number"),
    method: text("method"),
    box: text("box"),
    weight: real("weight"),
    country: text("country"),
    state: text("state"),
    city: text("city"),
    postalCode: text("postal_code"),
    unitsOrdered: real("units_ordered"),
    unitsShipped: real("units_shipped"),

    sku: text("sku"),
    productName: text("product_name"),
    binType: text("bin_type"),
    daysOccupied: real("days_occupied"),

    returnReason: text("return_reason"),
    unitsReceived: real("units_received"),
    unitsRestocked: real("units_restocked"),
    rmaCarrier: text("rma_carrier"),
    rmaMethod: text("rma_method"),
    rmaQuotedCostCents: integer("rma_quoted_cost_cents"),

    customerName: text("customer_name"),
    customerId: text("customer_id"),

    /** What the carrier quoted versus what it charged after reweighing. */
    billedLabelCostCents: integer("billed_label_cost_cents"),
    reconciledLabelCostCents: integer("reconciled_label_cost_cents"),

    /** Columns the parser does not map, kept rather than dropped. */
    extra: jsonb("extra"),
    /** The whole row, for audit. Carries recipient name and address. */
    raw: jsonb("raw"),

    sourceFile: text("source_file"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("threepl_charges_bill_idx").on(table.billNumber),
    index("threepl_charges_order_idx").on(table.orderNumber),
    index("threepl_charges_date_idx").on(table.chargeDate),
    index("threepl_charges_sku_idx").on(table.sku),
    index("threepl_charges_category_idx").on(table.category),
  ]
);

export type ThreeplChargeDbRow = typeof threeplCharges.$inferSelect;
export type NewThreeplChargeDbRow = typeof threeplCharges.$inferInsert;

/**
 * Fixed overhead — software and subscriptions that do not vary with orders.
 *
 * Kept out of Cost of Delivery on purpose. COD is a per-order variable cost,
 * and folding a fixed fee into it makes COD% a function of volume: a slow
 * month would report a higher cost of delivery for no operational reason, and
 * since break-even aMER is 1/(1-COD%) that error lands straight in every
 * target CPA.
 *
 * The first row is the 3PL's own `API CONNECTION` line at $125 a period, which
 * arrives inside the charge export rather than from a separate list — so a
 * recurring cost can be discovered by the importer, not only entered by hand.
 *
 * Effective-dated the way `rate_settings` is: a change closes the open row and
 * opens a new one, because a margin computed for March has to use March's
 * costs and editing in place would silently restate history.
 */
export const recurringCosts = pgTable(
  "recurring_costs",
  {
    id: text("id").primaryKey(),
    /** What it is: "API CONNECTION", "Shopify Plus", "Klaviyo". */
    name: text("name").notNull(),
    vendor: text("vendor"),
    amountCents: integer("amount_cents").notNull(),
    /** monthly | annual | per_bill_period — never normalised on write. */
    cadence: text("cadence").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    /** Null while current. Closing a row is how a cost changes. */
    effectiveTo: date("effective_to", { mode: "string" }),
    /**
     * threepl | manual. A cost the importer found and one a human typed need
     * different trust, and a single column that means both is how a stale
     * hand-entered figure outlives the thing it described.
     */
    source: text("source").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("recurring_costs_name_idx").on(table.name, table.effectiveFrom),
    index("recurring_costs_open_idx").on(table.effectiveTo),
  ]
);

export type RecurringCostRow = typeof recurringCosts.$inferSelect;
export type NewRecurringCostRow = typeof recurringCosts.$inferInsert;

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

export type SealTierChangeEvent = typeof sealTierChangeEvents.$inferSelect;
export type QueryLogRow = typeof queryLog.$inferSelect;
