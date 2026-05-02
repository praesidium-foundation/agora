-- ============================================================================
-- Migration 024: Tuition Worksheet lock workflow RPCs
--
-- Tuition-A2 (v3.8.1). Three SECURITY DEFINER functions implementing
-- the lock workflow for the Tuition module. Parallel to Budget's
-- Migration 012 in shape, but Tuition's RPC surface is broader: Budget
-- handles submit-for-review and reject via direct client UPDATEs from
-- src/lib/budgetLock.js, while Tuition gets dedicated RPCs for both
-- transitions. This is a stricter pattern (server-side authorization
-- on the state transition) and is appropriate for a module whose lock
-- triggers downstream contractual commitments to families.
--
-- Cross-module cascade (per §7.5) is NOT enforced inside lock_tuition_
-- scenario in this migration. The Tuition module has no upstream
-- modules in the current Libertas configuration; cascade enforcement
-- becomes relevant when Budget's lock function gates on Tuition Stage
-- 1 lock state, which is a follow-up commit per the prompt.
--
-- KPI computation function compute_tuition_scenario_kpis is included
-- here (used by lock_tuition_scenario for snapshot capture; eventually
-- usable by the live KPI sidebar in Tuition-B). Math is deterministic:
-- same inputs always produce same outputs.
--
-- app.change_reason discipline: lock_tuition_scenario does NOT set
-- app.change_reason (mirrors lock_budget_stage_scenario from Migration
-- 012 — relies on natural diff capture by tg_log_changes when state
-- transitions to 'locked'). submit and reject set explicit reasons
-- so the audit feed can recognize the workflow events.
-- ============================================================================


-- ---- 1. compute_tuition_scenario_kpis ------------------------------------
--
-- Pure function (stable + read-only) computing the nine KPIs from the
-- scenario's configuration plus (if Stage 2) family detail rows.
-- Returns one row whose columns match the kpi_* fields on
-- tuition_worksheet_snapshots.
--
-- Stage 1 (preliminary): KPIs derived from estimated_family_distribution
-- and the discount envelopes. The envelopes are taken at face value
-- (Stage 1 expects to spend the full envelope); the multi-student
-- discount is computed by walking the projected family distribution
-- and comparing to the Tier 1 (single-student) rate.
--
-- Stage 2 (final): KPIs derived from family_details rows with their
-- per-family discount allocations. Multi-student discount is the
-- difference between Tier 1 rate × students vs. applied_tier_rate ×
-- students. Per-family Faculty / Other / FA amounts sum to the
-- respective totals (NULLs treated as 0). B&A revenue uses the
-- actual_before_after_school_hours field; Stage 1 uses 0 (or could
-- use a projection in a future enhancement).

create or replace function compute_tuition_scenario_kpis(p_scenario_id uuid)
returns table (
  gross_tuition_revenue          numeric,
  multi_student_discount_total   numeric,
  faculty_discount_total         numeric,
  other_discount_total           numeric,
  financial_aid_total            numeric,
  curriculum_fee_revenue         numeric,
  enrollment_fee_revenue         numeric,
  before_after_school_revenue    numeric,
  net_education_program_revenue  numeric
)
language plpgsql stable
set search_path = public
as $$
declare
  v_scenario        record;
  v_stage_type      text;
  v_tier_1_rate     numeric := 0;
  v_total_students  int := 0;
  -- Aggregates
  v_gross           numeric := 0;
  v_multi_disc      numeric := 0;
  v_faculty_disc    numeric := 0;
  v_other_disc      numeric := 0;
  v_fa_total        numeric := 0;
  v_curr_fee        numeric := 0;
  v_enroll_fee      numeric := 0;
  v_ba_revenue      numeric := 0;
  v_dist            jsonb;
  v_dist_item       jsonb;
  v_tier_size       int;
  v_family_count    int;
  v_per_student     numeric;
