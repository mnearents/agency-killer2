/**
 * Database client — creates a Drizzle ORM instance connected to Postgres.
 * In tests, use createTestDb() or mock the queries directly.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl);
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
