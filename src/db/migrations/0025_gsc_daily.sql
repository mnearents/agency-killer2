CREATE TABLE "gsc_daily" (
	"date" date NOT NULL,
	"dimension" text NOT NULL,
	"value" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" real NOT NULL,
	"position" real NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_daily_unique" ON "gsc_daily" USING btree ("date","dimension","value");--> statement-breakpoint
CREATE INDEX "gsc_daily_date_idx" ON "gsc_daily" USING btree ("date");--> statement-breakpoint
CREATE INDEX "gsc_daily_dimension_idx" ON "gsc_daily" USING btree ("dimension");