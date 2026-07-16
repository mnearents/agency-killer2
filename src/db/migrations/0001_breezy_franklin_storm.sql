CREATE TABLE "blog_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"article_html" text NOT NULL,
	"shopify_draft_url" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blog_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"target_date" timestamp with time zone,
	"priority" integer DEFAULT 5 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tags" jsonb,
	"repeat_yearly" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blog_generations" ADD CONSTRAINT "blog_generations_topic_id_blog_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."blog_topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blog_generations_topic_idx" ON "blog_generations" USING btree ("topic_id");