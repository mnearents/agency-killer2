CREATE TABLE "threepl_shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_number" text,
	"order_date" date,
	"created_at_date" date,
	"carrier" text,
	"shipping_method" text,
	"tracking_number" text,
	"weight_lb" real,
	"shipping_charged_cents" integer,
	"label_cost_cents" integer,
	"postage_basis" text NOT NULL,
	"state" text,
	"country" text,
	"raw" jsonb,
	"source_file" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "threepl_shipments_order_idx" ON "threepl_shipments" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "threepl_shipments_created_idx" ON "threepl_shipments" USING btree ("created_at_date");--> statement-breakpoint
CREATE INDEX "threepl_shipments_basis_idx" ON "threepl_shipments" USING btree ("postage_basis");--> statement-breakpoint
CREATE INDEX "threepl_shipments_method_idx" ON "threepl_shipments" USING btree ("shipping_method");