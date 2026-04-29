-- ============================================================================
-- Migration 015: Lock-state guards on scenario recommendation + submission
--
-- Discovered during Phase 2 Commit E test pass: with Scenario 1 locked, a
-- user could still mark Scenario 2 as recommended (which silently unmarked
-- Scenario 1's recommended flag — separate bug also fixed via these
-- triggers) AND submit Scenario 2 for lock review. That violates the
-- governance rule: a locked scenario in (AYE, stage) is the authoritative
-- approved budget for that slot, and competing scenarios cannot claim
-- recommended status or submission while it remains locked.
--
-- The existing partial unique index `budget_stage_scenarios_one_locked_
-- recommended` (Migration 011) only enforces uniqueness on the
-- intersection of (locked, recommended). It doesn't gate `recommended`
-- alone, and it doesn't gate state transitions — both gaps that allowed
-- the bug.
--
-- Two BEFORE UPDATE triggers close the loophole:
--
--   tg_prevent_recommend_while_sibling_locked
--     Blocks setting is_recommended = true on a scenario when ANY other
--     scenario in the same (aye_id, stage_id) is currently in `locked`
--     state. Error message names the lock workflow ("Unlock it first")
--     so the user knows what's required.
--
--   tg_prevent_lock_submit_while_sibling_locked
--     Blocks the drafting → pending_lock_review state transition for the
--     same reason. Two simultaneously-pending or pending+locked siblings
--     would create a contradictory governance artifact.
--
-- Both triggers are scoped to specific transitions so they don't fire
-- on no-op UPDATEs (e.g., toggling is_recommended=true on the already-
-- locked scenario itself, or re-saving a scenario without state change).
-- They're hard guards — admin override at the application layer cannot
-- bypass them; the only escape is the (future) unlock workflow.
--
-- Drafting alternatives is still allowed. Edits to scenario lines and
-- to the scenario row's label/description/narrative continue uninhibited
-- — only the promotion-class actions (recommend, submit) are gated.
--
-- A historical-data repair step also runs at the top of the migration
-- to fix any rows the bug already produced — specifically, locked
-- scenarios where is_recommended = false. See section 0 below.
-- ============================================================================

-- ---- 0. Repair historical corruption ------------------------------------
--
-- Before installing the triggers, repair any rows that the bug already
-- produced. The corrupted state is: a scenario with state = 'locked'
-- whose is_recommended = false. The bug produced this by silently
-- unmarking the locked scenario when a sibling was marked recommended,
-- which violates the invariant that the locked row IS the (AYE, stage)'s
-- approved budget for that slot — its captured snapshot has
-- is_recommended_at_lock = true but the live row contradicts it.
--
-- Repair has two steps per affected (aye_id, stage_id):
--   a) Unmark is_recommended on any non-locked sibling in the slot.
--      The partial unique index `budget_stage_scenarios_one_locked_
--      recommended` (Migration 011) prevents two recommended rows when
--      one is locked, so the non-locked recommended sibling is the
--      reason the locked row was un-recommended in the first place.
--   b) Set is_recommended = true on the locked row, restoring it to
--      consistency with its own snapshot's captured state.
--
-- This step MUST run before the recommend-guard trigger is installed —
-- otherwise step (b)'s UPDATE would be rejected by the trigger.
--
-- Wrapped in DO so it runs unconditionally on apply but produces no
-- output when there are no rows to repair (idempotent on a clean DB).
do $$
declare
  v_repaired int := 0;
  r record;
begin
  for r in
    select id, aye_id, stage_id, scenario_label
      from budget_stage_scenarios
     where state = 'locked'
       and is_recommended = false
  loop
    -- Step (a): clear is_recommended on any other scenario in the slot.
    update budget_stage_scenarios
       set is_recommended = false
     where aye_id = r.aye_id
       and stage_id = r.stage_id
       and id != r.id
       and is_recommended = true;

    -- Step (b): restore the locked row's is_recommended to true.
    update budget_stage_scenarios
       set is_recommended = true
     where id = r.id;

    v_repaired := v_repaired + 1;
    raise notice
      'Repaired locked scenario "%": is_recommended set true; cleared sibling recommends in (aye %, stage %).',
      r.scenario_label, r.aye_id, r.stage_id;
  end loop;

  if v_repaired > 0 then
    raise notice 'Migration 015 repaired % corrupted locked scenario(s).', v_repaired;
  end if;
end $$;

-- ---- 1. Trigger: prevent marking recommended while sibling is locked ----

create or replace function tg_prevent_recommend_while_sibling_locked()
returns trigger language plpgsql as $$
declare
  v_blocking_label text;
begin
  -- Only fire when is_recommended transitions from false/null → true.
  if NEW.is_recommended is distinct from true then return NEW; end if;
  if OLD.is_recommended = true then return NEW; end if;

  select scenario_label into v_blocking_label
    from budget_stage_scenarios
   where aye_id = NEW.aye_id
     and stage_id = NEW.stage_id
     and id != NEW.id
     and state = 'locked'
   limit 1;

  if v_blocking_label is not null then
    raise exception
      'Cannot mark "%" as recommended: scenario "%" in this (AYE, stage) is currently locked. Unlock it first.',
      NEW.scenario_label, v_blocking_label;
  end if;

  return NEW;
end;
$$;

create trigger budget_scenarios_recommend_guard
  before update on budget_stage_scenarios
  for each row execute function tg_prevent_recommend_while_sibling_locked();

-- ---- 2. Trigger: prevent submit-for-lock-review while sibling is locked --

create or replace function tg_prevent_lock_submit_while_sibling_locked()
returns trigger language plpgsql as $$
declare
  v_blocking_label text;
begin
  -- Only fire on transitions INTO pending_lock_review.
  if NEW.state is distinct from 'pending_lock_review' then return NEW; end if;
  if OLD.state = 'pending_lock_review' then return NEW; end if;

  select scenario_label into v_blocking_label
    from budget_stage_scenarios
   where aye_id = NEW.aye_id
     and stage_id = NEW.stage_id
     and id != NEW.id
     and state = 'locked'
   limit 1;

  if v_blocking_label is not null then
    raise exception
      'Cannot submit "%" for lock review: scenario "%" in this (AYE, stage) is currently locked. Unlock it first.',
      NEW.scenario_label, v_blocking_label;
  end if;

  return NEW;
end;
$$;

create trigger budget_scenarios_lock_submit_guard
  before update on budget_stage_scenarios
  for each row execute function tg_prevent_lock_submit_while_sibling_locked();

-- ---- 3. PostgREST schema cache reload ------------------------------------
notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 015
-- ============================================================================
