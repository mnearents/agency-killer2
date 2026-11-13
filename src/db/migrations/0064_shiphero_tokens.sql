CREATE TABLE "shiphero_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"obtained_at" timestamp with time zone NOT NULL,
	"refreshed_at" timestamp with time zone
);
