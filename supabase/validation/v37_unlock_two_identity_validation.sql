-- ============================================================================
-- v3.7 unlock-workflow refactor — validation queries
--
-- Run these AFTER applying Migrations 020 and 021 in the Supabase SQL
-- Editor. Sections 1–4 are structural checks (return rows you can
-- inspect). Section 5 is a transactional fail-loud smoke test that
-- exercises the new two-identity model and rolls back at the end.
-- ============================================================================


-- ============================================================================
-- 1. Migration 020: dropped CHECK constraint
-- ============================================================================

-- Expect ZERO rows. The unlock_initiator_not_approver_1 constraint
-- should no longer exist on budget_stage_scenarios.
select constraint_name
  from information_schema.check_constraints
 where constraint_schema = 'public'
   and constraint_name = 'unlock_initiator_not_approver_1';

-- Expect THREE rows: the surviving unlock_* CHECK constraints.
--   unlock_initiator_not_approver_2
--   unlock_approvers_distinct
--   unlock_sequential_ordering
select constraint_name
  from information_schema.check_constraints
 where constraint_schema = 'public'
   and constraint_name like 'unlock_%'
 order by constraint_name;


-- ============================================================================
-- 2. Migration 021: function signatures
-- ============================================================================

-- Expect THREE rows. approve_budget_stage_unlock now returns void
-- (was text in v1 — confirms the simplification took effect).
select n.nspname as schema, p.proname as function_name,
       pg_get_function_arguments(p.oid) as arguments,
       pg_get_function_result(p.oid)    as returns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in (
     'request_budget_stage_unlock',
     'approve_budget_stage_unlock',
     'reject_budget_stage_unlock'
   )
 order by p.proname;


-- ============================================================================
-- 3. Sanity check — locked scenarios remain untouched
-- ============================================================================

-- Expect: state = 'locked', unlock_requested = false, ALL unlock_*
-- fields NULL. The pre-migration withdrawal cleared everything; v3.7
-- migrations did not touch any data.
select id, scenario_label, state, is_recommended,
       unlock_requested,
       unlock_requested_by,
       unlock_approval_1_by,
       unlock_approval_2_by
  from budget_stage_scenarios
 where state = 'locked'
 order by locked_at desc
 limit 5;


-- ============================================================================
-- 4. Two-identity smoke test
-- ============================================================================
--
-- Pattern: every check that passes is silent. Any failure raises a
-- clear exception. The whole block runs inside a BEGIN/ROLLBACK so
-- the live locked Scenario 1 stays untouched whether the test
-- succeeds or fails.
--
-- The smoke test impersonates Jenna for the duration so auth.uid()
-- resolves to her uid. Tests:
--
--   T1 — request_budget_stage_unlock atomically populates BOTH
--        request fields AND approval_1 fields from caller's identity.
--   T2 — approve_budget_stage_unlock as the requester (Jenna)
--        should fail with the initiator-separation message
--        ("requester cannot also record the second approval").
--   T3 — reject_budget_stage_unlock (withdraw path) clears all
--        unlock_* fields; state stays 'locked'.
--   T4 — empty justification rejected.
--   T5 — empty reason on reject rejected.

begin;

do $$
declare
  v_jenna_id    uuid;
  v_scenario_id uuid;
  v_post        record;
