CREATE TABLE "seal_subscription_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_date" text NOT NULL,
	"subscription_id" text NOT NULL,
	"status" text NOT NULL,
	"tier" text NOT NULL,
	"pricing_cohort" text NOT NULL,
	"billing_interval" text NOT NULL,
	"billing_cadence" text NOT NULL,
	"price_cents" bigint,
	"in_dunning" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seal_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"shopify_order_id" text,
	"manual_origin" integer DEFAULT 0 NOT NULL,
	"email" text,
	"status" text NOT NULL,
	"tier" text NOT NULL,
	"pricing_cohort" text NOT NULL,
	"variant_id" text,
	"product_id" text,
	"variant_sku" text,
	"product_title" text,
	"selling_plan_id" text,
	"selling_plan_name" text,
	"plan_conflict" integer DEFAULT 0 NOT NULL,
	"price_cents" bigint,
	"price_anomaly" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"billing_interval" text NOT NULL,
	"billing_cadence" text NOT NULL,
	"order_placed" timestamp with time zone,
	"next_billing_date" timestamp with time zone,
	"cancelled_on" timestamp with time zone,
	"cancellation_reason" text,
	"in_dunning" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"last_error_at" timestamp with time zone,
	"raw_json" jsonb,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "seal_snapshots_date_idx" ON "seal_subscription_snapshots" USING btree ("snapshot_date");--> statement-breakpoint
CREATE INDEX "seal_snapshots_subscription_idx" ON "seal_subscription_snapshots" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seal_snapshots_date_sub_idx" ON "seal_subscription_snapshots" USING btree ("snapshot_date","subscription_id");--> statement-breakpoint
CREATE INDEX "seal_subscriptions_status_idx" ON "seal_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "seal_subscriptions_tier_idx" ON "seal_subscriptions" USING btree ("tier","pricing_cohort");--> statement-breakpoint
CREATE INDEX "seal_subscriptions_dunning_idx" ON "seal_subscriptions" USING btree ("in_dunning");--> statement-breakpoint
CREATE INDEX "seal_subscriptions_shopify_order_idx" ON "seal_subscriptions" USING btree ("shopify_order_id");--> statement-breakpoint
CREATE INDEX "seal_subscriptions_next_billing_idx" ON "seal_subscriptions" USING btree ("next_billing_date");