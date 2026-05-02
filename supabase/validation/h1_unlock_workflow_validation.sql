-- ============================================================================
-- Phase 2 Session H1 — Unlock workflow validation queries
--
-- Run these AFTER applying Migrations 016, 017 (PART A then PART B), and 018
-- in the Supabase SQL Editor.
--
-- Each numbered section is independently runnable.
-- Sections 1–4 are structural — they return rows you can inspect.
-- Section 5 is a transactional smoke test that rolls back at the end so
-- the live locked Scenario 1 remains untouched. It uses a fail-loud
-- pattern: every passing test runs silently; any failure raises a clear
-- exception that the editor displays. If section 5 runs to completion
-- without throwing, all smoke tests passed.
-- ============================================================================


-- ============================================================================
-- 1. Migration 016 structural check
-- ============================================================================

-- 1a. The eight new columns. Expect 8 rows.
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_name = 'budget_stage_scenarios'
   and column_name like 'unlock\_%'
 order by ordinal_position;

-- 1b. The four named CHECK constraints. Expect 4 rows.
select constraint_name, check_clause
  from information_schema.check_constraints
 where constraint_schema = 'public'
   and constraint_name like 'unlock_%'
 order by constraint_name;

-- 1c. The trigger. Expect rows for INSERT and UPDATE, action_timing = 'BEFORE'.
select trigger_name, action_timing, event_manipulation
  from information_schema.triggers
 where event_object_table = 'budget_stage_scenarios'
   and trigger_name = 'budget_stage_scenarios_unlock_only_when_locked'
 order by event_manipulation;

-- 1d. The partial index. Expect 1 row whose indexdef ends with
--     "WHERE (unlock_requested = true)".
select indexname, indexdef
  from pg_indexes
 where tablename = 'budget_stage_scenarios'
   and indexname = 'budget_stage_scenarios_unlock_pending';


-- ============================================================================
-- 2. Migration 017 structural check
-- ============================================================================

-- 2a. The enum value 'approve_unlock' exists, positioned between
--     'approve_lock' and 'admin'. Expect rows in this order:
--     view, edit, submit_lock, approve_lock, approve_unlock, admin.
select enumlabel, enumsortorder
  from pg_enum
 where enumtypid = 'permission_level'::regtype
 order by enumsortorder;

-- 2b. Jenna has approve_unlock or higher on Budget. Expect 1 row, with
--     permission_level either 'approve_unlock' or 'admin'.
select u.email, m.code as module_code, ump.permission_level, ump.granted_at
  from user_module_permissions ump
  join auth.users u on u.id = ump.user_id
  join modules m   on m.id = ump.module_id
 where u.email = 'jennsalazar@hotmail.com'
   and m.code = 'budget';


-- ============================================================================
-- 3. Migration 018 structural check
-- ============================================================================

-- Expect 3 rows. security_definer = true on all three.
select n.nspname as schema, p.proname as function_name,
       pg_get_function_arguments(p.oid) as arguments,
       pg_get_function_result(p.oid)    as returns,
       p.prosecdef                       as security_definer
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
-- 4. Sanity check — locked scenarios are untouched
-- ============================================================================

-- Expect: state = 'locked', unlock_requested = false, all unlock_* fields NULL.
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
-- 5. SMOKE TEST — transactional, fail-loud, rolls back at the end
-- ============================================================================
--
-- Pattern: every check that passes is silent. Any failure raises an
-- exception with a clear message. The whole block runs inside a
-- BEGIN/ROLLBACK so the live locked scenario stays untouched whether
-- the test succeeds or fails.
--
-- Important about the SQL Editor context: `auth.uid()` is NULL in the
-- editor (the editor runs as `postgres`, with no JWT). The functions
-- check `current_user_has_module_perm(...)` which falls back to
-- `is_system_admin()` — true for the postgres role — so all three
-- branches WILL execute. Initiator-separation logic that checks
-- `unlock_requested_by = auth.uid()` will treat both sides as NULL
-- (NULL = NULL is NULL, which is falsy in `if`), meaning the
-- initiator-as-approver path won't be exercised here. That's
-- acceptable — H2 will exercise that path with a real authenticated
-- user. What we DO confirm here:
--   1. request_budget_stage_unlock sets unlock_requested = true and
--      stores the justification.
--   2. The state stays 'locked' during the request (locked render
--      paths remain bound to snapshots — §5.1).
--   3. Empty / whitespace-only justification is rejected.
--   4. reject_budget_stage_unlock clears all unlock fields and
--      leaves state = 'locked'.
--   5. Empty / whitespace-only reason on reject is rejected.
--
-- A successful run produces no output other than "Success. Rolled back."

