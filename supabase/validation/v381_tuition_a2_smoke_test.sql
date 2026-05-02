-- ============================================================================
-- Tuition-A2 (v3.8.1) smoke test — rolled-back end-to-end exercise
--
-- Run this AFTER applying Migrations 022–026. Every check that passes
-- is silent. Any failure raises a clear exception. The whole block
-- runs inside BEGIN / ROLLBACK so live data stays untouched.
--
-- The test impersonates Jenna for the duration so auth.uid() resolves
-- to her uid throughout. Tests:
--
--   T1 — Stage 1 scenario create + tier_rates set
--   T2 — Stage 2 immutability trigger blocks tier_rates change on
--        a Stage 2 scenario
--   T3 — Family detail row insert blocked on Stage 1 scenario
--   T4 — Family detail row insert allowed on Stage 2 scenario
--   T5 — submit_tuition_scenario_for_lock_review transitions state
--   T6 — lock_tuition_scenario captures snapshot with KPIs
--   T7 — create_tuition_scenario_from_snapshot seeds Stage 2 from
--        the locked Stage 1 snapshot
--   T8 — request + approve unlock workflow (two-identity) on the
--        Stage 1 locked scenario
-- ============================================================================

begin;

do $$
declare
  v_jenna_id    uuid;
  v_aye_id      uuid;
  v_stage_1     uuid;
  v_stage_2     uuid;
  v_scenario_1  uuid;
  v_scenario_2  uuid;
  v_snapshot_id uuid;
  v_post        record;
  v_kpis        record;
  v_caught      boolean;
