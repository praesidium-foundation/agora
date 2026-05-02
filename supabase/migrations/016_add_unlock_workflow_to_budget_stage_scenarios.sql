-- ============================================================================
-- Migration 016: Add unlock workflow to budget_stage_scenarios
--
-- Phase 2 Session H1, Part A. Adds the eight columns and integrity rules
-- that the budget unlock workflow needs. This is schema only — the three
-- SQL functions that drive request / approve / reject live in Migration
-- 018 (Migration 017 extends the permission_level enum and grants the
-- new permission to the live user).
--
-- Design decisions baked into this schema (architecture §8.13):
--
--   1. Two-step sequential approval. Initiator requests; first
--      approver records approval 1; second approver triggers the state
--      transition to 'drafting'. Each step has its own (at, by) pair
--      so audit history is self-evident from a SELECT alone.
--
--   2. State stays 'locked' throughout the unlock-in-progress window.
--      Only the second-approval transaction flips state to 'drafting'.
--      This preserves Migration 015's sibling-lock guards without
--      modification — they check `state = 'locked'`, which remains
--      true throughout request → first approval → second approval.
--
--   3. Initiator separation enforced at the DB level (CHECK
--      constraints). A single user cannot fill more than one of the
--      three roles (initiator, approver 1, approver 2).
--
--   4. Sequential ordering enforced at the DB level. approval_2
--      cannot populate before approval_1.
--
--   5. The "unlock_requested can only be true while state = 'locked'"
--      rule is enforced via a BEFORE trigger rather than a CHECK
--      because it references `state`, which can transition. Putting
--      it in a trigger lets us raise clear error messages and keeps
--      the CHECK list focused on within-row field relationships.
--
-- The CHECK constraints are named so error messages identify the rule
-- by name when a violation occurs — matters for the application
-- validator layer (H2) which will translate constraint names into
-- friendly user-facing copy.
-- ============================================================================

-- ---- 1. Columns -----------------------------------------------------------

alter table budget_stage_scenarios
  add column unlock_requested              boolean not null default false,
  add column unlock_request_justification  text,
  add column unlock_requested_at           timestamptz,
  add column unlock_requested_by           uuid references auth.users(id) on delete set null,
  add column unlock_approval_1_at          timestamptz,
  add column unlock_approval_1_by          uuid references auth.users(id) on delete set null,
  add column unlock_approval_2_at          timestamptz,
  add column unlock_approval_2_by          uuid references auth.users(id) on delete set null;

-- ---- 2. CHECK constraints (initiator separation + sequential ordering) ---

-- Initiator may not also be approver 1.
alter table budget_stage_scenarios
  add constraint unlock_initiator_not_approver_1 check (
    unlock_requested_by is null
    or unlock_approval_1_by is null
    or unlock_requested_by <> unlock_approval_1_by
  );

-- Initiator may not also be approver 2.
alter table budget_stage_scenarios
  add constraint unlock_initiator_not_approver_2 check (
    unlock_requested_by is null
    or unlock_approval_2_by is null
    or unlock_requested_by <> unlock_approval_2_by
  );

-- The two approvers must be distinct from each other.
alter table budget_stage_scenarios
  add constraint unlock_approvers_distinct check (
    unlock_approval_1_by is null
    or unlock_approval_2_by is null
    or unlock_approval_1_by <> unlock_approval_2_by
  );

-- Sequential ordering: approval_2 fields cannot populate before
-- approval_1 fields. Either approval_2 is fully NULL, or approval_1
-- is fully populated.
alter table budget_stage_scenarios
  add constraint unlock_sequential_ordering check (
    (unlock_approval_2_at is null and unlock_approval_2_by is null)
    or (unlock_approval_1_at is not null and unlock_approval_1_by is not null)
  );

-- ---- 3. Trigger: unlock fields require state = 'locked' ------------------

create or replace function tg_unlock_only_when_locked()
returns trigger language plpgsql as $$
begin
  -- Allow any UPDATE that ends with unlock_requested = false. The
  -- second-approval flow specifically transitions state away from
  -- 'locked' at the same moment it sets unlock_requested = false; the
  -- post-image of that UPDATE is consistent.
  if NEW.unlock_requested = true and NEW.state <> 'locked' then
    raise exception
      'unlock_requested cannot be true unless state = ''locked'' (current state: %).',
      NEW.state;
  end if;
  return NEW;
end;
$$;

create trigger budget_stage_scenarios_unlock_only_when_locked
  before insert or update on budget_stage_scenarios
  for each row execute function tg_unlock_only_when_locked();

-- ---- 4. Partial index for fast pending-request lookups -------------------

-- Used by the H2 application layer to surface "is there a pending
-- unlock request on the scenario currently in (AYE, stage)?" without
-- a sequential scan.
create index budget_stage_scenarios_unlock_pending
  on budget_stage_scenarios (aye_id, stage_id)
  where unlock_requested = true;

-- ---- 5. PostgREST schema cache reload -----------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 016
-- ============================================================================
