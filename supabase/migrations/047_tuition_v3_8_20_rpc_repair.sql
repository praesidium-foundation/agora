-- ============================================================================
-- Migration 047: Tuition v3.8.20 RPC repair (v3.8.24)
--
-- Completes the repair of Migration 043's silent partial failure.
--
-- Background. Migration 043 (v3.8.20) defined three things in a single
-- file: (a) ADD COLUMN is_final_budget_reference on tuition_worksheet_
-- snapshots, (b) the partial unique index tuition_worksheet_snapshots_
-- one_final_budget_reference enforcing one promoted reference per
-- scenario, and (c) the RPC mark_snapshot_as_final_budget_reference.
-- M043 reportedly applied successfully but post-apply verification
-- against the live database confirmed all three were missing — the
-- migration silently failed in entirety.
--
-- Repair sequence:
--
--   - Migration 046 (v3.8.23) re-issued the column + partial unique
--     index using IF NOT EXISTS patterns. Post-apply verification of
--     M046 confirmed both landed correctly.
--   - Verification of pg_proc the same session surfaced that the
--     RPC was also still absent — M046's scope hadn't included the
--     function. M047 (this migration) completes the M043 repair.
--
-- The Appendix C v3.8.23 commitment ("Migrations must be verified
-- post-apply, not assumed correct from migration-tool success") is
-- explicitly being followed in the M043 repair iteration: each repair
-- step is verified before the next is scoped. The commitment is paying
-- off — without the post-apply pg_proc check, this RPC's absence
-- would have surfaced only when an operator clicked "Mark as Final
-- Budget reference" and got a runtime error from PostgREST.
--
-- RPC contract is unchanged from M043's specification — function body
-- below is copied verbatim from M043 lines 82–163. Only the migration
-- header context differs.
--
-- Architecture references: §7.3 Stage 2 narrative (v3.8.20 reference-
-- snapshot extension), Appendix C v3.8.20 decision row "Final Budget
-- anchors to operator-promoted Audit snapshot, not live Audit data,"
-- Appendix C v3.8.23 decision row "Migrations must be verified post-
-- apply, not assumed correct from migration-tool success."
-- ============================================================================


-- ---- 1. mark_snapshot_as_final_budget_reference RPC ---------------------
--
-- Atomically demote any prior reference for the scenario, then
-- promote the target. The partial unique index (M043, repaired by
-- M046) enforces the invariant; the demote-then-promote ordering
-- avoids the unique-index conflict that would arise from a swap.
--
-- Triggers: tg_log_changes fires on UPDATE of the snapshots table for
-- the is_final_budget_reference column changes. But that change_log
-- entry has target_table='tuition_worksheet_snapshots' which the
-- Recent Activity feed (Tuition-D MODULE_AUDIT_CONFIGS.tuition)
-- doesn't query. So we ALSO write a synthetic change_log row pointed
-- at the parent scenario (target_table='tuition_worksheet_scenarios')
-- — same pattern as snapshot capture (v3.8.17) and import accept
-- (v3.8.18). The application-side classifyEvent + summarizeEvent
-- (auditLog.js) recognize the 'snapshot_promoted' kind via the
-- '__snapshot_promoted__' field-name marker and the reason prefix.
--
-- Snapshot table is immutable per Migration 023's tg_prevent_snapshot_
-- update trigger. The UPDATE here would be blocked. Bypass via
-- session_replication_role = replica for this RPC's transaction
-- scope only — same pattern as Migrations 031 and 038's backfill
-- UPDATEs. The trigger re-engages automatically when the transaction
-- commits.

create or replace function mark_snapshot_as_final_budget_reference(
  p_snapshot_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller       uuid := auth.uid();
  v_snapshot     record;
  v_stage_type   text;
  v_label        text;
begin
  if not current_user_has_module_perm('tuition', 'edit') then
    raise exception 'Promoting a snapshot to Final Budget reference requires edit permission on tuition.';
  end if;

  select s.id, s.scenario_id, s.snapshot_label, s.stage_type_at_lock
    into v_snapshot
    from tuition_worksheet_snapshots s
   where s.id = p_snapshot_id;
  if v_snapshot is null then
    raise exception 'Snapshot % not found.', p_snapshot_id;
  end if;

  -- Validate Stage 2. Only Audit snapshots are eligible; Stage 1
  -- Planning lock snapshots have no per-family detail to anchor
  -- Final Budget against.
  v_stage_type := v_snapshot.stage_type_at_lock;
  if v_stage_type <> 'final' then
    raise exception
      'Only Stage 2 (Tuition Audit) snapshots can be promoted as Final Budget references; got stage_type_at_lock = %.',
      v_stage_type;
  end if;

  v_label := coalesce(v_snapshot.snapshot_label, '(unlabeled)');

  -- Bypass tg_prevent_snapshot_update for this transaction so the
  -- demote-then-promote UPDATEs can run.
  set local session_replication_role = replica;

  -- Demote any prior reference for this scenario.
  update tuition_worksheet_snapshots
     set is_final_budget_reference = false
   where scenario_id = v_snapshot.scenario_id
     and is_final_budget_reference = true
     and id <> p_snapshot_id;

  -- Promote the target.
  update tuition_worksheet_snapshots
     set is_final_budget_reference = true
   where id = p_snapshot_id;

  set local session_replication_role = origin;

  -- Synthetic change_log row pointed at the scenario, so Recent
  -- Activity surfaces the promotion event.
  insert into change_log (
    target_table, target_id, field_name,
    old_value, new_value,
    changed_by, changed_at, reason
  ) values (
    'tuition_worksheet_scenarios',
    v_snapshot.scenario_id,
    '__snapshot_promoted__',
    null,
    jsonb_build_object(
      'snapshot_id', p_snapshot_id,
      'label',       v_label,
      'promoted_at', now()
    ),
    v_caller,
    now(),
    'snapshot_promoted: ' || v_label
  );

  return p_snapshot_id;
end;
$$;

grant execute on function mark_snapshot_as_final_budget_reference(uuid) to authenticated;


-- ---- 2. PostgREST schema cache reload -----------------------------------

notify pgrst, 'reload schema';


-- ---- 3. Post-apply verification (operator runs manually) ----------------
--
-- This SELECT is NOT executed by the migration. It is documented here
-- as the verification step the operator should run after applying any
-- migration that creates or alters a function, per the Appendix C
-- v3.8.23 commitment. Should return exactly one row:
--
--     SELECT proname, pg_get_function_arguments(oid)
--       FROM pg_proc
--      WHERE proname = 'mark_snapshot_as_final_budget_reference';

-- ============================================================================
-- END OF MIGRATION 047
-- ============================================================================
