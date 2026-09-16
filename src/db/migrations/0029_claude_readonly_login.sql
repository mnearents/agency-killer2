-- The migration said NOLOGIN; production has LOGIN. (#36)
--
-- 0015 created the role to own grants, which is why NOLOGIN was right at the
-- time. The `query` tool arrived later and needs to connect as it, so the role
-- was granted LOGIN and a password by hand. That decision never made it back
-- into a migration, so the file that is supposed to define the security
-- boundary describes a role nothing can connect to.
--
-- The cost is not on production, which is already correct. It is on any
-- environment rebuilt from migrations — a restore, a staging database, a new
-- Railway Postgres — where the query tool would be unusable and the reason
-- would take a while to find.
--
-- Idempotent: ALTER ROLE ... LOGIN on a role that already has it is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_readonly') THEN
    -- Matches 0015's shape for a fresh database, but with the attribute the
    -- role actually needs rather than the one it needed two migrations ago.
    CREATE ROLE claude_readonly LOGIN;
  ELSE
    ALTER ROLE claude_readonly LOGIN;
  END IF;
END
$$;

-- A password cannot live in a migration, so a rebuilt environment gets a role
-- that can log in and has nothing to log in WITH. Say so at migration time
-- rather than leaving it to be discovered through an auth error weeks later.
--
-- This is a WARNING and not an exception on purpose: a fresh environment is
-- allowed to come up without the query tool, and refusing to migrate over it
-- would block every other table for the sake of one optional surface.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_authid WHERE rolname = 'claude_readonly' AND rolpassword IS NOT NULL
  ) THEN
    RAISE WARNING 'claude_readonly has no password. The MCP query tool cannot connect until one is set: ALTER ROLE claude_readonly PASSWORD ''...''; then put it in ANALYTICS_DATABASE_URL. It is deliberately not in any migration.';
  END IF;
END
$$;
