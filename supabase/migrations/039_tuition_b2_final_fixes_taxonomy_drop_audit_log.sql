-- ============================================================================
-- Migration 039: Tuition-B2-final-fixes — drop snapshot reason taxonomy,
--                                          restore snapshot audit log (v3.8.17)
--
-- Two bug-class fixes packaged together:
--
--   1. Taxonomy drop. Migration 038 introduced a fixed snapshot
--      reason taxonomy via a CHECK constraint:
--        ('lock' | 'midyear_reference' | 'fall_semester_end' |
--         'spring_semester_end' | 'school_year_end' | 'other')
--      The B2-final walkthrough surfaced that schools have varying
--      operational calendars; a fixed taxonomy adds rigidity without
--      adding analytical value. The freeform `snapshot_label` field
--      already captures everything the operator wants to communicate
--      about a snapshot's purpose. v3.8.17 simplifies to label-only.
--
--      The CHECK constraint is dropped here. The `snapshot_reason`
--      column is preserved as nullable for back-compat with any test
--      snapshots taken during the B2-final walkthrough — a future
--      cleanup migration may DROP COLUMN once confirmed unused.
--      No code path writes `snapshot_reason` going forward; the
--      rewritten `capture_tuition_audit_snapshot` RPC writes NULL.
--
--   2. Snapshot capture missing from Recent Activity. Migration 038's
--      RPC inserts a row into `tuition_worksheet_snapshots` which
--      fires `tg_log_changes` and creates a `change_log` row with
--      target_table = 'tuition_worksheet_snapshots'. But Tuition-D's
--      MODULE_AUDIT_CONFIGS.tuition only queries change_log rows
--      with target_table = 'tuition_worksheet_scenarios' — the
--      snapshot's audit row is never picked up. The snapshot event
--      doesn't appear in the Recent Activity feed.
--
--      The fix: at the end of `capture_tuition_audit_snapshot`,
--      INSERT a synthetic change_log row with:
--        target_table = 'tuition_worksheet_scenarios'
--        target_id    = p_scenario_id
--        field_name   = '__snapshot_captured__'
--        new_value    = jsonb_build_object('snapshot_id', ...,
--                                          'label', ...,
--                                          'captured_at', now())
--        reason       = 'snapshot_captured: <label>'
--      The activity feed already filters by target_table = scenarios,
--      so this row surfaces. The application-side classifyEvent +
--      summarizeEvent in auditLog.js gain a 'snapshot_captured' kind
--      to render the row meaningfully in the feed.
--
--      Class-of-issue note: the v3.8.12 audit-discipline lesson
--      applies — RPCs that write to tracked tables must ensure the
--      audit trail surfaces in the user-facing activity feed. The
--      lock_tuition_scenario RPC's audit trail surfaces because the
--      state UPDATE on the scenario row triggers tg_log_changes on
--      the scenario table directly. The snapshot capture has no
--      natural state change on the scenario, so a direct change_log
--      INSERT is the right path.
--
-- Function signature change (drops p_snapshot_reason): three-arg →
-- two-arg. PostgreSQL requires DROP FUNCTION before CREATE for
-- argument-list changes — same gotcha as Migration 037.
--
-- ============================================================================


-- ---- 1. Drop the snapshot_reason CHECK constraint -----------------------

alter table tuition_worksheet_snapshots
  drop constraint if exists tuition_snapshots_reason_check;


-- ---- 2. DROP + CREATE capture_tuition_audit_snapshot --------------------
--
-- Drop the M038 three-arg version; create the two-arg version that
-- requires a non-empty label and writes NULL to snapshot_reason.
-- Also adds the synthetic change_log INSERT that surfaces the
-- snapshot event in Recent Activity.

