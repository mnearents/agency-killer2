/**
 * Programmatic migration runner — runs Drizzle migrations against
 * the DATABASE_URL. Used by the pre-deploy command on Railway.
 *
 * This avoids depending on drizzle-kit (dev dependency) in production.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[migrate] DATABASE_URL not set — skipping migrations");
    process.exit(0); // Don't fail the deploy if DB isn't configured yet
  }

  console.log("[migrate] Running migrations...");

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  try {
    // Enable pgvector extension before running migrations
    await client`CREATE EXTENSION IF NOT EXISTS vector`;
    console.log("[migrate] pgvector extension enabled");

    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    console.log("[migrate] Migrations complete.");
  } catch (err) {
    console.error("[migrate] Migration failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
