-- ============================================================================
-- Migration 038: Tuition Audit operator-triggered snapshot capability (v3.8.16)
--
-- Architectural correction codified in v3.8.16: Tuition Audit (Stage 2)
-- is NOT a lockable artifact. It is a living working document
-- maintained throughout the academic year. The previous build sequence
-- (B2b) had Stage 2 lock workflow on the roadmap; B2-final removes
-- that scope and replaces it with operator-triggered snapshots.
--
-- Snapshots in the new model:
--   - Lock-triggered (Stage 1 only) — created by lock_tuition_scenario.
--     snapshot_reason = 'lock'. captured_at = locked_at = now().
--   - Operator-triggered (Stage 2) — created by capture_tuition_audit_
--     snapshot. snapshot_reason ∈ {'midyear_reference',
--     'fall_semester_end', 'spring_semester_end', 'school_year_end',
--     'other'}. captured_at = now() at click time.
--
-- Multiple snapshots can exist per scenario; each captures the
-- family_details rows as they were at snapshot time. Operator picks
-- a reason from a fixed taxonomy plus a free-text label (required
-- only when reason = 'other').
--
-- Schema additions to tuition_worksheet_snapshots:
--   snapshot_reason  text NULL with CHECK on the taxonomy
--   snapshot_label   text NULL (operator-provided label)
--   captured_at      timestamptz NOT NULL DEFAULT now()
--
-- created_at already exists on the table (Migration 023, default
-- now()) — kept as the row insertion timestamp. captured_at is the
-- semantic capture time (equals locked_at for lock snapshots; equals
-- now() at click time for operator snapshots).
--
-- Backfill: existing snapshot rows (zero in production for tuition;
-- the column is for forward consistency) get snapshot_reason = 'lock'
-- if they have a non-null locked_at. The backfill is a no-op against
-- empty tables but documents the semantic intent.
--
-- New RPC capture_tuition_audit_snapshot(p_scenario_id, p_snapshot_
-- reason, p_snapshot_label) is the operator-triggered snapshot path:
--   - Validates scenario is Stage 2 (stage_type = 'final')
--   - Validates scenario state = 'drafting' (Stage 2 should always be
--     drafting in the new model)
--   - Validates p_snapshot_reason is a recognized non-'lock' value
--   - Captures every column on the source scenario into the snapshot
--     (Migration 034 audit-discipline applied: read the current
--     scenario schema and copy every captured-by-value column)
--   - Captures every family_details row into snapshot_family_details
--     including Migration 036's is_faculty_family / date_enrolled /
--     date_withdrawn (the gap M036 filed for B2b is closed here for
--     the operator-snapshot path; lock_tuition_scenario stays
--     untouched because Stage 1 has no family_details rows to
--     capture)
--   - Returns the new snapshot_id
--
-- Note on lock_tuition_scenario: NOT modified by this migration.
-- Stage 1 lock continues to work as today (Migration 034). Stage 1
-- does not have family_details rows, so the M036 known-gap doesn't
-- affect Stage 1 lock. Future cleanup pass may add snapshot_reason
-- = 'lock' to lock_tuition_scenario's INSERT for explicit
-- consistency, but until then the column stays NULL on lock-created
-- snapshots and the Snapshots panel UI infers "lock" from
-- locked_at IS NOT NULL.
-- ============================================================================


-- ---- 1. Schema additions ------------------------------------------------

alter table tuition_worksheet_snapshots
  add column snapshot_reason text,
  add column snapshot_label  text,
  add column captured_at     timestamptz not null default now();

alter table tuition_worksheet_snapshots
  add constraint tuition_snapshots_reason_check check (
    snapshot_reason is null or snapshot_reason in (
      'lock',
      'midyear_reference',
      'fall_semester_end',
      'spring_semester_end',
      'school_year_end',
      'other'
    )
  );


-- ---- 2. Backfill ---------------------------------------------------------
--
-- For any existing snapshot rows with locked_at populated, set
-- snapshot_reason = 'lock' and captured_at = locked_at. Zero rows in
-- production today; the backfill documents semantic intent for any
-- future migration that might run against pre-existing data.

update tuition_worksheet_snapshots
   set snapshot_reason = 'lock',
       captured_at    = locked_at
 where snapshot_reason is null
   and locked_at is not null;


-- ---- 3. capture_tuition_audit_snapshot RPC ------------------------------
--
-- Operator-triggered snapshot of a Stage 2 scenario. Multiple
-- snapshots per scenario allowed. Does NOT change scenario state.
--
-- Migration 034 audit discipline applied: the INSERT enumerates
-- every captured-by-value column on the snapshot table by schema-
-- evolution era. Adding a new column to tuition_worksheet_snapshots
-- in a future migration MUST also extend this function's INSERT.