begin
  select id into v_jenna_id from auth.users where email = 'jennsalazar@hotmail.com';
  if v_jenna_id is null then
    raise exception 'SMOKE TEST PRECONDITION FAILED: jennsalazar@hotmail.com not in auth.users';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_jenna_id::text)::text,
    true
  );

  -- Pick the most recently-locked scenario.
  select id into v_scenario_id
    from budget_stage_scenarios
   where state = 'locked'
   order by locked_at desc
   limit 1;

  if v_scenario_id is null then
    raise exception 'SMOKE TEST SKIPPED: no locked scenario available';
  end if;

  -- ---- T1: request populates request AND approval_1 atomically ----------
  perform request_budget_stage_unlock(v_scenario_id, 'v3.7 smoke test — request as approval_1');

  select state, unlock_requested,
         unlock_request_justification,
         unlock_requested_by,
         unlock_approval_1_by, unlock_approval_1_at
    into v_post
    from budget_stage_scenarios
   where id = v_scenario_id;

  if v_post.unlock_requested is not true then
    raise exception 'T1 FAILED: unlock_requested = % (expected true)', v_post.unlock_requested;
  end if;
  if v_post.state <> 'locked' then
    raise exception 'T1 FAILED: state = % (expected unchanged: locked)', v_post.state;
  end if;
  if v_post.unlock_requested_by <> v_jenna_id then
    raise exception 'T1 FAILED: requested_by = %, expected Jenna (%)', v_post.unlock_requested_by, v_jenna_id;
  end if;
  -- v3.7 atomic population: approval_1 must equal requester
  if v_post.unlock_approval_1_by is null then
    raise exception 'T1 FAILED: unlock_approval_1_by is NULL — request did not populate approval_1 atomically';
  end if;
  if v_post.unlock_approval_1_by <> v_jenna_id then
    raise exception 'T1 FAILED: approval_1_by = % (expected Jenna %)', v_post.unlock_approval_1_by, v_jenna_id;
  end if;
  if v_post.unlock_approval_1_at is null then
    raise exception 'T1 FAILED: unlock_approval_1_at is NULL';
  end if;

  -- ---- T2: requester cannot record approval_2 ---------------------------
  begin
    perform approve_budget_stage_unlock(v_scenario_id);
    raise exception 'T2 FAILED: initiator was allowed to record approval_2';
  exception
    when others then
      if SQLERRM not like '%requester cannot also%' then
        raise exception 'T2 FAILED: wrong error message — got: %', SQLERRM;
      end if;
  end;

  -- ---- T3: reject (withdraw path, since caller == requester) ------------
  perform reject_budget_stage_unlock(v_scenario_id, 'v3.7 smoke test cleanup');

  select state, unlock_requested, unlock_requested_by,
         unlock_approval_1_by, unlock_approval_2_by
    into v_post
    from budget_stage_scenarios
   where id = v_scenario_id;

  if v_post.unlock_requested is not false then
    raise exception 'T3 FAILED: unlock_requested = % after reject (expected false)', v_post.unlock_requested;
  end if;
  if v_post.unlock_requested_by is not null then
    raise exception 'T3 FAILED: requested_by not cleared';
  end if;
  if v_post.unlock_approval_1_by is not null then
    raise exception 'T3 FAILED: approval_1_by not cleared';
  end if;
  if v_post.state <> 'locked' then
    raise exception 'T3 FAILED: state changed to % (expected: still locked)', v_post.state;
  end if;

  -- ---- T4: empty justification rejected ---------------------------------
  begin
    perform request_budget_stage_unlock(v_scenario_id, '   ');
    raise exception 'T4 FAILED: empty justification was accepted';
  exception
    when others then
      if SQLERRM not like '%non-empty justification%' then
        raise exception 'T4 FAILED: wrong error message — got: %', SQLERRM;
      end if;
  end;

  -- ---- T5: empty reason on reject rejected ------------------------------
  -- Need a pending request first to have something to reject.
  perform request_budget_stage_unlock(v_scenario_id, 'setup for T5');

  begin
    perform reject_budget_stage_unlock(v_scenario_id, '');
    raise exception 'T5 FAILED: empty reason was accepted on reject';
  exception
    when others then
      if SQLERRM not like '%reason%' then
        raise exception 'T5 FAILED: wrong error message — got: %', SQLERRM;
      end if;
  end;

  -- All tests passed silently if we reach here.
end $$;

rollback;


-- ============================================================================
-- 5. Final sanity check — confirm Scenario 1 is exactly as before
-- ============================================================================

select id, scenario_label, state,
       unlock_requested,
       unlock_requested_by
  from budget_stage_scenarios
 where state = 'locked'
 order by locked_at desc
 limit 5;
