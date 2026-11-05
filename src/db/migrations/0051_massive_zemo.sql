CREATE TABLE "fulfilment_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"invoice_number" text NOT NULL,
	"issued" date,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"period_inferred" integer DEFAULT 0 NOT NULL,
	"category" text NOT NULL,
	"carrier" text,
	"shipments" integer,
	"amount_cents" integer NOT NULL,
	"source_file" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "fulfilment_invoices_period_idx" ON "fulfilment_invoices" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "fulfilment_invoices_invoice_idx" ON "fulfilment_invoices" USING btree ("source","invoice_number");--> statement-breakpoint
-- The 3PL's API fee is billed every 28 days, on every other fortnightly bill
-- (720698 on 09/04, 741600 on 10/06, 762890 on 11/03). It was recorded as
-- per_bill_period, which normalised to 26 charges a year: $270.83/month.
-- Every 28 days is $135.79/month. A correction of how it was recorded, not a
-- change in the cost, so the open row is corrected in place.
UPDATE "recurring_costs"
SET "cadence" = 'every_28_days',
    "notes" = coalesce("notes" || ' ', '') || 'Cadence corrected 2026-11-05: billed every 28 days (every other fortnightly bill), not every bill.'
WHERE "name" = 'API CONNECTION' AND "cadence" = 'per_bill_period' AND "effective_to" IS NULL;
