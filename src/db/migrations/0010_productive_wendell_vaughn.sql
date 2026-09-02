ALTER TABLE "seal_subscriptions" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "seal_subscriptions" ADD COLUMN "customer_id_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "seal_subscriptions_customer_idx" ON "seal_subscriptions" USING btree ("customer_id");