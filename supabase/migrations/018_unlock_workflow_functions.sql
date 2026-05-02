-- ============================================================================
-- Migration 018: Unlock workflow functions
--
-- Phase 2 Session H1, Part C. Three SECURITY DEFINER functions that drive
-- the budget unlock workflow:
--
--   request_budget_stage_unlock(scenario_id, justification)
--   approve_budget_stage_unlock(scenario_id) -> 'first_approval_recorded' | 'unlock_completed'
--   reject_budget_stage_unlock(scenario_id, reason)
--
-- All three are SECURITY DEFINER so they bypass RLS for their internal
-- reads/writes; they enforce authorization explicitly via
-- current_user_has_module_perm and direct uid comparisons.
--
-- Audit trail: each function sets `app.change_reason` before its UPDATE
-- so the existing tg_log_changes trigger (Migration 001, attached to
-- budget_stage_scenarios in Migration 011) captures a recognizable
-- signature on every change_log row it emits. Reasons used:
--
--   'unlock_requested'           — request_budget_stage_unlock
--   'unlock_first_approval'      — approve_budget_stage_unlock (first call)
--   'unlock_completed'           — approve_budget_stage_unlock (second call)
--   'unlock_rejected: <reason>'  — reject_budget_stage_unlock (approver path)
--   'unlock_withdrawn: <reason>' — reject_budget_stage_unlock (requester path)
--
-- The rejection/withdraw user-supplied reason text is concatenated into
-- app.change_reason because rejection clears all unlock fields — there's
-- no row-level field to preserve the reason in. The signature thus
-- carries the reason text into change_log.reason for permanent audit.
--
-- See architecture §8.13 for the full state model and rationale.
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
  -- Authorization: the requester needs submit_lock on the Budget module.
  -- Symmetric with the lock-submission path; same permission tier.
  if not current_user_has_module_perm('budget', 'submit_lock') then
    raise exception 'Requesting an unlock requires submit_lock permission on budget.';
  end if;

  -- Validate justification — non-empty after trim.
  if p_justification is null or length(trim(p_justification)) = 0 then
    raise exception 'Unlock request requires a non-empty justification.';
  end if;

  -- Lock + load the scenario row.
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

  -- Tag the change_log signature for this transaction's UPDATEs.
  perform set_config('app.change_reason', 'unlock_requested', true);

  update budget_stage_scenarios
     set unlock_requested              = true,
         unlock_request_justification  = trim(p_justification),
         unlock_requested_at           = now(),
         unlock_requested_by           = v_caller,
         updated_by                    = v_caller
   where id = p_scenario_id;
end;
$$;

grant execute on function request_budget_stage_unlock(uuid, text) to authenticated;


-- ---- 2. approve_budget_stage_unlock --------------------------------------
--
-- Returns 'first_approval_recorded' on the first invocation, then
-- 'unlock_completed' on the second (which also flips state to 'drafting'
-- and clears all unlock_* fields). The two-step structure preserves the
-- governance commitment (two distinct approvers) at the function layer
-- in addition to the CHECK constraints.
--
-- Implementation note: the second-approval branch issues TWO separate
-- UPDATE statements within the same transaction. The first sets
-- unlock_approval_2_at and unlock_approval_2_by so the change_log
-- trigger captures who approved second and when. The second flips
-- state and clears all unlock fields. Both UPDATEs run inside the
-- function's implicit transaction → atomic. If the second UPDATE
-- failed, the first would roll back too.
--
-- Why two UPDATEs instead of one: PostgreSQL forbids the same column
-- being assigned twice in a single UPDATE. To both populate
-- approval_2 fields (so the trigger logs them) and then clear them
-- (per the design), we need separate statements. Reordering — clear
-- in one UPDATE, populate in another — is the audit-preserving
-- ordering: capture who approved before erasing the active-state
-- record.

create or replace function approve_budget_stage_unlock(
  p_scenario_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scenario record;
  v_caller   uuid := auth.uid();
begin
  -- Authorization: approve_unlock or higher (admin subsumes via enum order).
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

  -- Initiator separation. The user who requested cannot approve.
  if v_scenario.unlock_requested_by = v_caller then
    raise exception 'The unlock initiator cannot also approve the unlock.';
  end if;

  -- Two distinct approvers. Same user can't fill approval_1 AND approval_2.
  if v_scenario.unlock_approval_1_by = v_caller then
    raise exception
      'You have already recorded the first approval; the second approval requires a different approver.';
  end if;

  if v_scenario.unlock_approval_1_at is null then
    -- ---- First approval: record it; remain in unlock-in-progress state.
    perform set_config('app.change_reason', 'unlock_first_approval', true);

    update budget_stage_scenarios
       set unlock_approval_1_at = now(),
           unlock_approval_1_by = v_caller,
           updated_by           = v_caller
     where id = p_scenario_id;

    return 'first_approval_recorded';
  else
    -- ---- Second approval: capture approver_2, then clear and transition.
    --
    -- Step 1: capture who approved second (so change_log records them
    -- before they're cleared by step 2).
    perform set_config('app.change_reason', 'unlock_completed', true);

    update budget_stage_scenarios
       set unlock_approval_2_at = now(),
           unlock_approval_2_by = v_caller,
           updated_by           = v_caller
     where id = p_scenario_id;

    -- Step 2: flip state to drafting, clear all unlock_* fields.
    -- Trigger emits another change_log batch — same reason signature.
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

    return 'unlock_completed';
  end if;
end;
$$;

grant execute on function approve_budget_stage_unlock(uuid) to authenticated;


-- ---- 3. reject_budget_stage_unlock ---------------------------------------
--
-- Two authorization paths share this function:
--   - "Reject"  : caller has approve_unlock permission. Rejecting someone
--                 else's request.
--   - "Withdraw": caller is the original requester. Cancelling their own
--                 pending request. No approve_unlock permission needed.
--
-- Both paths require a non-empty reason. The reason text is folded into
-- the change_log signature (app.change_reason) because rejection clears
-- all unlock fields — there's no surviving row-level field to capture
-- it. Audit trail is preserved permanently in change_log.reason.

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
  -- Validate reason early — same validation regardless of path.
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

  -- Branch authorization on whether caller is the original requester.
  v_is_withdraw := (v_scenario.unlock_requested_by = v_caller);

  if not v_is_withdraw then
    -- Not the requester; must hold approve_unlock to reject someone else's.
    if not current_user_has_module_perm('budget', 'approve_unlock') then
      raise exception
        'Rejecting an unlock request requires approve_unlock permission, '
        'or being the original requester (withdraw).';
    end if;
  end if;

  -- Build change_log signature carrying the path marker AND the user's
  -- reason text. Permanent audit lives here because all unlock_* fields
  -- get cleared below.
  v_signature := case
    when v_is_withdraw then 'unlock_withdrawn: '
    else                    'unlock_rejected: '
  end || trim(p_reason);

  perform set_config('app.change_reason', v_signature, true);

  -- Clear all unlock_* fields. State stays 'locked' — no transition.
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
-- END OF MIGRATION 018
-- ============================================================================
