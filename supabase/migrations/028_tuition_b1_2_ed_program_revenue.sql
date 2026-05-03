-- ============================================================================
-- Migration 028: Tuition B1.2 — Ed Program Revenue + B&A hours +
--                                Multi-Student Discount stream
--
-- v3.8.3 (Tuition-B1.2). Real-data refinements that earned their own
-- commit on top of v3.8.2 (B1.1):
--
--   - Multi-Student Discount surfaces as the fourth discount stream
--     alongside Faculty / Other / Financial Aid, mirroring the
--     vocabulary already used in Libertas's legacy AYE 2026 spreadsheet
--     (lines 34–38: Multiple Student / Faculty / Other / Financial Aid).
--     Stored at Stage 1 as a computed projection; persisted on every
--     save that touches its inputs so snapshot reads do not need to
--     recompute.
--   - Projected B&A hours becomes a Stage 1 input — fiscal directors
--     budget B&A revenue annually, and the legacy spreadsheet captured
--     this as a hand-set estimate. Stage 2 audit picks up actual hours.
--
-- Schema scope is narrow: two new columns on
-- tuition_worksheet_scenarios, mirrored on tuition_worksheet_snapshots.
-- Two of the three SECURITY DEFINER functions get refreshed via
-- CREATE OR REPLACE to pass the new columns through (lock RPC's
-- snapshot INSERT; create_from_snapshot's seed copy). compute_kpis
-- is NOT updated in B1.2 — Stage 1 KPIs compute client-side
-- (architectural decision per v3.8.3 history; server-side hoist
-- lands in Tuition-C alongside break-even / net-ed-program-ratio /
-- YoY).
--
-- Architecture references: §7.3 (extended with "Stage 1 revenue
-- vocabulary" + "Stage 1 projection vs. Stage 2 actual" subsections
-- in v3.8.3).
-- ============================================================================


-- ---- 1. New columns on scenarios -----------------------------------------
--
-- projected_b_a_hours: nullable so a fresh scenario reads "no
--   projection yet" honestly (em-dash in the UI). Once the user
--   enters a value, the persisted save updates this column.
-- projected_multi_student_discount: nullable; persisted on every
--   save that touches its inputs (tier_rates, total_students,
--   estimated_family_distribution, top_tier_avg_students_per_family).
--   Null when inputs are insufficient to compute. The application
--   layer (TuitionWorksheet.jsx persistFields) is the source of
--   truth for the value; the column stores the at-save snapshot of
--   that computation so downstream reads (lock snapshot capture,
--   future RPC math) work without recomputation.

alter table tuition_worksheet_scenarios
  add column projected_b_a_hours              int,
  add column projected_multi_student_discount numeric(12,2);


-- ---- 2. Mirror on snapshots ----------------------------------------------
--
-- Snapshot fidelity per §5.1 binding rule: snapshots reflect what was
-- true at lock time. The stored projected_multi_student_discount
-- value at lock is preserved verbatim; future reads do not recompute.
-- If math evolves between save and lock, the snapshot reflects the
-- at-save value (which is what the user committed to).

alter table tuition_worksheet_snapshots
  add column projected_b_a_hours              int,
  add column projected_multi_student_discount numeric(12,2);


-- ---- 3. lock_tuition_scenario — pass new columns through ----------------
--
-- Snapshot INSERT extended with both new columns. Return type
-- (uuid) and validation logic unchanged → CREATE OR REPLACE works.

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

  select * into v_kpis from compute_tuition_scenario_kpis(p_scenario_id);

  insert into tuition_worksheet_snapshots (
    scenario_id, aye_id, aye_label_at_lock,
    stage_id, stage_display_name_at_lock, stage_short_name_at_lock, stage_type_at_lock,
    scenario_label_at_lock, scenario_description_at_lock,
    tier_count, tier_rates,
    faculty_discount_pct,
    projected_faculty_discount_amount,
    projected_other_discount, projected_financial_aid,
    curriculum_fee_per_student, enrollment_fee_per_student, before_after_school_hourly_rate,
    estimated_family_distribution,
    total_students, total_families, top_tier_avg_students_per_family,
    actual_before_after_school_hours,
    -- v3.8.3 (B1.2) additions:
    projected_b_a_hours,
    projected_multi_student_discount,
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
    v_scenario.faculty_discount_pct,
    v_scenario.projected_faculty_discount_amount,
    v_scenario.projected_other_discount, v_scenario.projected_financial_aid,
    v_scenario.curriculum_fee_per_student, v_scenario.enrollment_fee_per_student, v_scenario.before_after_school_hourly_rate,
    v_scenario.estimated_family_distribution,
    v_scenario.total_students, v_scenario.total_families, v_scenario.top_tier_avg_students_per_family,
    v_scenario.actual_before_after_school_hours,
    v_scenario.projected_b_a_hours,
    v_scenario.projected_multi_student_discount,
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


-- ---- 4. create_tuition_scenario_from_snapshot — seed copy ---------------
--
-- Stage 2 (Tuition Audit) seed extended to copy the two new columns
-- forward from the locked Stage 1 snapshot. Return type unchanged →
-- CREATE OR REPLACE works.
--
-- Stage 2 will overwrite both columns as audit data lands:
--   projected_b_a_hours: replaced by actual_before_after_school_hours
--     (already in schema; the projected column itself is informational
--     in Stage 2 — variance signal between projection and actual)
--   projected_multi_student_discount: in Stage 2 the actual realized
--     multi-student discount comes from the per-family detail rows;
--     the projected value seeded here remains as the "what we
--     projected at Stage 1 lock" reference.

create or replace function create_tuition_scenario_from_snapshot(
  p_target_stage_id    uuid,
  p_source_snapshot_id uuid,
  p_scenario_label     text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller       uuid := auth.uid();
  v_target_stage record;
  v_snapshot     record;
  v_source_stage record;
  v_new_scenario uuid;
begin
  if not current_user_has_module_perm('tuition', 'edit') then
    raise exception 'Creating a tuition scenario from a locked predecessor requires edit permission on tuition.';
  end if;

  if p_scenario_label is null or length(trim(p_scenario_label)) = 0 then
    raise exception 'Scenario label is required.';
  end if;

  select id, workflow_id, sort_order, stage_type
    into v_target_stage
    from module_workflow_stages
   where id = p_target_stage_id;
  if v_target_stage is null then
    raise exception 'Target stage % not found.', p_target_stage_id;
  end if;
  if v_target_stage.stage_type <> 'final' then
    raise exception
      'create_tuition_scenario_from_snapshot seeds Stage 2 (Tuition Audit) from Stage 1 (Tuition Planning). The target stage must have stage_type = ''final''; got %.',
      v_target_stage.stage_type;
  end if;

  select id, aye_id, stage_id, scenario_id, stage_type_at_lock,
         tier_count, tier_rates, faculty_discount_pct,
         projected_faculty_discount_amount,
         projected_other_discount, projected_financial_aid,
         curriculum_fee_per_student, enrollment_fee_per_student,
         before_after_school_hourly_rate,
         estimated_family_distribution,
         total_students, total_families, top_tier_avg_students_per_family,
         projected_b_a_hours,
         projected_multi_student_discount
    into v_snapshot
    from tuition_worksheet_snapshots
   where id = p_source_snapshot_id;
  if v_snapshot is null then
    raise exception 'Source tuition snapshot % not found.', p_source_snapshot_id;
  end if;
  if v_snapshot.stage_type_at_lock <> 'preliminary' then
    raise exception
      'Source snapshot must be from a Stage 1 (Tuition Planning) lock; got stage_type_at_lock = %.',
      v_snapshot.stage_type_at_lock;
  end if;

  select id, workflow_id, sort_order
    into v_source_stage
    from module_workflow_stages
   where id = v_snapshot.stage_id;
  if v_source_stage is null then
    raise exception 'Source snapshot stage % no longer exists in any workflow.', v_snapshot.stage_id;
  end if;
  if v_source_stage.workflow_id <> v_target_stage.workflow_id then
    raise exception 'Source and target stages must belong to the same workflow.';
  end if;
  if v_source_stage.sort_order >= v_target_stage.sort_order then
    raise exception
      'Source stage (sort_order %) is not a predecessor of target stage (sort_order %).',
      v_source_stage.sort_order, v_target_stage.sort_order;
  end if;

  perform set_config(
    'app.change_reason',
    'created_from_snapshot: ' || p_source_snapshot_id::text,
    true
  );

  insert into tuition_worksheet_scenarios (
    aye_id, stage_id,
    scenario_label, description,
    is_recommended, state,
    tier_count, tier_rates,
    faculty_discount_pct,
    projected_faculty_discount_amount,
    curriculum_fee_per_student, enrollment_fee_per_student,
    before_after_school_hourly_rate,
    projected_other_discount, projected_financial_aid,
    estimated_family_distribution,
    total_students, total_families, top_tier_avg_students_per_family,
    -- v3.8.3 (B1.2) additions: carry forward both new columns.
    projected_b_a_hours,
    projected_multi_student_discount,
    created_by, updated_by
  )
  values (
    v_snapshot.aye_id,
    p_target_stage_id,
    trim(p_scenario_label),
    null,
    false,
    'drafting',
    v_snapshot.tier_count, v_snapshot.tier_rates,
    v_snapshot.faculty_discount_pct,
    v_snapshot.projected_faculty_discount_amount,
    v_snapshot.curriculum_fee_per_student, v_snapshot.enrollment_fee_per_student,
    v_snapshot.before_after_school_hourly_rate,
    v_snapshot.projected_other_discount, v_snapshot.projected_financial_aid,
    v_snapshot.estimated_family_distribution,
    v_snapshot.total_students, v_snapshot.total_families, v_snapshot.top_tier_avg_students_per_family,
    v_snapshot.projected_b_a_hours,
    v_snapshot.projected_multi_student_discount,
    v_caller, v_caller
  )
  returning id into v_new_scenario;

  return v_new_scenario;
end;
$$;

grant execute on function create_tuition_scenario_from_snapshot(uuid, uuid, text) to authenticated;


-- ---- 5. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 028
-- ============================================================================
