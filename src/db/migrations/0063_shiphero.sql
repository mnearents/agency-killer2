CREATE TABLE "shiphero_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"shipment_id" text NOT NULL,
	"carrier" text,
	"shipping_method" text,
	"shipping_name" text,
	"carrier_account_id" text,
	"cost_cents" integer,
	"cost_basis" text NOT NULL,
	"status" text,
	"refunded" integer,
	"box_name" text,
	"package_number" integer,
	"weight_lb" real,
	"length_in" real,
	"width_in" real,
	"height_in" real,
	"source" text,
	"created_date" timestamp with time zone,
	"synced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shiphero_shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"legacy_id" bigint,
	"order_number" text,
	"partner_order_id" text,
	"shopify_order_id" text,
	"shop_name" text,
	"order_source" text,
	"created_date" timestamp with time zone,
	"total_packages" integer,
	"shipped_off_shiphero" integer,
	"dropshipment" integer,
	"refunded" integer,
	"shipping_line_title" text,
	"shipping_line_carrier" text,
	"shipping_line_method" text,
	"shipping_charged_cents" integer,
	"synced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "shiphero_labels_shipment_idx" ON "shiphero_labels" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shiphero_labels_created_idx" ON "shiphero_labels" USING btree ("created_date");--> statement-breakpoint
CREATE INDEX "shiphero_shipments_order_idx" ON "shiphero_shipments" USING btree ("shopify_order_id");--> statement-breakpoint
CREATE INDEX "shiphero_shipments_number_idx" ON "shiphero_shipments" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "shiphero_shipments_created_idx" ON "shiphero_shipments" USING btree ("created_date");--> statement-breakpoint
-- Read from ShipHero's Public API by `sync:shiphero`, daily over the last 7
-- days and backfilled from 2025-07-22. Per-label postage, where the
-- hand-imported shipment export stops at 2026-09-21 and the invoices give
-- only weekly totals.
--
-- No customer field exists in either table: the API token can see names,
-- addresses and emails, and the sync does not select them.
CREATE VIEW analytics.shiphero_shipments AS
SELECT
  s.id,
  s.legacy_id,
  s.order_number,
  s.partner_order_id,
  -- Joins analytics.shopify_orders.id. NULL when ShipHero's partner_order_id
  -- is not a Shopify order id (a manual order, say).
  s.shopify_order_id,
  s.shop_name,
  s.order_source,
  s.created_date,
  s.total_packages,
  s.shipped_off_shiphero,
  s.dropshipment,
  s.refunded,
  s.shipping_line_title,
  s.shipping_line_carrier,
  s.shipping_line_method,
  -- ShipHero's copy of what the customer paid for shipping. Order money is
  -- Shopify's: ShipHero's order subtotal is not (RH361008: 176.00 there,
  -- 132.00 in Shopify), so compare before trusting this one.
  s.shipping_charged_cents,
  s.synced_at
FROM public.shiphero_shipments s;
--> statement-breakpoint
COMMENT ON VIEW analytics.shiphero_shipments IS
  'One row per ShipHero shipment. An order can have several; join to shopify_orders on shopify_order_id. '
  'Customer details are deliberately absent. shipping_charged_cents is ShipHero''s figure, not Shopify''s.';
--> statement-breakpoint
CREATE VIEW analytics.shiphero_labels AS
SELECT
  l.id,
  l.shipment_id,
  l.carrier,
  l.shipping_method,
  l.shipping_name,
  l.carrier_account_id,
  -- NULL means UNKNOWN, never free. ShipHero reports 0.00 for a label billed
  -- to a carrier account the 3PL does not invoice — every DHL eCommerce label
  -- seen — and summing those as zero would understate postage by every such
  -- shipment while the total still looked whole. cost_basis says which:
  -- reported, zero-reported (0.00 in ShipHero) or absent.
  l.cost_cents,
  l.cost_basis,
  -- Only 'valid' had been seen when this was written. An order's postage
  -- counts valid, unrefunded labels; any other status is excluded and should
  -- be looked at, not assumed to be a void.
  l.status,
  l.refunded,
  l.box_name,
  l.package_number,
  -- Parsed from strings that carry their unit ("3.6500 lb"). NULL where the
  -- unit was not recognised — not assumed to be pounds or inches.
  l.weight_lb,
  l.length_in,
  l.width_in,
  l.height_in,
  l.source,
  l.created_date,
  l.synced_at
FROM public.shiphero_labels l;
--> statement-breakpoint
COMMENT ON VIEW analytics.shiphero_labels IS
  'One row per ShipHero shipping label. cost_cents NULL is unknown, not free: never sum it without '
  'reporting what share is known. An order''s postage is its valid, unrefunded labels.';
--> statement-breakpoint
GRANT SELECT ON analytics.shiphero_shipments TO claude_readonly;
--> statement-breakpoint
GRANT SELECT ON analytics.shiphero_labels TO claude_readonly;
