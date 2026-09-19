CREATE TABLE "env_checks" (
	"surface" text PRIMARY KEY NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"variables" jsonb NOT NULL,
	"missing_required" integer DEFAULT 0 NOT NULL,
	"missing_degraded" integer DEFAULT 0 NOT NULL
);
