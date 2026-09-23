CREATE TABLE "shopify_redirects" (
	"from_handle" text PRIMARY KEY NOT NULL,
	"to_handle" text,
	"status_code" integer NOT NULL,
	"final_url" text,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "shopify_redirects_to_idx" ON "shopify_redirects" USING btree ("to_handle");