CREATE TABLE "recurring_costs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"vendor" text,
	"amount_cents" integer NOT NULL,
	"cadence" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threepl_charges" (
	"id" text PRIMARY KEY NOT NULL,
	"bill_number" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"charge_date" date,
	"category" text,
	"fee" text,
	"type" text,
	"label" text,
	"description" text,
	"unit_rate_cents" integer,
	"quantity" real,
	"total_cents" integer,
	"order_number" text,
	"order_number_source" text,
	"order_date" date,
	"tracking_number" text,
	"method" text,
	"box" text,
	"weight" real,
	"country" text,
	"state" text,
	"city" text,
	"postal_code" text,
	"units_ordered" real,
	"units_shipped" real,
	"sku" text,
	"product_name" text,
	"bin_type" text,
	"days_occupied" real,
	"return_reason" text,
	"units_received" real,
	"units_restocked" real,
	"rma_carrier" text,
	"rma_method" text,
	"rma_quoted_cost_cents" integer,
	"customer_name" text,
	"customer_id" text,
	"billed_label_cost_cents" integer,
	"reconciled_label_cost_cents" integer,
	"extra" jsonb,
	"raw" jsonb,
	"source_file" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recurring_costs_name_idx" ON "recurring_costs" USING btree ("name","effective_from");--> statement-breakpoint
CREATE INDEX "recurring_costs_open_idx" ON "recurring_costs" USING btree ("effective_to");--> statement-breakpoint
CREATE INDEX "threepl_charges_bill_idx" ON "threepl_charges" USING btree ("bill_number");--> statement-breakpoint
CREATE INDEX "threepl_charges_order_idx" ON "threepl_charges" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "threepl_charges_date_idx" ON "threepl_charges" USING btree ("charge_date");--> statement-breakpoint
CREATE INDEX "threepl_charges_sku_idx" ON "threepl_charges" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "threepl_charges_category_idx" ON "threepl_charges" USING btree ("category");