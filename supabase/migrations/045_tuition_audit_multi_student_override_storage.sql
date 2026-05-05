-- ============================================================================
-- Migration 045: Tuition Audit — Multi-Student Discount override storage (v3.8.21)
--
-- Real-data design discovery: the Multi-Student Discount column on
-- the per-family editor needs to be editable to handle one-off
-- cases where actual realized data diverges from the auto-computed
-- tier-discount math. Until v3.8.21 the column was computed-only,
-- which forced operators to absorb divergences via Notes commentary
-- or by toggling tier configuration.
--
-- v3.8.21 applies the Override-capable projection pattern (Appendix
-- C, v3.8.20) — second instance of the pattern after Faculty
-- Discount in B2a (Migration 036). Schema mechanics:
--
--   - Add column `multi_student_discount_amount numeric(12,2) NULL`
--     to tuition_worksheet_family_details. NULL = auto-compute via
--     tuitionMath.js's getFamilyMultiStudentAutoValue helper. Non-
--     null = manual override; the gold-dot indicator surfaces the
--     divergence at render time.
--
--   - Mirror the column on tuition_worksheet_snapshot_family_details
--     for snapshot fidelity per §5.1.
--
-- No backfill needed — both tables had populated rows but every row
-- has NULL for the new column (no override yet), which is the
-- correct semantic default. Existing rows continue to render the
-- auto-computed value at the table cell as they always have.
--
-- The faculty rule (Appendix C v3.8.14) is preserved unchanged:
-- faculty families always render Multi-Student Discount as $0 and
-- the cell is not editable. The new override column is consulted
-- only for non-faculty families. Toggling is_faculty_family from
-- false → true clears any prior multi_student_discount_amount
-- override on that row (same cascade contract as the
-- faculty_discount_amount cascade — see TuitionFamilyDetailsTable
-- handleToggleFaculty).
--
-- Net Tuition Rate column behavior (per design Q-cascade-1):
-- canonical tier-derived rate stays unchanged when Multi-Student
-- is overridden — the override lives on the Multi-Student column
-- ONLY. Subtotal Tuition for Year is computed in the application
-- layer as `base_rate × students_enrolled − effective_multi_student_
-- discount`, so the override flows into Subtotal and NET / YEAR
-- correctly while Net Tuition Rate display stays at the tier value.
-- The math display intentionally has a subtle inconsistency in the
-- override case: Net Tuition Rate × Enrolled does NOT equal
-- Subtotal. That's the override's signal — the operator has stated
-- "the actual subtotal isn't what tier math would produce."
--
-- Architecture cross-reference: §7.3 v3.8.21 narrative extension
-- documents the Multi-Student override capability + the cascade
-- decision. Appendix C "Override-capable projection pattern"
-- decision row gets a footnote noting v3.8.21 added Multi-Student
-- Discount as the second instance of the pattern.
-- ============================================================================


-- ---- 1. tuition_worksheet_family_details extension ----------------------

alter table tuition_worksheet_family_details
  add column multi_student_discount_amount numeric(12,2);


-- ---- 2. tuition_worksheet_snapshot_family_details extension -------------
--
-- Mirror the override column on the snapshot table per §5.1 captured-
-- by-value rule. Snapshot rows are immutable (Migration 023 trigger);
-- ALTER TABLE ADD COLUMN is DDL, not UPDATE, so it bypasses the
-- immutability guard automatically.
--
-- Future snapshot capture paths (capture_tuition_audit_snapshot from
-- M039 + lock_tuition_scenario from M034) will need to extend their
-- INSERT lists to include this new column. See Migration 045's
-- companion code change in capture_tuition_audit_snapshot for that
-- update.

alter table tuition_worksheet_snapshot_family_details
  add column multi_student_discount_amount numeric(12,2);


