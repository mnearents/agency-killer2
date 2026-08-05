CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"cookies_json" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