drop function if exists capture_tuition_audit_snapshot(uuid, text, text);

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

  -- Stage 2 only.
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

  -- Stage 2 should always be drafting under the v3.8.16 model.
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

  -- KPIs computed at capture time.
  select * into v_kpis from compute_tuition_scenario_kpis(p_scenario_id);

  -- Snapshot header. Same INSERT shape as Migration 038, but
  -- snapshot_reason writes NULL — taxonomy is dropped.
  insert into tuition_worksheet_snapshots (
    -- Identity + provenance
    scenario_id, aye_id, aye_label_at_lock,
    stage_id, stage_display_name_at_lock, stage_short_name_at_lock, stage_type_at_lock,
    scenario_label_at_lock, scenario_description_at_lock,
    -- Tier configuration
    tier_count, tier_rates,
    -- Discount / fee configuration
    faculty_discount_pct,
    projected_other_discount, projected_financial_aid,
    curriculum_fee_per_student, enrollment_fee_per_student, before_after_school_hourly_rate,
    -- M027 additions
    projected_faculty_discount_amount,
    total_students, total_families, top_tier_avg_students_per_family,
    -- Projection inputs
    estimated_family_distribution,
    actual_before_after_school_hours,
    -- M028 additions
    projected_b_a_hours,
    projected_multi_student_discount,
    -- M029 additions
    expense_comparator_mode,
    expense_comparator_amount,
    expense_comparator_source_label,
    -- M032 _at_lock variants
    expense_comparator_amount_at_lock,
    expense_comparator_source_label_at_lock,
    -- KPIs
    kpi_gross_tuition_revenue, kpi_multi_student_discount_total,
    kpi_faculty_discount_total, kpi_other_discount_total, kpi_financial_aid_total,
    kpi_curriculum_fee_revenue, kpi_enrollment_fee_revenue, kpi_before_after_school_revenue,
    kpi_net_education_program_revenue,
    kpi_net_education_program_ratio,
    kpi_breakeven_enrollment,
    -- Lock metadata (defensive sentinel values for NOT NULL columns;
    -- locked_via = 'snapshot' identifies operator snapshots vs
    -- 'cascade'/'override' lock snapshots)
    locked_at, locked_by, locked_by_name_at_lock,
    locked_via, override_justification,
    approved_by, approved_by_name_at_lock, approved_at,
    -- M038 additions: snapshot_reason writes NULL going forward;
    -- snapshot_label and captured_at carry the meaningful values
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
    null,        -- snapshot_reason (taxonomy dropped)
    v_label,     -- snapshot_label (operator-provided, required)
    now()        -- captured_at
  )
  returning id into v_snapshot_id;

  -- Stage 2 family_details capture — every column including M036's.
  insert into tuition_worksheet_snapshot_family_details (
    snapshot_id, family_label, students_enrolled,
    applied_tier_size, applied_tier_rate,
    faculty_discount_amount, other_discount_amount, financial_aid_amount,
    notes, sort_order,
    is_faculty_family, date_enrolled, date_withdrawn
  )
  select v_snapshot_id, fd.family_label, fd.students_enrolled,
         fd.applied_tier_size, fd.applied_tier_rate,
         fd.faculty_discount_amount, fd.other_discount_amount, fd.financial_aid_amount,
         fd.notes,
         row_number() over (order by fd.is_faculty_family desc, fd.family_label, fd.id),
         fd.is_faculty_family, fd.date_enrolled, fd.date_withdrawn
    from tuition_worksheet_family_details fd
   where fd.scenario_id = p_scenario_id;

  -- Synthetic change_log row pointed at the SCENARIO row, so the
  -- Recent Activity feed (which queries change_log filtered to
  -- target_table = 'tuition_worksheet_scenarios' per Tuition-D's
  -- MODULE_AUDIT_CONFIGS.tuition) picks it up. The natural
  -- tg_log_changes-driven row on tuition_worksheet_snapshots also
  -- exists but is invisible to the activity feed today.
  --
  -- Synthetic field_name = '__snapshot_captured__' (parallel to
  -- '__insert__' / '__delete__' system markers). The new_value jsonb
  -- carries the snapshot id, label, and captured-at timestamp so
  -- the UI can render it without a follow-up query.
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


-- ---- 3. PostgREST schema cache reload -----------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 039
-- ============================================================================
