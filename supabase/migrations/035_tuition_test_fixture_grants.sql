-- ============================================================================
-- Migration 035: Tuition test fixture grants for synthetic user (v3.8.13)
--
-- The Agora codebase relies on a synthetic test user — treasurer.test@
-- libertas.local — as a recurring fixture for testing two-identity
-- workflows. Created during Phase 2 Budget testing, the user holds
-- approve_unlock permissions across Planning modules so that lock and
-- unlock workflows requiring two distinct identities can be exercised
-- end-to-end without coordinating two human testers.
--
-- This migration grants the user the appropriate Tuition module
-- permission to enable Tuition unlock-cycle testing. It also defensively
-- restores the Budget module grant (also at approve_unlock) in case the
-- original Phase 2 SQL Editor grant was lost — the migration is a no-op
-- if the row already exists at approve_unlock or higher.
--
-- ============================================================================
-- ON THE HIERARCHICAL PERMISSION MODEL
-- ============================================================================
--
-- The schema's permission_level type is an ordered enum (Migration 001 +
-- Migration 017):
--
--   view < edit < submit_lock < approve_lock < approve_unlock < admin
--
-- The unique (user_id, module_id) constraint means each user holds at
-- most ONE row per module; that row's level is the floor, and
-- subsumption gives the user every lower level for free. Granting
-- approve_unlock therefore implicitly grants view, edit, submit_lock,
-- and approve_lock.
--
-- The ideal fixture grant would be "view + submit_lock + approve_unlock
-- WITHOUT edit" — view to navigate, submit_lock to exercise the
-- submit-direction flow, approve_unlock to act as second approver, and
-- not edit because the synthetic user is for workflow testing not data
-- entry. The schema does not support that combination directly. The
-- pragmatic resolution: grant approve_unlock (which subsumes edit) and
-- rely on the testing convention "do not use the synthetic user for
-- data entry" rather than schema enforcement. The convention is
-- documented in agora_architecture.md §9.
--
-- ============================================================================
-- IDEMPOTENCY
-- ============================================================================
--
-- INSERT ... ON CONFLICT DO UPDATE WHERE existing_level < approve_unlock.
-- Behavior on the three possible existing states:
--
--   1. No row exists       → INSERT fires; fresh approve_unlock grant.
--   2. Row at lower level  → ON CONFLICT WHERE matches; ELEVATED.
--   3. Row at >= unlock    → WHERE filters out; row UNTOUCHED. Never
--                            demote an admin to approve_unlock.
--
-- Safe to re-run.
--
-- ============================================================================
-- USER ABSENCE HANDLING
-- ============================================================================
--
-- If the synthetic user's auth.users row does not exist (e.g., the
-- account was deleted or this migration is being applied to a fresh
-- environment where the fixture has not been seeded), the SELECT
-- returns no rows and the INSERT is a no-op — no error. The migration
-- assumes the synthetic user exists; creating it is out of scope here
-- (it was created via the Supabase auth admin UI during Phase 2). If
-- a future environment needs the user re-created, follow the standard
-- Supabase auth provisioning flow and document the new credentials in
-- the project's secure operational notes.
-- ============================================================================


-- ---- 1. Grant approve_unlock on Tuition ---------------------------------

insert into user_module_permissions (user_id, module_id, permission_level, granted_at)
select u.id, m.id, 'approve_unlock'::permission_level, now()
  from auth.users u
  cross join modules m
 where u.email = 'treasurer.test@libertas.local'
   and m.code = 'tuition'
on conflict (user_id, module_id) do update
  set permission_level = 'approve_unlock'::permission_level,
      granted_at = now()
  where user_module_permissions.permission_level < 'approve_unlock'::permission_level;


-- ---- 2. Defensive restore of Budget approve_unlock ----------------------
--
-- Mirrors the original Phase 2 grant. No-op if already present at this
-- level or above.

insert into user_module_permissions (user_id, module_id, permission_level, granted_at)
select u.id, m.id, 'approve_unlock'::permission_level, now()
  from auth.users u
  cross join modules m
 where u.email = 'treasurer.test@libertas.local'
   and m.code = 'budget'
on conflict (user_id, module_id) do update
  set permission_level = 'approve_unlock'::permission_level,
      granted_at = now()
  where user_module_permissions.permission_level < 'approve_unlock'::permission_level;


-- ---- 3. PostgREST schema cache reload -----------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 035
-- ============================================================================
