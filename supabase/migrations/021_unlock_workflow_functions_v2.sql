-- ============================================================================
-- Migration 021: Unlock workflow functions — two-identity model (v2)
--
-- v3.7. Replaces the three SECURITY DEFINER functions from Migration 018
-- to reflect the two-identity unlock model:
--
--   request_budget_stage_unlock
--     - Permission gate: approve_unlock (was submit_lock in v1)
--     - Atomically populates BOTH the request fields AND the approval_1
--       fields from the caller's identity. The submission represents
--       the requester's professional judgment and counts as approval_1.
--
--   approve_budget_stage_unlock
--     - Returns void (was text in v1) — no more 'first_approval_recorded'
--       branch since approval_1 is always populated by the time approve
--       is callable.
--     - Always handles approval_2: records timestamp + approver, flips
--       state to 'drafting', clears all unlock_* fields. Single-step
--       transition, no first/second branching.
--
--   reject_budget_stage_unlock
--     - Logic unchanged. Internal documentation refreshed to reference
--       the two-identity model; both branches (rejection by an
--       approve_unlock holder; withdrawal by the original requester)
--       behave the same as before.
--
-- Architecture references: §8.13 (rewritten in v3.7), CLAUDE.md "Unlock
-- workflow on locked scenarios" (rewritten in v3.7).
--
-- audit-log signatures (set via app.change_reason; consumed by
-- tg_log_changes attached to budget_stage_scenarios since Migration 011):
--   'unlock_requested'              — request submission (also represents
--                                     approval_1 from same identity)
--   'unlock_completed'              — approval_2 records and state flips
--   'unlock_rejected: <reason>'     — rejection by approve_unlock holder
--   'unlock_withdrawn: <reason>'    — withdrawal by original requester
-- ============================================================================


-- ---- 1. request_budget_stage_unlock --------------------------------------

