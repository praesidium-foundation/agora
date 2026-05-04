-- ============================================================================
-- Migration 037: Tuition create_tuition_scenario_from_snapshot
--                parameter naming alignment (v3.8.15)
--
-- Tuition-B2a's "Begin Tuition Audit" button on the setup card fails
-- with:
--   ERROR:  Could not find the function public.create_tuition_scenario_
--           from_snapshot(p_scenario_name, p_source_snapshot_id,
--           p_target_stage_id) in the schema cache.
--
-- Root cause: parameter naming mismatch between the RPC and its B2a
-- call site.
--   - Migration 026 created the RPC with parameter `p_scenario_label`.
--   - Migration 029 refreshed the function (added comparator-column
--     copies) but kept the same parameter name.
--   - Tuition-B2a's call site in TuitionAuditPage.jsx passes
--     `p_scenario_name` (the natural English match for "scenario name").
--
-- PostgREST resolves named-parameter RPC calls by exact name match
-- AND exact argument-list match — there is no name-fuzzing fallback.
-- The lookup failed silently in dev (the error doesn't surface until
-- the button is actually clicked) until the first live test attempt.
--
-- Fix: rename the RPC parameter to `p_scenario_name`. The call site
-- already uses that name, so no JS change to the call args is
-- required — only the button copy is updated alongside (separate
-- design refinement).
--
-- DROP first because the parameter list (parameter NAMES are part of
-- the signature for PostgreSQL function-resolution purposes via
-- pg_get_function_arguments) cannot be changed via CREATE OR REPLACE
-- alone. Same gotcha that surfaced in Migration 032 / 033 for
-- compute_tuition_scenario_kpis OUT parameters.
--
-- Function body preserved verbatim from Migration 029 — same
-- validation, same field copy list, same SECURITY DEFINER, same
-- search_path, same return type. Only the parameter name reference
-- inside the body (`p_scenario_label` → `p_scenario_name`) changes.
--
-- Audit-discipline lesson reinforced (per v3.8.12): when calling
-- existing RPCs, verify parameter names match between the function
-- definition and the call site. The B2a author wrote the call site
-- against an assumed name without reading the actual M026 / M029
-- definition. Future RPC call-site code should grep the most-recent
-- migration that defines the function (or run `\df function_name` in
-- the SQL editor) before writing the call.
-- ============================================================================


-- ---- 1. Drop the existing function (parameter rename) -------------------
--
-- DROP FUNCTION uses the argument-type list to identify the target;
-- both versions take (uuid, uuid, text) so this drop hits the live
-- function unambiguously.

drop function if exists create_tuition_scenario_from_snapshot(uuid, uuid, text);


-- ---- 2. Recreate with p_scenario_name ------------------------------------
--
-- Body is copied verbatim from Migration 029 (the most-recent
-- definition prior to this hotfix). Only the parameter name and its
-- in-body references are updated.

create or replace function create_tuition_scenario_from_snapshot(
  p_target_stage_id    uuid,
  p_source_snapshot_id uuid,
  p_scenario_name      text
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

  if p_scenario_name is null or length(trim(p_scenario_name)) = 0 then
    raise exception 'Scenario name is required.';
  end if;

  -- Target stage must exist and be the audit (final) stage.
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

  -- Source snapshot — read every column needed for the field copy
  -- below (M027 + M028 + M029 additions all included).
  select id, aye_id, stage_id, scenario_id, stage_type_at_lock,
         tier_count, tier_rates, faculty_discount_pct,
         projected_faculty_discount_amount,
         projected_other_discount, projected_financial_aid,
         curriculum_fee_per_student, enrollment_fee_per_student,
         before_after_school_hourly_rate,
         estimated_family_distribution,
         total_students, total_families, top_tier_avg_students_per_family,
         projected_b_a_hours,
         projected_multi_student_discount,
         expense_comparator_mode,
         expense_comparator_amount,
         expense_comparator_source_label
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

  -- Verify the snapshot's source stage still exists in the same
  -- workflow as the target stage.
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

  -- Tag the change_log signature.
  perform set_config(
    'app.change_reason',
    'created_from_snapshot: ' || p_source_snapshot_id::text,
    true
  );

  -- Insert the new Stage 2 scenario, copying every configuration
  -- field from the locked Stage 1 snapshot. The Stage 2 immutability
  -- trigger from Migration 022 fires on UPDATE not INSERT, so the
  -- locked-from-edit fields populate freely at INSERT time.
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
    projected_b_a_hours,
    projected_multi_student_discount,
    -- v3.8.7 (Tuition-C) additions: carry forward comparator state.
    expense_comparator_mode,
    expense_comparator_amount,
    expense_comparator_source_label,
    created_by, updated_by
  )
  values (
    v_snapshot.aye_id,
    p_target_stage_id,
    trim(p_scenario_name),
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
    v_snapshot.expense_comparator_mode,
    v_snapshot.expense_comparator_amount,
    v_snapshot.expense_comparator_source_label,
    v_caller, v_caller
  )
  returning id into v_new_scenario;

  return v_new_scenario;
end;
$$;

grant execute on function create_tuition_scenario_from_snapshot(uuid, uuid, text) to authenticated;


-- ---- 3. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 037
-- ============================================================================
