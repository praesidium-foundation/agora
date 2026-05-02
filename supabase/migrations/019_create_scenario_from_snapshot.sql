-- ============================================================================
-- Migration 019: create_scenario_from_snapshot
--
-- Phase 2 follow-on session. Adds the SECURITY DEFINER RPC that seeds a
-- new drafting scenario in a target stage from a locked predecessor
-- stage's snapshot. Used by the Final Budget setup gateway (and by any
-- future non-first stage setup) to copy the predecessor's locked lines
-- into a fresh working copy.
--
-- Architecture references:
--   §3.4  Stage initialization cascade (paragraph added in v3.5)
--   §8.14 Final Budget setup model (new in v3.5)
--   §3.7  Module workflows and stages (sort_order semantics)
--
-- Validation rules enforced in the function:
--   1. Caller has 'edit' permission or higher on the Budget module.
--      Same tier required to create a scenario by any other route — no
--      reason to gate this path more tightly.
--   2. Target stage exists.
--   3. Source snapshot exists.
--   4. The source snapshot's stage is a PREDECESSOR of the target stage
--      in the same workflow (lower sort_order, same workflow_id), and
--      both stages share the same AYE. Cross-workflow seeding is
--      forbidden (each module has its own workflow); cross-AYE seeding
--      is forbidden (use createScenarioFromPriorAye for that path —
--      different semantics: matching by stage_type, not predecessor
--      relationship).
--   5. p_scenario_name is non-empty after trim.
--
-- Audit trail: app.change_reason is set to 'created_from_snapshot' so
-- the existing tg_log_changes trigger captures a recognizable signature
-- on every change_log row emitted by the inserts. The reason text
-- includes the source snapshot id, so the audit history of the new
-- scenario links back to the predecessor it came from.
--
-- Atomicity: the scenario row insert and all line inserts run inside the
-- function's implicit transaction. If line inserts fail (e.g., FK
-- violation because an account_id was hard-deleted between snapshot
-- capture and now — the snapshot has account_id with ON DELETE SET NULL,
-- so a snapshot line MAY have a null account_id), the scenario row
-- rolls back too.
--
-- Pass-thru and inactive accounts: snapshot lines may include accounts
-- that are now inactive or pass-thru (snapshots capture state by value).
-- We DO NOT filter those here — the architectural commitment is that
-- the snapshot represents the locked predecessor exactly, and seeding
-- from it is "begin where they ended". The new scenario inherits
-- whatever was in the snapshot. The user can clean up in the working
-- copy if needed; downstream COA-edit triggers from Migration 014 still
-- protect against future phantom-row corruption.
-- ============================================================================

create or replace function create_scenario_from_snapshot(
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
  v_caller        uuid := auth.uid();
  v_target_stage  record;
  v_snapshot      record;
  v_source_stage  record;
  v_new_scenario  uuid;
begin
  -- Authorization.
  if not current_user_has_module_perm('budget', 'edit') then
    raise exception 'Creating a scenario from a locked predecessor requires edit permission on budget.';
  end if;

  -- Validate scenario name.
  if p_scenario_name is null or length(trim(p_scenario_name)) = 0 then
    raise exception 'Scenario name is required.';
  end if;

  -- Load target stage.
  select id, workflow_id, sort_order, display_name
    into v_target_stage
    from module_workflow_stages
   where id = p_target_stage_id;
  if v_target_stage is null then
    raise exception 'Target stage % not found.', p_target_stage_id;
  end if;

  -- Load source snapshot (need aye_id, stage_id for predecessor check).
  select id, aye_id, stage_id, scenario_id
    into v_snapshot
    from budget_snapshots
   where id = p_source_snapshot_id;
  if v_snapshot is null then
    raise exception 'Source snapshot % not found.', p_source_snapshot_id;
  end if;

  -- Load source stage to verify predecessor relationship.
  select id, workflow_id, sort_order
    into v_source_stage
    from module_workflow_stages
   where id = v_snapshot.stage_id;
  if v_source_stage is null then
    -- Snapshot's stage no longer exists in workflow — can't verify
    -- predecessor relationship safely.
    raise exception 'Source snapshot stage % no longer exists in any workflow.', v_snapshot.stage_id;
  end if;

  -- Same workflow check.
  if v_source_stage.workflow_id <> v_target_stage.workflow_id then
    raise exception 'Source and target stages must belong to the same workflow.';
  end if;

  -- Predecessor relationship check: source must come BEFORE target in
  -- the workflow's stage ordering.
  if v_source_stage.sort_order >= v_target_stage.sort_order then
    raise exception
      'Source stage (sort_order %) is not a predecessor of target stage (sort_order %). Seeding only flows forward in the workflow.',
      v_source_stage.sort_order, v_target_stage.sort_order;
  end if;

  -- Tag change_log signature so the audit trail identifies this as a
  -- snapshot-seeded scenario. Include the source snapshot id in the
  -- reason text for traceability — keeps the link back to the
  -- predecessor in change_log.reason permanently.
  perform set_config(
    'app.change_reason',
    'created_from_snapshot: ' || p_source_snapshot_id::text,
    true
  );

  -- Insert the new drafting scenario.
  insert into budget_stage_scenarios (
    aye_id, stage_id, scenario_label, description,
    is_recommended, state, created_by, updated_by
  ) values (
    v_snapshot.aye_id,
    p_target_stage_id,
    trim(p_scenario_name),
    null,
    false,
    'drafting',
    v_caller,
    v_caller
  )
  returning id into v_new_scenario;

  -- Copy snapshot lines into the new scenario's live lines.
  --
  -- Field mapping:
  --   snapshot.account_id  → live.account_id  (NULL becomes a problem;
  --                           we filter those out — see below)
  --   snapshot.amount      → live.amount
  --   snapshot.notes       → live.notes
  --   live.source_type set to 'manual' — even if the snapshot recorded
  --     a linked source, the new scenario starts as a manual edit. The
  --     user can re-establish links via the upstream module if desired.
  --
  -- Snapshot lines with account_id = NULL (because the live account was
  -- hard-deleted post-lock and ON DELETE SET NULL fired) cannot be
  -- materialized as live lines — budget_stage_lines requires a non-null
  -- account_id. We skip those silently. The snapshot itself remains
  -- intact for audit / PDF purposes; the live working copy just has a
  -- shorter line list.
  insert into budget_stage_lines (
    scenario_id, account_id, amount, source_type, notes,
    created_by, updated_by
  )
  select
    v_new_scenario,
    sl.account_id,
    coalesce(sl.amount, 0),
    'manual',
    sl.notes,
    v_caller,
    v_caller
  from budget_snapshot_lines sl
  where sl.snapshot_id = p_source_snapshot_id
    and sl.account_id is not null;

  return v_new_scenario;
end;
$$;

grant execute on function create_scenario_from_snapshot(uuid, uuid, text) to authenticated;

-- PostgREST schema cache reload.
notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 019
-- ============================================================================