begin
  select * into v_scenario from tuition_worksheet_scenarios where id = p_scenario_id;
  if v_scenario is null then
    raise exception 'Scenario % not found for KPI computation', p_scenario_id;
  end if;

  select stage_type into v_stage_type
    from module_workflow_stages where id = v_scenario.stage_id;

  -- Tier 1 (single-student) rate from tier_rates jsonb. Used as the
  -- "gross" reference rate for computing the multi-student discount.
  -- tier_rates shape: [{tier_size: int, per_student_rate: numeric}, ...]
  select coalesce(
    (select (item->>'per_student_rate')::numeric
       from jsonb_array_elements(v_scenario.tier_rates) item
      where (item->>'tier_size')::int = 1
      limit 1),
    0
  ) into v_tier_1_rate;

  if v_stage_type = 'final' then
    -- ----- Stage 2: walk family_details rows --------------------------------
    select
      coalesce(sum(fd.students_enrolled * v_tier_1_rate), 0),
      coalesce(sum((v_tier_1_rate - fd.applied_tier_rate) * fd.students_enrolled), 0),
      coalesce(sum(fd.students_enrolled), 0),
      coalesce(sum(coalesce(fd.faculty_discount_amount, 0)), 0),
      coalesce(sum(coalesce(fd.other_discount_amount, 0)), 0),
      coalesce(sum(coalesce(fd.financial_aid_amount, 0)), 0)
      into v_gross, v_multi_disc, v_total_students,
           v_faculty_disc, v_other_disc, v_fa_total
      from tuition_worksheet_family_details fd
     where fd.scenario_id = p_scenario_id;

    v_curr_fee   := v_total_students * v_scenario.curriculum_fee_per_student;
    v_enroll_fee := v_total_students * v_scenario.enrollment_fee_per_student;
    v_ba_revenue := coalesce(v_scenario.actual_before_after_school_hours, 0)
                    * v_scenario.before_after_school_hourly_rate;

  else
    -- ----- Stage 1: walk estimated_family_distribution ----------------------
    --
    -- For each {tier_size, family_count} entry, look up the per-student
    -- rate in tier_rates and accumulate. Gross = full Tier 1 rate × all
    -- students; multi-student discount = (Tier 1 rate - applied tier
    -- rate) × students at that tier × family_count.
    --
    -- For Stage 1 the discount totals come from the envelopes at face
    -- value (the budget the board approved); per-family allocation
    -- happens in Stage 2.
    v_dist := coalesce(v_scenario.estimated_family_distribution, '[]'::jsonb);
    for v_dist_item in select * from jsonb_array_elements(v_dist) loop
      v_tier_size    := (v_dist_item->>'tier_size')::int;
      v_family_count := coalesce((v_dist_item->>'family_count')::int, 0);

      -- Look up the per-student rate for this tier size.
      select coalesce(
        (select (item->>'per_student_rate')::numeric
           from jsonb_array_elements(v_scenario.tier_rates) item
          where (item->>'tier_size')::int = v_tier_size
          limit 1),
        v_tier_1_rate
      ) into v_per_student;

      v_total_students := v_total_students + (v_tier_size * v_family_count);
      v_gross          := v_gross + (v_tier_1_rate * v_tier_size * v_family_count);
      v_multi_disc     := v_multi_disc
                          + ((v_tier_1_rate - v_per_student) * v_tier_size * v_family_count);
    end loop;

    v_faculty_disc := v_scenario.faculty_discount_pct / 100.0 * v_gross;  -- rough Stage 1 projection
    v_other_disc   := v_scenario.other_discount_envelope;
    v_fa_total     := v_scenario.financial_aid_envelope;

    v_curr_fee   := v_total_students * v_scenario.curriculum_fee_per_student;
    v_enroll_fee := v_total_students * v_scenario.enrollment_fee_per_student;
    -- Stage 1 has no actual hours; B&A revenue not projected at this
    -- layer (future enhancement: take a projected-hours field).
    v_ba_revenue := 0;
  end if;

  return query select
    v_gross,
    v_multi_disc,
    v_faculty_disc,
    v_other_disc,
    v_fa_total,
    v_curr_fee,
    v_enroll_fee,
    v_ba_revenue,
    -- Net = gross - all discounts + fee revenue + B&A
    (v_gross - v_multi_disc - v_faculty_disc - v_other_disc - v_fa_total)
      + v_curr_fee + v_enroll_fee + v_ba_revenue;
end;
$$;

grant execute on function compute_tuition_scenario_kpis(uuid) to authenticated;


-- ---- 2. submit_tuition_scenario_for_lock_review --------------------------

