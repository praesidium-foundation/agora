-- ============================================================================
-- Migration 017: Add approve_unlock permission and grant to Libertas user
--
-- Phase 2 Session H1, Part B. Extends the hierarchical permission_level
-- enum with a new value `approve_unlock`, inserted between `approve_lock`
-- and `admin`. Then grants `approve_unlock` on the Budget module to the
-- sole live user whose email is jennsalazar@hotmail.com.
--
-- WHY HIERARCHICAL VS DISTINCT?
-- The schema's permission_level type (Migration 001) is an ordered enum,
-- and `current_user_has_module_perm` checks the caller's level with `>=`.
-- "Distinct from approve_lock" in this model means a separate enum value
-- positioned in the hierarchy such that approve_lock holders do NOT
-- automatically pass an `approve_unlock` check. Inserting between
-- approve_lock and admin satisfies that:
--
--   view < edit < submit_lock < approve_lock < approve_unlock < admin
--
--   - `approve_lock` users do NOT auto-get `approve_unlock` ✓
--   - `admin` users DO auto-get `approve_unlock` (admin subsumes everything,
--     consistent with the rest of the system) ✓
--   - Users explicitly granted `approve_unlock` get it ✓
--   - Users with `approve_unlock` also implicitly hold `approve_lock`,
--     `submit_lock`, `edit`, `view` (subsumption) — consistent with how
--     every other permission in this schema behaves ✓
--
-- The alternative — fragmenting the permission system to support truly
-- distinct permissions per user per module — was deliberately not pursued
-- in this session. See architecture §8.13 for the discussion.
--
-- ============================================================================
-- IMPORTANT — APPLY IN TWO STAGES IN THE SUPABASE SQL EDITOR
-- ============================================================================
-- PostgreSQL forbids referencing a newly-added enum value within the SAME
-- transaction that added it (the value isn't visible until the ALTER TYPE
-- transaction commits). Multi-statement queries in the Supabase SQL Editor
-- run as a single implicit transaction, so the ALTER TYPE and the
-- INSERT/UPDATE that uses the new value MUST be run in two separate
-- "Run" presses.
--
-- Step 1: copy and paste PART A below; click Run; wait for "Success".
-- Step 2: copy and paste PART B below; click Run.
--
-- If applied via psql or Supabase CLI, the explicit COMMIT between the
-- two parts achieves the same separation automatically.
-- ============================================================================


-- ============================================================================
-- PART A — Extend the permission_level enum.
-- Run this first; ensure the editor reports success before running Part B.
-- ============================================================================

alter type permission_level add value if not exists 'approve_unlock' before 'admin';


-- ============================================================================
-- PART B — Grant approve_unlock on the Budget module to the live user.
-- Run this AFTER Part A has committed.
-- ============================================================================

-- Idempotent grant. Behavior on the three possible existing states for
-- this user × module:
--
--   1. No row exists  → INSERT fires; fresh approve_unlock grant.
--   2. Row exists with permission_level < approve_unlock (e.g. submit_lock,
--      approve_lock) → ON CONFLICT WHERE matches; permission ELEVATED to
--      approve_unlock. granted_at refreshed.
--   3. Row exists with permission_level >= approve_unlock (e.g. already
--      approve_unlock, or admin) → ON CONFLICT WHERE filters out the
--      conflict; row is left untouched. We never DEMOTE an admin user
--      to approve_unlock as a side effect of running this migration.
--
-- The migration is also safe to re-run — repeated invocations are no-ops
-- once the user is at approve_unlock or above.

insert into user_module_permissions (user_id, module_id, permission_level, granted_at)
select u.id, m.id, 'approve_unlock'::permission_level, now()
  from auth.users u
  cross join modules m
 where u.email = 'jennsalazar@hotmail.com'
   and m.code = 'budget'
on conflict (user_id, module_id) do update
  set permission_level = 'approve_unlock'::permission_level,
      granted_at = now()
  where user_module_permissions.permission_level < 'approve_unlock'::permission_level;

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 017
-- ============================================================================
