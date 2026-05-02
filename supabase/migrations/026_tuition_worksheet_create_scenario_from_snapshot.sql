-- ============================================================================
-- Migration 026: create_tuition_scenario_from_snapshot
--
-- Tuition-A2 (v3.8.1). Parallel to Budget's `create_scenario_from_snapshot`
-- (Migration 019). Used when Stage 2 (Tuition Audit) setup begins and
-- the user picks a locked Stage 1 (Tuition Planning) scenario as the
-- seed for the audit.
--
-- Architecture references:
--   §3.4  Stage initialization cascade
--   §7.3  Tuition Worksheet — Stage 2 immutability rules
--   §3.8  Module workflows and stages (sort_order semantics)
--
-- Validation rules:
--   1. Caller has 'edit' permission or higher on the Tuition module.
--   2. Target stage exists and has stage_type = 'final'.
--      (This function seeds Stage 2 from Stage 1; not the reverse.
--      The general Budget pattern allows any predecessor → successor
--      transition, but Tuition has only two stages and a fixed
--      direction, so the more restrictive check is appropriate.)
--   3. Source snapshot exists and its stage has stage_type = 'preliminary'.
--   4. Source and target stages belong to the same workflow.
--   5. Same AYE: target stage and source snapshot share the same
--      aye_id (per §7.3 — Stage 2 audit applies to the same AYE
--      whose Stage 1 was locked).
--   6. Scenario label is non-empty after trim.
--
-- Field copy: ALL configuration fields copy from the source snapshot
-- into the new Stage 2 scenario. Per §7.3 these fields are immutable
-- in Stage 2 (the BEFORE UPDATE trigger from Migration 022 enforces
-- the lock); the INSERT here populates them initially, and any
-- subsequent UPDATE attempt that changes them will be rejected by
-- the trigger. The estimated_family_distribution is also carried
-- over as a starting reference; users will overwrite it via the
-- per-family detail rows (which, per §7.3, are Stage 2 only and
-- live in tuition_worksheet_family_details).
--
-- Audit trail: app.change_reason = 'created_from_snapshot: <id>',
-- mirroring Migration 019's pattern. The new scenario's audit
-- history links back to the source snapshot permanently.
-- ============================================================================

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

  -- Source snapshot.
  select id, aye_id, stage_id, scenario_id, stage_type_at_lock
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
  -- workflow as the target stage. The stage row may have been edited
  -- post-lock (display name rename), but workflow_id should not
  -- change — same Tuition workflow.
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
  -- trigger from Migration 022 fires on UPDATE, not INSERT, so this
  -- INSERT populates the locked-from-edit fields freely.
  insert into tuition_worksheet_scenarios (
    aye_id, stage_id,
    scenario_label, description,
    is_recommended, state,
    -- Configuration (immutable in Stage 2)
    tier_count, tier_rates,
    faculty_discount_pct,
    curriculum_fee_per_student, enrollment_fee_per_student,
    before_after_school_hourly_rate,
    -- Discount envelopes (editable in Stage 2; copy as starting reference)
    other_discount_envelope, financial_aid_envelope,
    -- Stage 1 reference data carried forward
    estimated_family_distribution,
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
    v_snapshot.curriculum_fee_per_student, v_snapshot.enrollment_fee_per_student,
    v_snapshot.before_after_school_hourly_rate,
    v_snapshot.other_discount_envelope, v_snapshot.financial_aid_envelope,
    v_snapshot.estimated_family_distribution,
    v_caller, v_caller
  )
  returning id into v_new_scenario;

  -- No per-family detail rows are seeded. Family detail is the
  -- operational substance of the Stage 2 audit (per §7.3); the user
  -- enters one row per enrolled family at audit time. Stage 1 has
  -- no family detail rows to copy from.

  return v_new_scenario;
end;
$$;

grant execute on function create_tuition_scenario_from_snapshot(uuid, uuid, text) to authenticated;


-- ---- 2. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 026
-- ============================================================================