create or replace function submit_tuition_scenario_for_lock_review(
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
  v_blocking_label text;
begin
  if not current_user_has_module_perm('tuition', 'submit_lock') then
    raise exception 'Submitting tuition for lock review requires submit_lock permission on tuition.';
  end if;

  select * into v_scenario from tuition_worksheet_scenarios
   where id = p_scenario_id for update;

  if v_scenario is null then
    raise exception 'Scenario % not found.', p_scenario_id;
  end if;
  if v_scenario.state <> 'drafting' then
    raise exception 'Scenario must be in drafting state to submit (current: %).', v_scenario.state;
  end if;
  if not v_scenario.is_recommended then
    raise exception 'Only the recommended scenario can be submitted for lock review. Mark this scenario as recommended first.';
  end if;

  -- Sibling-locked guard: redundant with the BEFORE UPDATE trigger
  -- (tg_prevent_lock_submit_while_sibling_locked_tuition) but raise
  -- explicitly here for a cleaner error message before the trigger
  -- fires.
  select scenario_label into v_blocking_label
    from tuition_worksheet_scenarios
   where aye_id = v_scenario.aye_id
     and stage_id = v_scenario.stage_id
     and id != p_scenario_id
     and state = 'locked'
   limit 1;

  if v_blocking_label is not null then
    raise exception
      'Cannot submit "%" for lock review: scenario "%" in this (AYE, stage) is currently locked. Unlock it first.',
      v_scenario.scenario_label, v_blocking_label;
  end if;

  perform set_config('app.change_reason', 'submitted_for_lock_review', true);

  update tuition_worksheet_scenarios
     set state      = 'pending_lock_review',
         updated_by = v_caller
   where id = p_scenario_id;
end;
$$;

grant execute on function submit_tuition_scenario_for_lock_review(uuid) to authenticated;


-- ---- 3. lock_tuition_scenario --------------------------------------------

create or replace function lock_tuition_scenario(
  p_scenario_id            uuid,
  p_locked_via             text default 'cascade',
  p_override_justification text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scenario     record;
  v_stage        record;
  v_aye          record;
  v_kpis         record;
  v_locker_name  text;
  v_snapshot_id  uuid;
  v_caller       uuid := auth.uid();
begin
  if not current_user_has_module_perm('tuition', 'approve_lock') then
    raise exception 'Approve-and-lock requires approve_lock permission on tuition.';
  end if;

  select * into v_scenario
    from tuition_worksheet_scenarios
   where id = p_scenario_id
   for update;

  if v_scenario is null then
    raise exception 'Scenario % not found', p_scenario_id;
  end if;
  if v_scenario.state != 'pending_lock_review' then
    raise exception 'Scenario must be in pending_lock_review state to lock (current: %)', v_scenario.state;
  end if;
  if not v_scenario.is_recommended then
    raise exception 'Only the recommended scenario can be locked. Mark this scenario as recommended first.';
  end if;

  -- locked_via enforcement at function level (no DB CHECK; mirrors
  -- budget pattern). Tuition uses 'cascade' for the normal path
  -- (cascade rules satisfied per §7.5; today this is unconditionally
  -- valid because no upstream blockers are enforced) vs. 'override'
  -- for the bypass path.
  if p_locked_via not in ('cascade', 'override') then
    raise exception 'locked_via must be ''cascade'' or ''override''; got %', p_locked_via;
  end if;
  if p_locked_via = 'override' and (p_override_justification is null or length(trim(p_override_justification)) = 0) then
    raise exception 'Override requires a non-empty justification';
  end if;

  -- Stage metadata captured by value at lock time per §5.1.
  select s.display_name, s.short_name, s.stage_type
    into v_stage
    from module_workflow_stages s
   where s.id = v_scenario.stage_id;
  if v_stage is null then
    raise exception 'Stage % referenced by scenario % not found', v_scenario.stage_id, p_scenario_id;
  end if;

  -- AYE metadata captured by value at lock time per §5.1.
  select label into v_aye
    from academic_years where id = v_scenario.aye_id;
  if v_aye is null then
    raise exception 'AYE % referenced by scenario % not found', v_scenario.aye_id, p_scenario_id;
  end if;

  -- Locker / approver display name. SECURITY DEFINER bypasses RLS;
  -- look up directly from user_profiles. ON DELETE SET NULL on
  -- locked_by + approved_by means the captured-by-value name field
  -- is the only durable identity reference.
  select coalesce(full_name, '')
    into v_locker_name
    from user_profiles where id = v_caller;
  if v_locker_name is null or length(v_locker_name) = 0 then
    v_locker_name := 'Unknown user';  -- defensive; user_profiles row should always exist for an authenticated caller
  end if;

  -- KPI capture.
  select * into v_kpis from compute_tuition_scenario_kpis(p_scenario_id);

  -- Snapshot header.
  insert into tuition_worksheet_snapshots (
    scenario_id, aye_id, aye_label_at_lock,
    stage_id, stage_display_name_at_lock, stage_short_name_at_lock, stage_type_at_lock,
    scenario_label_at_lock, scenario_description_at_lock,
    tier_count, tier_rates,
    faculty_discount_pct, other_discount_envelope, financial_aid_envelope,
    curriculum_fee_per_student, enrollment_fee_per_student, before_after_school_hourly_rate,
    estimated_family_distribution, actual_before_after_school_hours,
    kpi_gross_tuition_revenue, kpi_multi_student_discount_total,
    kpi_faculty_discount_total, kpi_other_discount_total, kpi_financial_aid_total,
    kpi_curriculum_fee_revenue, kpi_enrollment_fee_revenue, kpi_before_after_school_revenue,
    kpi_net_education_program_revenue,
    locked_at, locked_by, locked_by_name_at_lock,
    locked_via, override_justification,
    approved_by, approved_by_name_at_lock, approved_at
  ) values (
    p_scenario_id, v_scenario.aye_id, v_aye.label,
    v_scenario.stage_id, v_stage.display_name, v_stage.short_name, v_stage.stage_type,
    v_scenario.scenario_label, v_scenario.description,
    v_scenario.tier_count, v_scenario.tier_rates,
    v_scenario.faculty_discount_pct, v_scenario.other_discount_envelope, v_scenario.financial_aid_envelope,
    v_scenario.curriculum_fee_per_student, v_scenario.enrollment_fee_per_student, v_scenario.before_after_school_hourly_rate,
    v_scenario.estimated_family_distribution, v_scenario.actual_before_after_school_hours,
    v_kpis.gross_tuition_revenue, v_kpis.multi_student_discount_total,
    v_kpis.faculty_discount_total, v_kpis.other_discount_total, v_kpis.financial_aid_total,
    v_kpis.curriculum_fee_revenue, v_kpis.enrollment_fee_revenue, v_kpis.before_after_school_revenue,
    v_kpis.net_education_program_revenue,
    now(), v_caller, v_locker_name,
    p_locked_via,
    case when p_locked_via = 'override' then trim(p_override_justification) else null end,
    v_caller, v_locker_name, now()
  )
  returning id into v_snapshot_id;

  -- Stage 2 only: copy per-family detail rows into snapshot.
  if v_stage.stage_type = 'final' then
    insert into tuition_worksheet_snapshot_family_details (
      snapshot_id, family_label, students_enrolled,
      applied_tier_size, applied_tier_rate,
      faculty_discount_amount, other_discount_amount, financial_aid_amount,
      notes, sort_order
    )
    select v_snapshot_id, fd.family_label, fd.students_enrolled,
           fd.applied_tier_size, fd.applied_tier_rate,
           fd.faculty_discount_amount, fd.other_discount_amount, fd.financial_aid_amount,
           fd.notes,
           row_number() over (order by fd.family_label, fd.id)
      from tuition_worksheet_family_details fd
     where fd.scenario_id = p_scenario_id;
  end if;

  -- Flip scenario state. The change_log trigger captures the
  -- transition naturally (state goes from 'pending_lock_review' to
  -- 'locked'); no app.change_reason needed (mirrors budget lock RPC).
  update tuition_worksheet_scenarios
     set state                  = 'locked',
         locked_at              = now(),
         locked_by              = v_caller,
         locked_via             = p_locked_via,
         override_justification = case when p_locked_via = 'override' then trim(p_override_justification) else null end,
         updated_by             = v_caller
   where id = p_scenario_id;

  return v_snapshot_id;
end;
$$;

grant execute on function lock_tuition_scenario(uuid, text, text) to authenticated;


-- ---- 4. reject_tuition_scenario_lock -------------------------------------

create or replace function reject_tuition_scenario_lock(
  p_scenario_id uuid,
  p_reason      text
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
  if not current_user_has_module_perm('tuition', 'approve_lock') then
    raise exception 'Rejecting a lock review requires approve_lock permission on tuition.';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required when rejecting a lock review.';
  end if;

  select * into v_scenario from tuition_worksheet_scenarios
   where id = p_scenario_id for update;

  if v_scenario is null then
    raise exception 'Scenario % not found.', p_scenario_id;
  end if;
  if v_scenario.state <> 'pending_lock_review' then
    raise exception 'Scenario must be in pending_lock_review state to reject (current: %).', v_scenario.state;
  end if;

  perform set_config('app.change_reason', 'lock_review_rejected: ' || trim(p_reason), true);

  update tuition_worksheet_scenarios
     set state      = 'drafting',
         updated_by = v_caller
   where id = p_scenario_id;
end;
$$;

grant execute on function reject_tuition_scenario_lock(uuid, text) to authenticated;


-- ---- 5. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 024
-- ============================================================================
