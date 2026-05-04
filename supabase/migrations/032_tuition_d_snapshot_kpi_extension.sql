-- ============================================================================
-- Migration 032: Tuition-D — snapshot KPI extension + comparator capture
--
-- v3.8.10. Tuition-D ships the Stage 1 lock workflow end-to-end. The
-- two decision-support KPIs introduced in Tuition-C (Net Education
-- Program Ratio, Breakeven Enrollment) compute client-side during
-- drafting via tuitionMath.js, but at lock time they must be captured
-- into the snapshot so locked-state renders never recompute from live
-- data per §5.1's binding rule.
--
-- Three changes in this migration:
--
--   1. Add three columns to tuition_worksheet_snapshots:
--        - kpi_breakeven_enrollment             int
--        - kpi_net_education_program_ratio      numeric(8,5)
--          (5-decimal precision so 102.347% round-trips cleanly)
--        - expense_comparator_amount_at_lock    numeric(12,2)
--          (the expense figure the ratio + breakeven were measured
--           against; captured so the snapshot is self-contained for
--           audit replay — without it a reader cannot reconstruct
--           why the ratio reads 102.3% on a particular date)
--        - expense_comparator_source_label_at_lock text
--          (e.g. "AYE 2025 Final Budget" or "Manual estimate"; the
--           human-readable provenance of the comparator)
--
--      All four nullable. Stage 1 snapshots populate them; future
--      Stage 2 snapshots may or may not (Stage 2 likely uses
--      different decision KPIs).
--
--   2. Extend compute_tuition_scenario_kpis to compute the two new
--      KPIs alongside the existing nine. New OUT columns appended at
--      the end so existing callers who SELECT * still work; callers
--      that named columns (lock_tuition_scenario does this) get
--      updated in this migration too.
--
--      Math mirrors src/lib/tuitionMath.js:
--        net_ratio = net_education_program_revenue / expense_comparator
--        breakeven = ceil((expense_comparator + fixed_envelopes) /
--                         (blended_avg_per_student + per_student_fees + ba_per_student))
--
--      The function reads expense_comparator_amount from the scenario
--      row directly. When the column is NULL (no comparator selected
--      yet), both KPIs return NULL — Stage 1 may legitimately be
--      locked without a comparator, and the snapshot honestly records
--      that absence.
--
--   3. Update lock_tuition_scenario to:
--        - SELECT the two new KPI columns from the extended function
--        - INSERT them into the snapshot
--        - INSERT expense_comparator_amount + source_label as captured
--          values
--
-- Hybrid KPI computation discipline:
--   - Drafting:   client-side via tuitionMath.js for instant feedback
--                  during scenario iteration (sidebar updates as the
--                  user types). Round-trip cost would be unacceptable
--                  here.
--   - Lock time:  server-side via this RPC for snapshot fidelity. A
--                  single transactional capture ensures the locked
--                  artifact's KPIs cannot drift from the locked
--                  configuration even if tuitionMath.js evolves.
--
-- Architecture references: §5.1 (snapshot binding rule), §7.3
-- (Tuition Stage 1 KPIs), Migration 024 (lock RPC and prior KPI
-- function), Migration 029 (expense_comparator_* columns on the
-- scenario row).
-- ============================================================================


-- ---- 1. Add new snapshot columns -----------------------------------------
--
-- All nullable; existing locked snapshots (probably zero in production
-- at AYE 2026 ship time, but the schema accommodates them) keep
-- getting NULL for these fields — a pre-Tuition-D lock genuinely had
-- no comparator-driven KPIs captured.

alter table tuition_worksheet_snapshots
  add column kpi_breakeven_enrollment              int,
  add column kpi_net_education_program_ratio       numeric(8,5),
  add column expense_comparator_amount_at_lock     numeric(12,2),
  add column expense_comparator_source_label_at_lock text;


-- ---- 2. Extend compute_tuition_scenario_kpis -----------------------------
--
-- Two new OUT columns at the end. Math is deterministic and pure;
-- mirrors src/lib/tuitionMath.js's computeNetEdProgramRatio and
-- computeBreakevenEnrollment.
--
-- Helper subquery: reads expense_comparator_amount from the scenario
-- row. NULL means "no comparator" → both KPIs NULL.

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
  net_education_program_revenue  numeric,
  -- v3.8.10 (Tuition-D) additions:
  net_education_program_ratio    numeric,
  breakeven_enrollment           int
)
language plpgsql stable
set search_path = public
as $$
declare
  v_scenario        record;
  v_stage_type      text;
  v_tier_1_rate     numeric := 0;
  v_total_students  int := 0;
  -- Aggregates (carried over from Migration 024)
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
  v_net_revenue     numeric;
  -- v3.8.10 additions
  v_comparator      numeric;
  v_blended_avg     numeric;
  v_per_stu_fees    numeric;
  v_ba_per_student  numeric;
  v_fixed_envelopes numeric;
  v_denom           numeric;
  v_ratio           numeric;
  v_breakeven       int;
