ALTER TABLE "seal_subscriptions" ADD COLUMN "log" jsonb;--> statement-breakpoint
ALTER TABLE "seal_subscriptions" ADD COLUMN "tags" jsonb;--> statement-breakpoint
ALTER TABLE "seal_subscriptions" ADD COLUMN "detail_checked_at" timestamp with time zone;