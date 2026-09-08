-- What each process found in its own environment when it last started.
--
-- A process can only read its own environment. The three variables that have
-- shipped unset in production (SEAL_API_TOKEN, META_AD_ACCOUNT_ID,
-- ANALYTICS_DATABASE_URL) were all invisible for exactly that reason: the
-- worker knew, and nothing the worker knew reached anyone looking. This table
-- is the channel between them.
--
-- One row per surface, overwritten each check. `checked_at` doubles as a
-- liveness signal — the worker rewrites it daily, so a row that stops
-- advancing means the process stopped running.
--
-- Names only. No environment variable value is ever written here, because this
-- table is read back through an MCP tool.
--
-- NOTE ON ORDERING: 0016 (order line items) and 0017 (customers and segments)
-- are on unmerged branches. This migration touches nothing they touch, but the
-- numbering assumes they land first.
CREATE TABLE IF NOT EXISTS "env_checks" (
  "surface" text PRIMARY KEY NOT NULL,
  "checked_at" timestamp with time zone NOT NULL,
  "ok" integer NOT NULL,
  "expected" integer NOT NULL,
  "missing_required" jsonb NOT NULL,
  "missing_degraded" jsonb NOT NULL
);

COMMENT ON TABLE "env_checks" IS
  'Per-process environment variable presence, written at startup and daily. Names only, never values. A surface with no row here is UNKNOWN, not healthy.';
