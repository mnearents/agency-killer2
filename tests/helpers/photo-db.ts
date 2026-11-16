/**
 * A real Postgres, in process (PGlite), holding the tables the photo index
 * touches: `photos` from its own migration, and `kb_documents` and
 * `shopify_products` as their migrations made them. The photo sync's
 * guarantees — a correction survives, an unchanged file is not read again —
 * are about which rows a WHERE clause reaches, which a fake cannot evaluate.
 *
 * `embedding` is text here: PGlite has no pgvector, and Drizzle sends a vector
 * as its "[...]" string, which text stores and returns unchanged.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";

const MIGRATION = join(__dirname, "../../src/db/migrations/0065_photos.sql");

export async function createPhotoDb(): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite();
  await client.exec(`
    CREATE TABLE "kb_documents" (
      "id" text PRIMARY KEY NOT NULL,
      "title" text NOT NULL,
      "content" text NOT NULL,
      "category" text NOT NULL,
      "subcategory" text,
      "source_file" text,
      "content_hash" text NOT NULL,
      "chunk_index" integer DEFAULT 0 NOT NULL,
      "total_chunks" integer DEFAULT 1 NOT NULL,
      "context_prefix" text NOT NULL,
      "document_date" timestamp with time zone,
      "embedding" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "shopify_products" (
      "id" text PRIMARY KEY NOT NULL,
      "title" text NOT NULL,
      "handle" text NOT NULL,
      "status" text NOT NULL,
      "product_type" text,
      "vendor" text,
      "tags" jsonb,
      "description_html" text,
      "seo_title" text,
      "seo_description" text,
      "metafields" jsonb,
      "product_updated_at" timestamp with time zone,
      "synced_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  await client.exec(readFileSync(MIGRATION, "utf8").replaceAll("--> statement-breakpoint", ""));
  return { db: drizzle(client, { schema }) as unknown as Db, client };
}
