-- ============================================================================
-- Migration 025: Tuition Worksheet unlock workflow RPCs (two-identity)
--
-- Tuition-A2 (v3.8.1). Three SECURITY DEFINER functions implementing
-- the v3.7 two-identity unlock model on the Tuition module. Parallel
-- to Budget's Migration 021 in shape.
--
-- Two-identity model recap (architecture §8.13, CLAUDE.md "Unlock
-- workflow on locked scenarios"):
--   - The requester's submission counts as approval_1. Same identity
--     populates both the request fields AND the approval_1 fields
--     atomically.
--   - One additional approver (different identity, also holding
--     approve_unlock) records approval_2 and triggers the state
--     transition back to 'drafting'.
--   - Reject and Withdraw share an RPC; the function detects the
--     branch by comparing auth.uid() to scenario.unlock_requested_by.
--
-- app.change_reason signatures (consumed by tg_log_changes):
--   'unlock_requested'           — request submission (also approval_1)
--   'unlock_completed'           — approval_2 recorded; state flips
--   'unlock_rejected: <reason>'  — rejection by approve_unlock holder
--   'unlock_withdrawn: <reason>' — withdrawal by original requester
-- ============================================================================


-- ---- 1. request_tuition_scenario_unlock ----------------------------------

create or replace function request_tuition_scenario_unlock(
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
  -- Permission gate: approve_unlock. Submitting an unlock request is
  -- itself a governance act of approval (the request submission counts
  -- as approval_1 under the v3.7 two-identity model), so the request
  -- gate matches the approve gate.
  if not current_user_has_module_perm('tuition', 'approve_unlock') then
    raise exception 'Requesting a tuition unlock requires approve_unlock permission on tuition.';
  end if;

  if p_justification is null or length(trim(p_justification)) = 0 then
    raise exception 'Unlock request requires a non-empty justification.';
  end if;

  select * into v_scenario
    from tuition_worksheet_scenarios
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
  -- request fields AND the approval_1 fields. The remaining gate to
  -- unlock is approval_2 from a different identity. CHECK constraints
  -- (Migration 022) enforce: requester != approval_2; approval_1 !=
  -- approval_2.
  update tuition_worksheet_scenarios
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

grant execute on function request_tuition_scenario_unlock(uuid, text) to authenticated;


-- ---- 2. approve_tuition_scenario_unlock ----------------------------------
--
-- v3.7 simplified shape: returns void; no first/final branching;
-- always handles approval_2 + state transition. Two UPDATEs in one
-- transaction so the audit trail captures who approved second
-- (Step 1) before the unlock fields are cleared (Step 2). Same
-- two-statement structure as Migration 021's approve_budget_*.

create or replace function approve_tuition_scenario_unlock(
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
  if not current_user_has_module_perm('tuition', 'approve_unlock') then
    raise exception 'Tuition unlock approval requires approve_unlock permission on tuition.';
  end if;

  select * into v_scenario
    from tuition_worksheet_scenarios
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

  -- Initiator separation: the requester (also approval_1 under v3.7)
  -- cannot record approval_2.
  if v_scenario.unlock_requested_by = v_caller then
    raise exception 'The unlock requester cannot also record the second approval.';
  end if;

  -- Defensive: approval_2 should not already be populated. The
  -- unlock_sequential_ordering CHECK and the workflow design make
  -- this unreachable, but raise loudly if it ever happens.
  if v_scenario.unlock_approval_2_at is not null then
    raise exception 'Unlock has already been approved twice on this scenario.';
  end if;

  -- Step 1: capture approval_2 identity so change_log records it.
  perform set_config('app.change_reason', 'unlock_completed', true);

  update tuition_worksheet_scenarios
     set unlock_approval_2_at = now(),
         unlock_approval_2_by = v_caller,
         updated_by           = v_caller
   where id = p_scenario_id;

  -- Step 2: flip state to drafting; clear all unlock_* fields.
  update tuition_worksheet_scenarios
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

grant execute on function approve_tuition_scenario_unlock(uuid) to authenticated;


-- ---- 3. reject_tuition_scenario_unlock -----------------------------------
--
-- Two authorization branches share this function:
--   - Reject:   caller has approve_unlock and is NOT the requester.
--   - Withdraw: caller IS the requester (no approve_unlock check
--               needed — withdrawing your own request is housekeeping).
-- Both paths require non-empty reason text. The reason is folded
-- into app.change_reason because rejection clears all unlock fields
-- — there is no surviving row-level field that would otherwise
-- carry it.

create or replace function reject_tuition_scenario_unlock(
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
    from tuition_worksheet_scenarios
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
    if not current_user_has_module_perm('tuition', 'approve_unlock') then
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

  update tuition_worksheet_scenarios
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

grant execute on function reject_tuition_scenario_unlock(uuid, text) to authenticated;


-- ---- 4. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 025
-- ============================================================================
