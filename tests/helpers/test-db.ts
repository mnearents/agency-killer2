/**
 * A real Postgres, in process (PGlite), built by running every migration in
 * src/db/migrations in order — so a test reads and writes the schema
 * production has, and a migration that does not run fails here first.
 *
 * Guarantees that are about which rows a WHERE clause reaches, or about a
 * row written and then read back, cannot be shown with a fake that ignores
 * filters. Use this for those.
 *
 * `embedding` is text here: PGlite has no pgvector, and Drizzle sends a vector
 * as its "[...]" string, which text stores and returns unchanged.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";

const MIGRATIONS = join(__dirname, "../../src/db/migrations");

export async function createTestDb(): Promise<{ db: Db; client: PGlite; truncate: (...tables: string[]) => Promise<unknown> }> {
  const client = new PGlite();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8").replaceAll("--> statement-breakpoint", "").replace(/vector\(1536\)/g, "text");
    await client.exec(sql);
  }
  return {
    db: drizzle(client, { schema }) as unknown as Db,
    client,
    truncate: (...tables) => client.exec(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY`),
  };
}
