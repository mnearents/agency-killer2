CREATE TABLE "footage" (
	"path" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"rev" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"transcription_status" text,
	"transcription_attempts" integer DEFAULT 0 NOT NULL,
	"transcription_attempted_at" timestamp with time zone,
	"transcription_detail" text,
	"tags" jsonb,
	"summary" text,
	"tagged_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "footage_status_idx" ON "footage" USING btree ("transcription_status");--> statement-breakpoint
CREATE INDEX "footage_name_idx" ON "footage" USING btree ("name");