-- ---- 3. Extend capture_tuition_audit_snapshot to capture override -------
--
-- Per the M034 audit-discipline lesson: any future migration that
-- adds a column to a tracked table must also extend the snapshot-
-- capture path to preserve the new column at snapshot time. v3.8.21
-- closes that gap immediately by re-issuing capture_tuition_audit_
-- snapshot with the new column in its family-details INSERT.
--
-- Function signature unchanged; CREATE OR REPLACE works without
-- DROP. Body is the v3.8.17 (Migration 039) version with one added
-- column reference in the snapshot_family_details INSERT.

create or replace function capture_tuition_audit_snapshot(
  p_scenario_id    uuid,
  p_snapshot_label text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller         uuid := auth.uid();
  v_scenario       record;
  v_stage          record;
  v_aye            record;
  v_locker_name    text;
  v_snapshot_id    uuid;
  v_kpis           record;
  v_label          text;
begin
  if not current_user_has_module_perm('tuition', 'edit') then
    raise exception 'Capturing a tuition audit snapshot requires edit permission on tuition.';
  end if;

  if p_snapshot_label is null or length(trim(p_snapshot_label)) = 0 then
    raise exception 'Snapshot label is required.';
  end if;
  v_label := trim(p_snapshot_label);

  select * into v_scenario
    from tuition_worksheet_scenarios
   where id = p_scenario_id
   for update;
  if v_scenario is null then
    raise exception 'Scenario % not found.', p_scenario_id;
  end if;

  select s.display_name, s.short_name, s.stage_type
    into v_stage
    from module_workflow_stages s
   where s.id = v_scenario.stage_id;
  if v_stage is null then
    raise exception 'Stage % referenced by scenario % not found.', v_scenario.stage_id, p_scenario_id;
  end if;
  if v_stage.stage_type <> 'final' then
    raise exception
      'capture_tuition_audit_snapshot operates on Stage 2 (Tuition Audit) scenarios only. The provided scenario''s stage_type is %.',
      v_stage.stage_type;
  end if;
  if v_scenario.state <> 'drafting' then
    raise exception
      'Stage 2 scenarios should always be in drafting state under the v3.8.16 working-document model. Current state: %.',
      v_scenario.state;
  end if;

  select label into v_aye
    from academic_years where id = v_scenario.aye_id;
  if v_aye is null then
    raise exception 'AYE % referenced by scenario % not found.', v_scenario.aye_id, p_scenario_id;
  end if;

  select coalesce(full_name, '') into v_locker_name
    from user_profiles where id = v_caller;
  if v_locker_name is null or length(v_locker_name) = 0 then
    v_locker_name := 'Unknown user';
  end if;

  select * into v_kpis from compute_tuition_scenario_kpis(p_scenario_id);

  -- Snapshot header — unchanged from M039.
  insert into tuition_worksheet_snapshots (
    scenario_id, aye_id, aye_label_at_lock,
    stage_id, stage_display_name_at_lock, stage_short_name_at_lock, stage_type_at_lock,
    scenario_label_at_lock, scenario_description_at_lock,
    tier_count, tier_rates,
    faculty_discount_pct,
    projected_other_discount, projected_financial_aid,
    curriculum_fee_per_student, enrollment_fee_per_student, before_after_school_hourly_rate,
    projected_faculty_discount_amount,
    total_students, total_families, top_tier_avg_students_per_family,
    estimated_family_distribution,
    actual_before_after_school_hours,
    projected_b_a_hours,
    projected_multi_student_discount,
    expense_comparator_mode,
    expense_comparator_amount,
    expense_comparator_source_label,
    expense_comparator_amount_at_lock,
    expense_comparator_source_label_at_lock,
    kpi_gross_tuition_revenue, kpi_multi_student_discount_total,
    kpi_faculty_discount_total, kpi_other_discount_total, kpi_financial_aid_total,
    kpi_curriculum_fee_revenue, kpi_enrollment_fee_revenue, kpi_before_after_school_revenue,
    kpi_net_education_program_revenue,
    kpi_net_education_program_ratio,
    kpi_breakeven_enrollment,
    locked_at, locked_by, locked_by_name_at_lock,
    locked_via, override_justification,
    approved_by, approved_by_name_at_lock, approved_at,
    snapshot_reason, snapshot_label, captured_at
  ) values (
    p_scenario_id, v_scenario.aye_id, v_aye.label,
    v_scenario.stage_id, v_stage.display_name, v_stage.short_name, v_stage.stage_type,
    v_scenario.scenario_label, v_scenario.description,
    v_scenario.tier_count, v_scenario.tier_rates,
    v_scenario.faculty_discount_pct,
    v_scenario.projected_other_discount, v_scenario.projected_financial_aid,
    v_scenario.curriculum_fee_per_student, v_scenario.enrollment_fee_per_student, v_scenario.before_after_school_hourly_rate,
    v_scenario.projected_faculty_discount_amount,
    v_scenario.total_students, v_scenario.total_families, v_scenario.top_tier_avg_students_per_family,
    v_scenario.estimated_family_distribution,
    v_scenario.actual_before_after_school_hours,
    v_scenario.projected_b_a_hours,
    v_scenario.projected_multi_student_discount,
    v_scenario.expense_comparator_mode,
    v_scenario.expense_comparator_amount,
    v_scenario.expense_comparator_source_label,
    v_scenario.expense_comparator_amount,
    v_scenario.expense_comparator_source_label,
    v_kpis.gross_tuition_revenue, v_kpis.multi_student_discount_total,
    v_kpis.faculty_discount_total, v_kpis.other_discount_total, v_kpis.financial_aid_total,
    v_kpis.curriculum_fee_revenue, v_kpis.enrollment_fee_revenue, v_kpis.before_after_school_revenue,
    v_kpis.net_education_program_revenue,
    v_kpis.net_education_program_ratio,
    v_kpis.breakeven_enrollment,
    now(), v_caller, v_locker_name,
    'snapshot', null,
    v_caller, v_locker_name, now(),
    null,
    v_label,
    now()
  )
  returning id into v_snapshot_id;

  -- Stage 2 family_details capture — v3.8.21 adds
  -- multi_student_discount_amount to the captured columns.
  insert into tuition_worksheet_snapshot_family_details (
    snapshot_id, family_label, students_enrolled,
    applied_tier_size, applied_tier_rate,
    faculty_discount_amount, other_discount_amount, financial_aid_amount,
    notes, sort_order,
    is_faculty_family, date_enrolled, date_withdrawn,
    -- v3.8.21 addition
    multi_student_discount_amount
  )
  select v_snapshot_id, fd.family_label, fd.students_enrolled,
         fd.applied_tier_size, fd.applied_tier_rate,
         fd.faculty_discount_amount, fd.other_discount_amount, fd.financial_aid_amount,
         fd.notes,
         row_number() over (order by fd.is_faculty_family desc, fd.family_label, fd.id),
         fd.is_faculty_family, fd.date_enrolled, fd.date_withdrawn,
         fd.multi_student_discount_amount
    from tuition_worksheet_family_details fd
   where fd.scenario_id = p_scenario_id;

  -- Synthetic change_log row pointed at the scenario for Recent
  -- Activity (unchanged from M039).
  insert into change_log (
    target_table, target_id, field_name,
    old_value, new_value,
    changed_by, changed_at, reason
  ) values (
    'tuition_worksheet_scenarios',
    p_scenario_id,
    '__snapshot_captured__',
    null,
    jsonb_build_object(
      'snapshot_id', v_snapshot_id,
      'label',       v_label,
      'captured_at', now()
    ),
    v_caller,
    now(),
    'snapshot_captured: ' || v_label
  );

  return v_snapshot_id;
end;
$$;

grant execute on function capture_tuition_audit_snapshot(uuid, text) to authenticated;


-- ---- 4. PostgREST schema cache reload -----------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 045
-- ============================================================================
