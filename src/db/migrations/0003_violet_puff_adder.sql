CREATE TABLE "attentive_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"message_variant" text NOT NULL,
	"has_media" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"total_clicks" integer DEFAULT 0 NOT NULL,
	"total_click_rate" real,
	"conversions" integer DEFAULT 0 NOT NULL,
	"conversion_rate" real,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"unsubscribes" integer DEFAULT 0 NOT NULL,
	"unsubscribe_rate" real,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attentive_revenue" (
	"id" text PRIMARY KEY NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"avg_order_value_cents" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "attentive_campaigns_date_idx" ON "attentive_campaigns" USING btree ("date");--> statement-breakpoint
CREATE INDEX "attentive_campaigns_variant_idx" ON "attentive_campaigns" USING btree ("message_variant");--> statement-breakpoint
CREATE UNIQUE INDEX "attentive_campaigns_dedup_idx" ON "attentive_campaigns" USING btree ("date","message_variant");--> statement-breakpoint
CREATE INDEX "attentive_revenue_date_idx" ON "attentive_revenue" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "attentive_revenue_dedup_idx" ON "attentive_revenue" USING btree ("date");