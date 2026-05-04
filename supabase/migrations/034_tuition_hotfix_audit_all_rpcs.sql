-- ============================================================================
-- Migration 034: Tuition RPC audit pass — fix lock_tuition_scenario (v3.8.12)
--
-- After Migration 033 fixed the read path (compute_tuition_scenario_kpis),
-- the first live Approve-and-lock attempt failed with:
--   ERROR:  column "other_discount_envelope" of relation
--           "tuition_worksheet_snapshots" does not exist
--
-- Same root cause as Migration 033: Migration 032 (Tuition-D) rewrote
-- lock_tuition_scenario based on Migration 024's pre-B1.1 baseline
-- rather than the current Migration 029 definition. The rewrite lost
-- the column renames AND eight columns added by Migrations 027/028/029
-- to the snapshot table that were being captured-by-value at lock time
-- (per §5.1).
--
-- Rather than fix lock_tuition_scenario alone and risk another hotfix
-- cycle, this migration audits every PL/pgSQL function in the tuition
-- workflow against the current schema. Audit deliverable below.
--
-- ============================================================================
-- AUDIT SUMMARY
-- ============================================================================
--
-- Functions audited (8 total):
--
--   1. compute_tuition_scenario_kpis
--      Latest definition: Migration 033 (yesterday's hotfix)
--      Status: CLEAN. All v_scenario.* references match current schema:
--        stage_id, tier_rates, curriculum_fee_per_student,
--        enrollment_fee_per_student, actual_before_after_school_hours,
--        before_after_school_hourly_rate, total_students,
--        estimated_family_distribution, projected_faculty_discount_amount,
--        projected_other_discount, projected_financial_aid,
--        projected_b_a_hours, expense_comparator_amount.
--      No changes needed. Migration 033 fix verified intact.
--
--   2. lock_tuition_scenario
--      Latest definition: Migration 032 (broken)
--      Status: BROKEN — comprehensive rewrite required.
--      Stale column references in INSERT into tuition_worksheet_snapshots:
--        other_discount_envelope  → projected_other_discount    (M027 rename)
--        financial_aid_envelope   → projected_financial_aid      (M027 rename)
--      Missing snapshot columns that are captured-by-value per §5.1
--      and existed on the snapshot table when M032 was written:
--        projected_faculty_discount_amount       (M027 added on snapshot)
--        total_students                          (M027 added on snapshot)
--        total_families                          (M027 added on snapshot)
--        top_tier_avg_students_per_family        (M027 added on snapshot)
--        projected_b_a_hours                     (M028 added on snapshot)
--        projected_multi_student_discount        (M028 added on snapshot)
--        expense_comparator_mode                 (M029 added on snapshot)
--        expense_comparator_amount               (M029 added on snapshot)
--        expense_comparator_source_label         (M029 added on snapshot)
--      Preserved from Migration 032 (v3.8.10 additions, kept):
--        kpi_breakeven_enrollment
--        kpi_net_education_program_ratio
--        expense_comparator_amount_at_lock
--        expense_comparator_source_label_at_lock
--      Note: the snapshot has BOTH expense_comparator_amount (M029) AND
--      expense_comparator_amount_at_lock (M032) columns — same for
--      source_label. M029 mirrored without the _at_lock suffix
--      (following the M023 same-name-as-source pattern); M032 added
--      _at_lock variants without realizing the M029 columns existed.
--      Both columns exist; both are nullable. The fix populates BOTH
--      with the same value for backward compatibility — neither has
--      ever been populated in production (no successful Tuition lock
--      has happened yet), so this establishes the precedent.
--
--   3. submit_tuition_scenario_for_lock_review
--      Latest definition: Migration 024
--      Status: CLEAN. References v_scenario.state, v_scenario.is_recommended,
--      v_scenario.aye_id, v_scenario.stage_id, v_scenario.scenario_label —
--      all extant columns. No changes needed.
--
--   4. reject_tuition_scenario_lock
--      Latest definition: Migration 024
--      Status: CLEAN. References v_scenario.state only. No changes needed.
--
--   5. request_tuition_scenario_unlock
--      Latest definition: Migration 025
--      Status: CLEAN. References v_scenario.state, v_scenario.unlock_requested,
--      and the unlock_* update set — all extant columns.
--
--   6. approve_tuition_scenario_unlock
--      Latest definition: Migration 025
--      Status: CLEAN. References v_scenario.state, v_scenario.unlock_requested,
--      v_scenario.unlock_requested_by, v_scenario.unlock_approval_2_at —
--      all extant columns.
--
--   7. reject_tuition_scenario_unlock
--      Latest definition: Migration 025
--      Status: CLEAN. References v_scenario.state, v_scenario.unlock_requested,
--      v_scenario.unlock_requested_by — all extant columns.
--
--   8. create_tuition_scenario_from_snapshot
--      Latest definition: Migration 029
--      Status: CLEAN. SELECT and INSERT lists both reference correctly-renamed
--      columns and include all M027/M028/M029 additions:
--        From snapshot: tier_count, tier_rates, faculty_discount_pct,
--          projected_faculty_discount_amount, projected_other_discount,
--          projected_financial_aid, curriculum_fee_per_student,
--          enrollment_fee_per_student, before_after_school_hourly_rate,
--          estimated_family_distribution, total_students, total_families,
--          top_tier_avg_students_per_family, projected_b_a_hours,
--          projected_multi_student_discount, expense_comparator_mode,
--          expense_comparator_amount, expense_comparator_source_label.
--      No changes needed. (M032 did not rewrite this function — it
--      escaped the M032 reset-to-stale-baseline bug.)
--
-- ============================================================================
-- LESSON CAPTURED
--
-- The pattern that produced this bug: when a future migration rewrites a
-- function via CREATE OR REPLACE, the author must read the CURRENT
-- function body (e.g., from pg_get_functiondef() or the most-recent
-- migration that touched it) — not an older migration. Migration 032
-- copied compute_tuition_scenario_kpis AND lock_tuition_scenario from
-- Migration 024's text, missing all of M027/M028/M029's intervening
-- updates. compute_tuition_scenario_kpis was caught in M033; this
-- migration catches lock_tuition_scenario.
--
-- create_tuition_scenario_from_snapshot escaped the bug only because
-- M032 didn't rewrite it. The two fragile functions share a property
-- — both have INSERT lists that need to enumerate every snapshot
-- column — but the audit confirms only lock_tuition_scenario is
-- currently broken.
--
-- Future safeguard: any migration that rewrites a tuition (or budget)
-- RPC body should grep the CURRENT schema for column references rather
-- than copying from an older migration. The audit habit established
-- here is the safeguard until automated test coverage exists.
--
-- ============================================================================


-- ---- Single CREATE OR REPLACE: lock_tuition_scenario --------------------
--
-- Function signature, return type, language, security mode, and
-- search_path settings unchanged from Migration 032. Only the INSERT
-- column list and corresponding VALUES list are corrected.
--
-- Return type unchanged → CREATE OR REPLACE works without DROP.

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

  -- Locker / approver display name. SECURITY DEFINER bypasses RLS.
  select coalesce(full_name, '')
    into v_locker_name
    from user_profiles where id = v_caller;
  if v_locker_name is null or length(v_locker_name) = 0 then
    v_locker_name := 'Unknown user';
  end if;

  -- KPI capture (11 KPIs as of Migration 033).
  select * into v_kpis from compute_tuition_scenario_kpis(p_scenario_id);

  -- Snapshot header. Comprehensive INSERT covering every captured-by-
  -- value column on tuition_worksheet_snapshots, organized by schema-
  -- evolution era for review clarity.
  insert into tuition_worksheet_snapshots (
    -- Identity + provenance
    scenario_id, aye_id, aye_label_at_lock,
    stage_id, stage_display_name_at_lock, stage_short_name_at_lock, stage_type_at_lock,
    scenario_label_at_lock, scenario_description_at_lock,
    -- Tier configuration (M023 base; M031 added discount_pct inside the jsonb)
    tier_count, tier_rates,
    -- Discount / fee configuration
    -- M023 base columns (with M027 renames applied)
    faculty_discount_pct,
    projected_other_discount, projected_financial_aid,
    curriculum_fee_per_student, enrollment_fee_per_student, before_after_school_hourly_rate,
    -- M027 additions
    projected_faculty_discount_amount,
    total_students, total_families, top_tier_avg_students_per_family,
    -- Projection inputs
    estimated_family_distribution,
    actual_before_after_school_hours,
    -- M028 additions (projected B&A hours; persisted multi-student discount)
    projected_b_a_hours,
    projected_multi_student_discount,
    -- M029 additions (expense comparator state mirrored on snapshot —
    -- canonical naming follows M023's same-name-as-source pattern)
    expense_comparator_mode,
    expense_comparator_amount,
    expense_comparator_source_label,
    -- M032 additions: _at_lock variants of comparator (parallel-named
    -- captured-by-value columns; both populated for backward compat
    -- since both exist on the schema and neither has ever been
    -- populated in production yet)
    expense_comparator_amount_at_lock,
    expense_comparator_source_label_at_lock,
    -- KPIs (9 from M023; 2 added in M032)
    kpi_gross_tuition_revenue, kpi_multi_student_discount_total,
    kpi_faculty_discount_total, kpi_other_discount_total, kpi_financial_aid_total,
    kpi_curriculum_fee_revenue, kpi_enrollment_fee_revenue, kpi_before_after_school_revenue,
    kpi_net_education_program_revenue,
    kpi_net_education_program_ratio,
    kpi_breakeven_enrollment,
    -- Lock metadata (M023 base)
    locked_at, locked_by, locked_by_name_at_lock,
    locked_via, override_justification,
    approved_by, approved_by_name_at_lock, approved_at
  ) values (
    -- Identity + provenance
    p_scenario_id, v_scenario.aye_id, v_aye.label,
    v_scenario.stage_id, v_stage.display_name, v_stage.short_name, v_stage.stage_type,
    v_scenario.scenario_label, v_scenario.description,
    -- Tier configuration
    v_scenario.tier_count, v_scenario.tier_rates,
    -- Discount / fee configuration (renamed columns)
    v_scenario.faculty_discount_pct,
    v_scenario.projected_other_discount, v_scenario.projected_financial_aid,
    v_scenario.curriculum_fee_per_student, v_scenario.enrollment_fee_per_student, v_scenario.before_after_school_hourly_rate,
    -- M027 additions
    v_scenario.projected_faculty_discount_amount,
    v_scenario.total_students, v_scenario.total_families, v_scenario.top_tier_avg_students_per_family,
    -- Projection inputs
    v_scenario.estimated_family_distribution,
    v_scenario.actual_before_after_school_hours,
    -- M028 additions
    v_scenario.projected_b_a_hours,
    v_scenario.projected_multi_student_discount,
    -- M029 additions (mirror of scenario columns)
    v_scenario.expense_comparator_mode,
    v_scenario.expense_comparator_amount,
    v_scenario.expense_comparator_source_label,
    -- M032 _at_lock variants (same source values; redundant but both
    -- columns exist)
    v_scenario.expense_comparator_amount,
    v_scenario.expense_comparator_source_label,
    -- KPIs
    v_kpis.gross_tuition_revenue, v_kpis.multi_student_discount_total,
    v_kpis.faculty_discount_total, v_kpis.other_discount_total, v_kpis.financial_aid_total,
    v_kpis.curriculum_fee_revenue, v_kpis.enrollment_fee_revenue, v_kpis.before_after_school_revenue,
    v_kpis.net_education_program_revenue,
    v_kpis.net_education_program_ratio,
    v_kpis.breakeven_enrollment,
    -- Lock metadata
    now(), v_caller, v_locker_name,
    p_locked_via,
    case when p_locked_via = 'override' then trim(p_override_justification) else null end,
    v_caller, v_locker_name, now()
  )
  returning id into v_snapshot_id;

  -- Stage 2 only: copy per-family detail rows into snapshot.
  -- (Unchanged from Migration 032 — no audit findings on this branch.)
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

  -- Flip scenario state. (Unchanged from Migration 032.)
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


-- ---- PostgREST schema cache reload ---------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 034
-- ============================================================================