begin
  select * into v_scenario from tuition_worksheet_scenarios where id = p_scenario_id;
  if v_scenario is null then
    raise exception 'Scenario % not found for KPI computation', p_scenario_id;
  end if;

  select stage_type into v_stage_type
    from module_workflow_stages where id = v_scenario.stage_id;

  -- Tier 1 (single-student) rate from tier_rates jsonb.
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
    v_dist := coalesce(v_scenario.estimated_family_distribution, '[]'::jsonb);
    for v_dist_item in select * from jsonb_array_elements(v_dist) loop
      v_tier_size    := (v_dist_item->>'tier_size')::int;
      v_family_count := coalesce((v_dist_item->>'family_count')::int, 0);

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

    v_faculty_disc := v_scenario.faculty_discount_pct / 100.0 * v_gross;
    v_other_disc   := v_scenario.other_discount_envelope;
    v_fa_total     := v_scenario.financial_aid_envelope;

    v_curr_fee   := v_total_students * v_scenario.curriculum_fee_per_student;
    v_enroll_fee := v_total_students * v_scenario.enrollment_fee_per_student;

    -- v3.8.10: Stage 1 B&A revenue projection — projected_b_a_hours
    -- × hourly_rate (when set; null hours → 0 contribution). Migration
    -- 024 hardcoded 0 here; with the projected_b_a_hours column from
    -- Migration 028 we can compute the same projection the client
    -- shows in the sidebar.
    v_ba_revenue := coalesce(v_scenario.projected_b_a_hours, 0)
                    * v_scenario.before_after_school_hourly_rate;
  end if;

  -- Net Education Program Revenue (carried over from Migration 024).
  v_net_revenue := (v_gross - v_multi_disc - v_faculty_disc - v_other_disc - v_fa_total)
                   + v_curr_fee + v_enroll_fee + v_ba_revenue;

  -- ----- v3.8.10 additions: ratio + breakeven ------------------------------
  --
  -- Both KPIs depend on expense_comparator_amount on the scenario
  -- row. When NULL (user has not yet picked a comparator), both
  -- return NULL — locked snapshot honestly records the absence.
  v_comparator := v_scenario.expense_comparator_amount;

  if v_comparator is null or v_comparator <= 0 then
    v_ratio := null;
    v_breakeven := null;
  else
    -- Net Education Program Ratio: net revenue / comparator.
    v_ratio := v_net_revenue / v_comparator;

    -- Breakeven Enrollment: forward-solve assuming current breakdown
    -- holds as enrollment scales. Mirrors tuitionMath.computeBreakeven
    -- Enrollment.
    --
    -- Requires total_students > 0 to derive per-student rates.
    if v_total_students is null or v_total_students <= 0 then
      v_breakeven := null;
    else
      -- Blended average per-student rate = (gross_tuition − multi_student_discount) / N
      -- Equivalent to the tier-blended tuition divided by N.
      v_blended_avg := (v_gross - v_multi_disc) / v_total_students;

      v_per_stu_fees := coalesce(v_scenario.curriculum_fee_per_student, 0)
                        + coalesce(v_scenario.enrollment_fee_per_student, 0);

      v_ba_per_student := v_ba_revenue / v_total_students;

      v_denom := v_blended_avg + v_per_stu_fees + v_ba_per_student;

      if v_denom <= 0 then
        v_breakeven := null;
      else
        v_fixed_envelopes := coalesce(v_faculty_disc, 0)
                             + coalesce(v_other_disc, 0)
                             + coalesce(v_fa_total, 0);
        v_breakeven := ceil((v_comparator + v_fixed_envelopes) / v_denom)::int;
      end if;
    end if;
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
    v_net_revenue,
    v_ratio,
    v_breakeven;
end;
$$;

grant execute on function compute_tuition_scenario_kpis(uuid) to authenticated;


-- ---- 3. Update lock_tuition_scenario -------------------------------------
--
-- Rewritten to capture the two new KPIs and the comparator metadata
-- alongside the existing fields. All other behavior preserved
-- verbatim from Migration 024 (state checks, locked_via validation,
-- override justification, snapshot family details for Stage 2,
-- final state flip).

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

  if p_locked_via not in ('cascade', 'override') then
    raise exception 'locked_via must be ''cascade'' or ''override''; got %', p_locked_via;
  end if;
  if p_locked_via = 'override' and (p_override_justification is null or length(trim(p_override_justification)) = 0) then
    raise exception 'Override requires a non-empty justification';
  end if;

  select s.display_name, s.short_name, s.stage_type
    into v_stage
    from module_workflow_stages s
   where s.id = v_scenario.stage_id;
  if v_stage is null then
    raise exception 'Stage % referenced by scenario % not found', v_scenario.stage_id, p_scenario_id;
  end if;

  select label into v_aye
    from academic_years where id = v_scenario.aye_id;
  if v_aye is null then
    raise exception 'AYE % referenced by scenario % not found', v_scenario.aye_id, p_scenario_id;
  end if;

  select coalesce(full_name, '')
    into v_locker_name
    from user_profiles where id = v_caller;
  if v_locker_name is null or length(v_locker_name) = 0 then
    v_locker_name := 'Unknown user';
  end if;

  -- KPI capture (extended in v3.8.10 with ratio + breakeven).
  select * into v_kpis from compute_tuition_scenario_kpis(p_scenario_id);

  -- Snapshot header. v3.8.10 adds four columns:
  --   - kpi_breakeven_enrollment, kpi_net_education_program_ratio
  --   - expense_comparator_amount_at_lock, expense_comparator_source_label_at_lock
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
    -- v3.8.10 additions
    kpi_net_education_program_ratio,
    kpi_breakeven_enrollment,
    expense_comparator_amount_at_lock,
    expense_comparator_source_label_at_lock,
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
    v_kpis.net_education_program_ratio,
    v_kpis.breakeven_enrollment,
    v_scenario.expense_comparator_amount,
    v_scenario.expense_comparator_source_label,
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


-- ---- 4. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 032
-- ============================================================================
