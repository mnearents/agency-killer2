CREATE TABLE "rate_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_settings_name_idx" ON "rate_settings" USING btree ("name","effective_from");
-- The confirmed rates from #34. Seeded here rather than in code because they
-- are data with a date, not constants: when a processor rate changes, the old
-- row is closed and a new one opened, and March's margin keeps March's rate.
--
-- effective_from is the start of the order history we hold. Nothing earlier
-- can be computed anyway.
INSERT INTO "rate_settings" ("id", "name", "value", "effective_from", "notes") VALUES
  ('payment_pct_2025_07',   'payment_pct',                    '0.027', DATE '2025-07-22',
   'Shopify Payments percentage. Applied per transaction, never to a total.'),
  ('payment_fixed_2025_07', 'payment_fixed_cents',            '30',    DATE '2025-07-22',
   'Per-transaction fixed fee. Dominates at low price points: 8.7% effective on a $5 Spark, 2.9% on a $144 Studio annual.'),
  ('free_ship_2025_07',     'free_shipping_threshold_cents',  '6000',  DATE '2025-07-22',
   'Free shipping over $60. Not special-cased in the margin: labels are always a cost and shipping collected is always revenue.')
ON CONFLICT ("id") DO NOTHING;
