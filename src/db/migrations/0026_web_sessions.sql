CREATE TABLE "web_sessions" (
	"date" date NOT NULL,
	"source" text NOT NULL,
	"dimension" text NOT NULL,
	"value" text NOT NULL,
	"sessions" integer NOT NULL,
	"conversion_rate" real,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "web_sessions_unique" ON "web_sessions" USING btree ("date","source","dimension","value");--> statement-breakpoint
CREATE INDEX "web_sessions_date_idx" ON "web_sessions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "web_sessions_dimension_idx" ON "web_sessions" USING btree ("source","dimension");