create or replace function capture_tuition_audit_snapshot(
  p_scenario_id   uuid,
  p_snapshot_reason text default 'midyear_reference',
  p_snapshot_label  text default null
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
  v_reason         text;
  v_kpis           record;
begin
  if not current_user_has_module_perm('tuition', 'edit') then
    raise exception 'Capturing a tuition audit snapshot requires edit permission on tuition.';
  end if;

  v_reason := coalesce(p_snapshot_reason, 'midyear_reference');
  if v_reason not in (
    'midyear_reference', 'fall_semester_end', 'spring_semester_end',
    'school_year_end', 'other'
  ) then
    raise exception
      'Invalid snapshot reason "%". Allowed: midyear_reference, fall_semester_end, spring_semester_end, school_year_end, other.',
      v_reason;
  end if;
  if v_reason = 'other' and (p_snapshot_label is null or length(trim(p_snapshot_label)) = 0) then
    raise exception 'Snapshot label is required when snapshot reason is "other".';
  end if;

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

  -- AYE metadata captured by value at capture time per §5.1.
  select label into v_aye
    from academic_years where id = v_scenario.aye_id;
  if v_aye is null then
    raise exception 'AYE % referenced by scenario % not found.', v_scenario.aye_id, p_scenario_id;
  end if;

  -- Capturer's display name.
  select coalesce(full_name, '') into v_locker_name
    from user_profiles where id = v_caller;
  if v_locker_name is null or length(v_locker_name) = 0 then
    v_locker_name := 'Unknown user';
  end if;

  -- KPIs computed at capture time. Reuses the existing
  -- compute_tuition_scenario_kpis function (Migration 033 corrected
  -- column refs); the function works against Stage 2 scenarios via
  -- its existing branch on stage_type.
  select * into v_kpis from compute_tuition_scenario_kpis(p_scenario_id);

  -- Snapshot header. INSERT covers every captured-by-value column on
  -- tuition_worksheet_snapshots, organized by schema-evolution era
  -- (mirrors the M034 lock_tuition_scenario INSERT pattern). Adding
  -- a new column to the snapshot table in a future migration MUST
  -- extend this INSERT too.
  insert into tuition_worksheet_snapshots (
    -- Identity + provenance
    scenario_id, aye_id, aye_label_at_lock,
    stage_id, stage_display_name_at_lock, stage_short_name_at_lock, stage_type_at_lock,
    scenario_label_at_lock, scenario_description_at_lock,
    -- Tier configuration (M023 base; M031 added discount_pct inside the jsonb)
    tier_count, tier_rates,
    -- Discount / fee configuration (M023 base with M027 renames applied)
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
    -- M029 additions (mirror of scenario columns)
    expense_comparator_mode,
    expense_comparator_amount,
    expense_comparator_source_label,
    -- M032 _at_lock variants (populated for backward compat — same
    -- value as the M029 mirrors above; both columns exist)
    expense_comparator_amount_at_lock,
    expense_comparator_source_label_at_lock,
    -- KPIs (M023 9 + M032 2)
    kpi_gross_tuition_revenue, kpi_multi_student_discount_total,
    kpi_faculty_discount_total, kpi_other_discount_total, kpi_financial_aid_total,
    kpi_curriculum_fee_revenue, kpi_enrollment_fee_revenue, kpi_before_after_school_revenue,
    kpi_net_education_program_revenue,
    kpi_net_education_program_ratio,
    kpi_breakeven_enrollment,
    -- Lock metadata (M023 base) — null on operator snapshots, since
    -- this is not a lock event. The schema requires NOT NULL on
    -- locked_at / locked_by_name_at_lock / approved_by_name_at_lock
    -- per Migration 023; we set them to defensive sentinel values
    -- here so the column constraints pass. The Snapshots Panel UI
    -- distinguishes lock-snapshots from operator-snapshots via
    -- snapshot_reason, not via these columns.
    locked_at, locked_by, locked_by_name_at_lock,
    locked_via, override_justification,
    approved_by, approved_by_name_at_lock, approved_at,
    -- M038 additions
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
    -- Defensive sentinel values for the NOT NULL lock-metadata columns.
    -- captured_at carries the real timestamp; locked_at duplicates it
    -- so timeline queries that order by locked_at still produce
    -- chronologically-coherent results. locker name fields use the
    -- capturer name; locked_via uses 'snapshot' to distinguish from
    -- 'cascade' / 'override'.
    now(), v_caller, v_locker_name,
    'snapshot', null,
    v_caller, v_locker_name, now(),
    v_reason, p_snapshot_label, now()
  )
  returning id into v_snapshot_id;

  -- Stage 2 family_details capture. Every column including M036's
  -- is_faculty_family / date_enrolled / date_withdrawn (the M036
  -- known-gap is closed for the operator-snapshot path here).
  insert into tuition_worksheet_snapshot_family_details (
    snapshot_id, family_label, students_enrolled,
    applied_tier_size, applied_tier_rate,
    faculty_discount_amount, other_discount_amount, financial_aid_amount,
    notes, sort_order,
    -- M036 additions
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

  -- Tag the change_log signature so the audit feed can recognize the
  -- snapshot event distinctly from edits and lock events.
  perform set_config(
    'app.change_reason',
    'audit_snapshot_captured: ' || v_reason
      || case when p_snapshot_label is not null and length(trim(p_snapshot_label)) > 0
              then ' (' || trim(p_snapshot_label) || ')'
              else '' end,
    true
  );

  return v_snapshot_id;
end;
$$;

grant execute on function capture_tuition_audit_snapshot(uuid, text, text) to authenticated;


-- ---- 4. PostgREST schema cache reload -----------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 038
-- ============================================================================