begin;

do $$
declare
  v_scenario_id uuid;
  v_post        record;
begin
  -- Pick the most recently-locked scenario.
  select id into v_scenario_id
    from budget_stage_scenarios
   where state = 'locked'
   order by locked_at desc
   limit 1;

  if v_scenario_id is null then
    raise exception 'SMOKE TEST SKIPPED: no locked scenario available';
  end if;

  -- ---- Test 1: request_budget_stage_unlock should succeed -----------------
  perform request_budget_stage_unlock(v_scenario_id, 'smoke test — H1 validation');

  select state, unlock_requested, unlock_request_justification
    into v_post
    from budget_stage_scenarios
   where id = v_scenario_id;

  if v_post.unlock_requested is not true then
    raise exception 'TEST 1 FAILED: unlock_requested = % (expected true)', v_post.unlock_requested;
  end if;
  if v_post.state <> 'locked' then
    raise exception 'TEST 1 FAILED: state = % (expected unchanged: locked)', v_post.state;
  end if;
  if v_post.unlock_request_justification is null
     or length(trim(v_post.unlock_request_justification)) = 0 then
    raise exception 'TEST 1 FAILED: justification did not persist correctly';
  end if;

  -- ---- Test 2: empty justification on a fresh request should be rejected ---
  -- We must reject the existing request first to clear unlock_requested,
  -- then attempt a fresh request with empty justification.
  perform reject_budget_stage_unlock(v_scenario_id, 'reset for test 2');

  begin
    perform request_budget_stage_unlock(v_scenario_id, '   ');
    raise exception 'TEST 2 FAILED: empty/whitespace justification was accepted';
  exception
    when others then
      if SQLERRM not like '%non-empty justification%' then
        raise exception 'TEST 2 FAILED: wrong error message — got: %', SQLERRM;
      end if;
      -- Otherwise: passes; expected exception with expected message.
  end;

  -- ---- Test 3: reject_budget_stage_unlock clears fields, state stays locked
  -- Set up: request again, then reject and verify.
  perform request_budget_stage_unlock(v_scenario_id, 'setup for test 3');
  perform reject_budget_stage_unlock(v_scenario_id, 'smoke test cleanup');

  select state, unlock_requested, unlock_request_justification, unlock_requested_by
    into v_post
    from budget_stage_scenarios
   where id = v_scenario_id;

  if v_post.unlock_requested is not false then
    raise exception 'TEST 3 FAILED: unlock_requested = % after reject (expected false)', v_post.unlock_requested;
  end if;
  if v_post.unlock_request_justification is not null then
    raise exception 'TEST 3 FAILED: justification not cleared after reject';
  end if;
  if v_post.unlock_requested_by is not null then
    raise exception 'TEST 3 FAILED: requested_by not cleared after reject';
  end if;
  if v_post.state <> 'locked' then
    raise exception 'TEST 3 FAILED: state changed to % after reject (expected: still locked)', v_post.state;
  end if;

  -- ---- Test 4: empty reason on reject should be rejected ------------------
  -- Re-request to set up; then attempt reject with empty reason.
  perform request_budget_stage_unlock(v_scenario_id, 'setup for test 4');

  begin
    perform reject_budget_stage_unlock(v_scenario_id, '');
    raise exception 'TEST 4 FAILED: empty reason was accepted on reject';
  exception
    when others then
      if SQLERRM not like '%reason%' then
        raise exception 'TEST 4 FAILED: wrong error message — got: %', SQLERRM;
      end if;
      -- Otherwise: passes; expected exception with expected message.
  end;

  -- All tests passed silently if we reach here.
end $$;

-- Roll back so the live locked scenario stays untouched.
rollback;


-- ============================================================================
-- 6. Final sanity check — confirm Scenario 1 is exactly as before
-- ============================================================================

-- Run after section 5 has completed. Should return the same rows as
-- section 4. unlock_requested = false on every row.
select id, scenario_label, state, is_recommended,
       unlock_requested,
       unlock_requested_by
  from budget_stage_scenarios
 where state = 'locked'
 order by locked_at desc
 limit 5;
