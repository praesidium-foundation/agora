-- ============================================================================
-- Migration 006: Default privileges for the authenticated role
--
-- Resolves a recurring class of bug: tables created in migrations after 001
-- did not inherit the global GRANT issued in 001, producing "permission
-- denied for table" errors at the Postgres base-grant layer (before RLS
-- could even evaluate). Migration 004 hit this in production; Migration 005
-- worked around it with a per-table grant. Future migrations should not
-- need to think about it.
--
-- This migration sets default privileges so any future table, sequence, or
-- function created in the public schema by the current role (postgres, the
-- role that runs Supabase migrations) automatically grants the appropriate
-- privileges to the authenticated role. RLS continues to gate row-level
-- access on tables that enable it.
--
-- Notes on Supabase environment:
-- - Supabase migrations run as the `postgres` role. The defaults set here
--   apply to objects created by postgres, which covers every migration.
-- - An earlier draft of this migration also issued `ALTER DEFAULT PRIVILEGES
--   FOR ROLE supabase_admin ...` but newer Supabase projects do not allow
--   the postgres role to alter another role's default privileges (error
--   42501: permission denied to change default privileges). Dropping those
--   lines does not weaken the protection because migrations always run as
--   postgres in Supabase.
-- ============================================================================

-- ---- Default privileges for future objects -------------------------------
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

alter default privileges in schema public
  grant usage, select on sequences to authenticated;

alter default privileges in schema public
  grant execute on functions to authenticated;

-- ---- Catch-up: re-issue grants on existing public objects ---------------
-- Idempotent. Catches any table or function created between migrations 001
-- and 006 that may have slipped through without an explicit grant.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- ============================================================================
-- END OF MIGRATION 006
-- ============================================================================