create or replace function request_budget_stage_unlock(
  p_scenario_id   uuid,
  p_justification text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scenario record;
  v_caller   uuid := auth.uid();
begin
  -- Authorization: caller must hold approve_unlock (or higher via
  -- enum subsumption — admin passes too). v3.7: the requester's
  -- submission counts as approval_1, so the request gate matches the
  -- approve gate. Submitting an unlock request is itself a governance
  -- act of approval; the permission to do it is approve_unlock.
  if not current_user_has_module_perm('budget', 'approve_unlock') then
    raise exception 'Requesting an unlock requires approve_unlock permission on budget.';
  end if;

  if p_justification is null or length(trim(p_justification)) = 0 then
    raise exception 'Unlock request requires a non-empty justification.';
  end if;

  select * into v_scenario
    from budget_stage_scenarios
   where id = p_scenario_id
   for update;

  if v_scenario is null then
    raise exception 'Scenario % not found.', p_scenario_id;
  end if;
  if v_scenario.state <> 'locked' then
    raise exception
      'Cannot request unlock; scenario state is % (must be locked).',
      v_scenario.state;
  end if;
  if v_scenario.unlock_requested then
    raise exception 'An unlock request is already in progress on this scenario.';
  end if;

  perform set_config('app.change_reason', 'unlock_requested', true);

  -- Atomic two-identity model: caller's identity populates BOTH the
  -- request fields (unlock_requested_by + unlock_requested_at) AND the
  -- approval_1 fields (unlock_approval_1_by + unlock_approval_1_at).
  -- The remaining gate to unlock is approval_2 from a different
  -- identity. CHECK constraints enforce: requester != approval_2,
  -- approval_1 != approval_2.
  update budget_stage_scenarios
     set unlock_requested              = true,
         unlock_request_justification  = trim(p_justification),
         unlock_requested_at           = now(),
         unlock_requested_by           = v_caller,
         unlock_approval_1_at          = now(),
         unlock_approval_1_by          = v_caller,
         updated_by                    = v_caller
   where id = p_scenario_id;
end;
$$;

grant execute on function request_budget_stage_unlock(uuid, text) to authenticated;


-- ---- 2. approve_budget_stage_unlock --------------------------------------
--
-- v3.7: simplified. Returns void instead of text — the v1 branching
-- between 'first_approval_recorded' and 'unlock_completed' is gone
-- because approval_1 is always already populated by request time.
-- This function only ever handles approval_2 + state transition.
--
-- Like the v1 second-approval branch, the function issues TWO separate
-- UPDATE statements within the same transaction:
--   1. Sets approval_2 fields so the change_log trigger captures who
--      approved second and when.
--   2. Flips state to 'drafting' and clears all unlock_* fields.
-- Both UPDATEs run inside the function's implicit transaction → atomic.
-- The two-statement structure preserves the audit trail of who
-- approved second; collapsing into one UPDATE would not record the
-- approval_2 identity since the trigger logs field diffs and the
-- column ends NULL after the clear.

create or replace function approve_budget_stage_unlock(
  p_scenario_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scenario record;
  v_caller   uuid := auth.uid();
begin
  if not current_user_has_module_perm('budget', 'approve_unlock') then
    raise exception 'Unlock approval requires approve_unlock permission on budget.';
  end if;

  select * into v_scenario
    from budget_stage_scenarios
   where id = p_scenario_id
   for update;

  if v_scenario is null then
    raise exception 'Scenario % not found.', p_scenario_id;
  end if;
  if v_scenario.state <> 'locked' then
    raise exception
      'Scenario state must be locked for unlock approval (current: %).',
      v_scenario.state;
  end if;
  if not v_scenario.unlock_requested then
    raise exception 'No unlock request is pending on this scenario.';
  end if;

  -- Initiator separation: the requester (who is also approval_1)
  -- cannot record approval_2.
  if v_scenario.unlock_requested_by = v_caller then
    raise exception 'The unlock requester cannot also record the second approval.';
  end if;

  -- Defensive: approval_2 should not already be populated. The
  -- unlock_sequential_ordering CHECK + the workflow design make this
  -- unreachable, but raise loudly if it ever happens.
  if v_scenario.unlock_approval_2_at is not null then
    raise exception 'Unlock has already been approved twice on this scenario.';
  end if;

  -- Step 1: capture approval_2 identity so change_log records it.
  perform set_config('app.change_reason', 'unlock_completed', true);

  update budget_stage_scenarios
     set unlock_approval_2_at = now(),
         unlock_approval_2_by = v_caller,
         updated_by           = v_caller
   where id = p_scenario_id;

  -- Step 2: flip state to drafting; clear all unlock_* fields.
  update budget_stage_scenarios
     set state                        = 'drafting',
         unlock_requested             = false,
         unlock_request_justification = null,
         unlock_requested_at          = null,
         unlock_requested_by          = null,
         unlock_approval_1_at         = null,
         unlock_approval_1_by         = null,
         unlock_approval_2_at         = null,
         unlock_approval_2_by         = null,
         updated_by                   = v_caller
   where id = p_scenario_id;
end;
$$;

grant execute on function approve_budget_stage_unlock(uuid) to authenticated;


-- ---- 3. reject_budget_stage_unlock ---------------------------------------
--
-- v3.7: logic unchanged from v1. Two authorization paths share this
-- function:
--   - Reject:   caller has approve_unlock and is NOT the requester.
--   - Withdraw: caller IS the original requester (no approve_unlock
--               check needed — withdrawing your own request is
--               housekeeping).
-- Both paths require non-empty reason text. The reason is folded into
-- app.change_reason because rejection clears all unlock fields — there
-- is no surviving row-level field that would otherwise carry it.
--
-- Note: under the two-identity model, the requester is also approval_1.
-- That has no effect on this function's behavior — withdraw still
-- means "the requester pulls back their own request" and the function
-- detects it via auth.uid() == unlock_requested_by.

create or replace function reject_budget_stage_unlock(
  p_scenario_id uuid,
  p_reason      text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scenario     record;
  v_caller       uuid := auth.uid();
  v_is_withdraw  boolean;
  v_signature    text;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required to reject or withdraw an unlock request.';
  end if;

  select * into v_scenario
    from budget_stage_scenarios
   where id = p_scenario_id
   for update;

  if v_scenario is null then
    raise exception 'Scenario % not found.', p_scenario_id;
  end if;
  if v_scenario.state <> 'locked' then
    raise exception
      'Scenario state must be locked (current: %).',
      v_scenario.state;
  end if;
  if not v_scenario.unlock_requested then
    raise exception 'No unlock request is pending on this scenario.';
  end if;

  v_is_withdraw := (v_scenario.unlock_requested_by = v_caller);

  if not v_is_withdraw then
    if not current_user_has_module_perm('budget', 'approve_unlock') then
      raise exception
        'Rejecting an unlock request requires approve_unlock permission, '
        'or being the original requester (withdraw).';
    end if;
  end if;

  v_signature := case
    when v_is_withdraw then 'unlock_withdrawn: '
    else                    'unlock_rejected: '
  end || trim(p_reason);

  perform set_config('app.change_reason', v_signature, true);

  update budget_stage_scenarios
     set unlock_requested             = false,
         unlock_request_justification = null,
         unlock_requested_at          = null,
         unlock_requested_by          = null,
         unlock_approval_1_at         = null,
         unlock_approval_1_by         = null,
         unlock_approval_2_at         = null,
         unlock_approval_2_by         = null,
         updated_by                   = v_caller
   where id = p_scenario_id;
end;
$$;

grant execute on function reject_budget_stage_unlock(uuid, text) to authenticated;


-- ---- 4. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 021
-- ============================================================================