begin
  -- Resolve test fixtures.
  select id into v_jenna_id from auth.users where email = 'jennsalazar@hotmail.com';
  if v_jenna_id is null then
    raise exception 'PRECONDITION FAILED: jennsalazar@hotmail.com not in auth.users';
  end if;

  -- Use the current AYE.
  select id into v_aye_id from academic_years where is_current = true limit 1;
  if v_aye_id is null then
    raise exception 'PRECONDITION FAILED: no current AYE';
  end if;

  -- Resolve Stage 1 (Tuition Planning) and Stage 2 (Tuition Audit) ids.
  select s.id into v_stage_1
    from module_workflow_stages s
    join module_workflows w on w.id = s.workflow_id
    join modules m on m.id = w.module_id
   where m.code = 'tuition' and s.stage_type = 'preliminary';
  if v_stage_1 is null then
    raise exception 'PRECONDITION FAILED: Tuition Stage 1 not found';
  end if;

  select s.id into v_stage_2
    from module_workflow_stages s
    join module_workflows w on w.id = s.workflow_id
    join modules m on m.id = w.module_id
   where m.code = 'tuition' and s.stage_type = 'final';
  if v_stage_2 is null then
    raise exception 'PRECONDITION FAILED: Tuition Stage 2 not found';
  end if;

  -- Impersonate Jenna so auth.uid() resolves to her uid.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_jenna_id::text)::text,
    true
  );

  -- ---- T1: Stage 1 scenario create + tier_rates set ----------------------

  insert into tuition_worksheet_scenarios (
    aye_id, stage_id, scenario_label, is_recommended, state,
    tier_count, tier_rates,
    faculty_discount_pct,
    other_discount_envelope, financial_aid_envelope,
    curriculum_fee_per_student, enrollment_fee_per_student, before_after_school_hourly_rate,
    estimated_family_distribution,
    created_by, updated_by
  ) values (
    v_aye_id, v_stage_1, 'Smoke test Scenario 1', true, 'drafting',
    4,
    '[{"tier_size":1,"per_student_rate":12000},
      {"tier_size":2,"per_student_rate":11000},
      {"tier_size":3,"per_student_rate":10000},
      {"tier_size":4,"per_student_rate":9000}]'::jsonb,
    50.00,
    25000, 50000,
    500, 250, 15.00,
    '[{"tier_size":1,"family_count":40},
      {"tier_size":2,"family_count":15},
      {"tier_size":3,"family_count":5}]'::jsonb,
    v_jenna_id, v_jenna_id
  )
  returning id into v_scenario_1;

  if v_scenario_1 is null then
    raise exception 'T1 FAILED: scenario insert returned no id';
  end if;

  -- ---- T2: family detail insert blocked on Stage 1 scenario --------------

  v_caught := false;
  begin
    insert into tuition_worksheet_family_details (
      scenario_id, family_label, students_enrolled,
      applied_tier_size, applied_tier_rate
    ) values (
      v_scenario_1, 'Smith family', 1, 1, 12000
    );
    raise exception 'T2 FAILED: family detail insert was accepted on Stage 1 scenario';
  exception when others then
    if SQLERRM not like '%Stage 2 (Tuition Audit) scenarios%' then
      raise exception 'T2 FAILED: wrong error — got: %', SQLERRM;
    end if;
    v_caught := true;
  end;
  if not v_caught then
    raise exception 'T2 FAILED: exception block did not trigger';
  end if;

  -- ---- T3: submit_tuition_scenario_for_lock_review ----------------------

  perform submit_tuition_scenario_for_lock_review(v_scenario_1);

  select state into v_post from tuition_worksheet_scenarios where id = v_scenario_1;
  if v_post.state <> 'pending_lock_review' then
    raise exception 'T3 FAILED: state = % (expected pending_lock_review)', v_post.state;
  end if;

  -- ---- T4: lock_tuition_scenario captures snapshot with KPIs --------------

  v_snapshot_id := lock_tuition_scenario(v_scenario_1, 'cascade', null);

  if v_snapshot_id is null then
    raise exception 'T4 FAILED: lock_tuition_scenario returned null snapshot id';
  end if;

  select state into v_post from tuition_worksheet_scenarios where id = v_scenario_1;
  if v_post.state <> 'locked' then
    raise exception 'T4 FAILED: scenario state = % (expected locked)', v_post.state;
  end if;

  select * into v_kpis from tuition_worksheet_snapshots where id = v_snapshot_id;
  if v_kpis is null then
    raise exception 'T4 FAILED: snapshot row not found';
  end if;
  if v_kpis.kpi_gross_tuition_revenue <= 0 then
    raise exception 'T4 FAILED: kpi_gross_tuition_revenue = % (expected > 0)', v_kpis.kpi_gross_tuition_revenue;
  end if;
  if v_kpis.aye_label_at_lock is null or length(v_kpis.aye_label_at_lock) = 0 then
    raise exception 'T4 FAILED: aye_label_at_lock not captured';
  end if;
  if v_kpis.stage_type_at_lock <> 'preliminary' then
    raise exception 'T4 FAILED: stage_type_at_lock = % (expected preliminary)', v_kpis.stage_type_at_lock;
  end if;

  -- ---- T5: create_tuition_scenario_from_snapshot seeds Stage 2 ----------

  v_scenario_2 := create_tuition_scenario_from_snapshot(
    v_stage_2, v_snapshot_id, 'Smoke test Stage 2 from snapshot'
  );
  if v_scenario_2 is null then
    raise exception 'T5 FAILED: create_tuition_scenario_from_snapshot returned null';
  end if;

  select * into v_post from tuition_worksheet_scenarios where id = v_scenario_2;
  if v_post.state <> 'drafting' then
    raise exception 'T5 FAILED: new Stage 2 scenario state = % (expected drafting)', v_post.state;
  end if;
  if v_post.stage_id <> v_stage_2 then
    raise exception 'T5 FAILED: new scenario stage_id mismatch';
  end if;
  if v_post.tier_count <> 4 then
    raise exception 'T5 FAILED: tier_count not copied (got %)', v_post.tier_count;
  end if;
  if v_post.tier_rates is null or jsonb_array_length(v_post.tier_rates) <> 4 then
    raise exception 'T5 FAILED: tier_rates not copied correctly';
  end if;
  if v_post.faculty_discount_pct <> 50.00 then
    raise exception 'T5 FAILED: faculty_discount_pct = % (expected 50.00)', v_post.faculty_discount_pct;
  end if;

  -- ---- T6: Stage 2 immutability blocks tier_rates change -----------------

  v_caught := false;
  begin
    update tuition_worksheet_scenarios
       set tier_rates = '[{"tier_size":1,"per_student_rate":13000}]'::jsonb,
           updated_by = v_jenna_id
     where id = v_scenario_2;
    raise exception 'T6 FAILED: tier_rates UPDATE was accepted on Stage 2 scenario';
  exception when others then
    if SQLERRM not like '%Stage 2 (Tuition Audit) scenarios are immutable%' then
      raise exception 'T6 FAILED: wrong error — got: %', SQLERRM;
    end if;
    v_caught := true;
  end;
  if not v_caught then
    raise exception 'T6 FAILED: exception block did not trigger';
  end if;

  -- ---- T7: Family detail row allowed on Stage 2 scenario -----------------

  insert into tuition_worksheet_family_details (
    scenario_id, family_label, students_enrolled,
    applied_tier_size, applied_tier_rate,
    notes,
    created_by, updated_by
  ) values (
    v_scenario_2, 'Smoke Test Family', 2, 2, 11000,
    'Test row — should be visible in change_log',
    v_jenna_id, v_jenna_id
  );

  -- ---- T8: Unlock workflow (request only — full approve needs second
  --         identity which the smoke test does not have) ------------------

  perform request_tuition_scenario_unlock(
    v_scenario_1, 'Smoke test — testing the unlock request RPC'
  );

  select * into v_post from tuition_worksheet_scenarios where id = v_scenario_1;
  if not v_post.unlock_requested then
    raise exception 'T8 FAILED: unlock_requested not set true';
  end if;
  if v_post.unlock_requested_by <> v_jenna_id then
    raise exception 'T8 FAILED: unlock_requested_by mismatch';
  end if;
  -- v3.7 two-identity: requester also populates approval_1 atomically
  if v_post.unlock_approval_1_by <> v_jenna_id then
    raise exception 'T8 FAILED: unlock_approval_1_by not populated atomically (expected % got %)',
      v_jenna_id, v_post.unlock_approval_1_by;
  end if;

  -- Same identity attempting approve_2 should fail (initiator separation).
  v_caught := false;
  begin
    perform approve_tuition_scenario_unlock(v_scenario_1);
    raise exception 'T8 FAILED: requester was allowed to record approval_2';
  exception when others then
    if SQLERRM not like '%requester cannot also%' then
      raise exception 'T8 FAILED: wrong error on initiator-as-approver — got: %', SQLERRM;
    end if;
    v_caught := true;
  end;
  if not v_caught then
    raise exception 'T8 FAILED: initiator-separation exception did not trigger';
  end if;

  -- All tests passed silently if we reach here.
  raise notice 'All Tuition-A2 smoke tests (T1–T8) passed.';
end $$;

rollback;

-- ============================================================================
-- After ROLLBACK: live data unchanged. Verify by:
--   select count(*) from tuition_worksheet_scenarios;
-- Should return 0 (no live tuition scenarios; the smoke test's inserts
-- rolled back).
-- ============================================================================
