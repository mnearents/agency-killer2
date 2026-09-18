CREATE TABLE "attentive_campaign_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"campaign" text NOT NULL,
	"message" text NOT NULL,
	"message_variant" text DEFAULT '' NOT NULL,
	"channel" text NOT NULL,
	"has_media" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"email_sends" integer DEFAULT 0 NOT NULL,
	"email_unique_opens" integer DEFAULT 0 NOT NULL,
	"email_unique_clicks" integer DEFAULT 0 NOT NULL,
	"total_clicks" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"avg_order_value_cents" integer,
	"unsubscribes" integer DEFAULT 0 NOT NULL,
	"email_hard_bounces" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attentive_campaign_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"message" text NOT NULL,
	"segment" text NOT NULL,
	"channel" text NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"total_clicks" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"unsubscribes" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attentive_journey_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"journey_name" text NOT NULL,
	"trigger_name" text DEFAULT '' NOT NULL,
	"message" text NOT NULL,
	"channel" text NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"total_clicks" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"revenue_cents" integer DEFAULT 0 NOT NULL,
	"avg_order_value_cents" integer,
	"unsubscribes" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attentive_message_costs" (
	"id" text PRIMARY KEY NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"campaign_cost_cents" integer DEFAULT 0 NOT NULL,
	"automated_send_cost_cents" integer DEFAULT 0 NOT NULL,
	"received_cost_cents" integer DEFAULT 0 NOT NULL,
	"carrier_fees_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "attentive_campaign_messages_date_idx" ON "attentive_campaign_messages" USING btree ("date");--> statement-breakpoint
CREATE INDEX "attentive_campaign_messages_campaign_idx" ON "attentive_campaign_messages" USING btree ("campaign");--> statement-breakpoint
CREATE UNIQUE INDEX "attentive_campaign_messages_dedup_idx" ON "attentive_campaign_messages" USING btree ("date","campaign","message","channel");--> statement-breakpoint
CREATE INDEX "attentive_campaign_segments_date_idx" ON "attentive_campaign_segments" USING btree ("date");--> statement-breakpoint
CREATE INDEX "attentive_campaign_segments_segment_idx" ON "attentive_campaign_segments" USING btree ("segment");--> statement-breakpoint
CREATE UNIQUE INDEX "attentive_campaign_segments_dedup_idx" ON "attentive_campaign_segments" USING btree ("date","message","segment","channel");--> statement-breakpoint
CREATE INDEX "attentive_journey_messages_date_idx" ON "attentive_journey_messages" USING btree ("date");--> statement-breakpoint
CREATE INDEX "attentive_journey_messages_journey_idx" ON "attentive_journey_messages" USING btree ("journey_name");--> statement-breakpoint
CREATE UNIQUE INDEX "attentive_journey_messages_dedup_idx" ON "attentive_journey_messages" USING btree ("date","journey_name","message","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "attentive_message_costs_dedup_idx" ON "attentive_message_costs" USING btree ("date");