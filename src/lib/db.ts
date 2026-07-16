/**
 * Shared database instance for the Next.js web app.
 * Server Components import this to query data directly.
 */

import { createDb } from "@/db/client";

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL not set");
  }
  return createDb(url);
}

// Singleton — reuse across requests in the same process
let _db: ReturnType<typeof getDb> | null = null;

export function db() {
  if (!_db) {
    _db = getDb();
  }
  return _db;
}
