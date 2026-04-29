-- ============================================================================
-- Migration 014: Phantom-row protection on COA edits + one-time cleanup
--
-- Discovery context (April 28, 2026): the user encountered a row in
-- budget_stage_lines pointing at account 4190 "Tuition Discounts"
-- (posts_directly = false, a summary account). Migration 011's
-- tg_validate_budget_line_account trigger is correct — it would reject
-- a direct INSERT of a summary account into budget_stage_lines. Audit
-- of every insert path (createBlankScenario, createScenarioFromCurrent,
-- createScenarioFromPriorAye, createScenarioFromCsvRows, the auto-
-- detect "Add to Budget" flow, AddAccountModal) confirmed all correctly
-- filter for posts_directly = true AND is_pass_thru = false AND
-- is_active = true. So the row didn't arrive via insert.
--
-- It arrived via the COA EDIT path. A user can edit a chart_of_accounts
-- row and toggle posts_directly from true to false (or is_pass_thru
-- from false to true) even when active budget_stage_lines rows reference
-- that account. The validation trigger is scoped to INSERT/UPDATE on
-- budget_stage_lines; it never re-runs when chart_of_accounts changes
-- underneath. Result: a row that was valid at insert becomes a phantom
-- after the COA toggle.
--
-- This migration:
--
--   1. Adds tg_check_coa_phantom_creation, a BEFORE UPDATE trigger on
--      chart_of_accounts that rejects toggling posts_directly to false
--      (or is_pass_thru to true) while live budget_stage_lines rows
--      reference the account. The user must remove the account from
--      active budgets first. Snapshot tables (budget_snapshot_lines)
--      are NOT counted — those capture account state by value at lock
--      time and are immune to subsequent COA changes by design.
--
--   2. Runs a one-time cleanup DELETE removing any existing phantom
--      rows from budget_stage_lines (rows where the referenced account
--      is now summary or pass-thru). Idempotent — runs of zero rows
--      delete cleanly. Safe to re-run if needed.
-- ============================================================================

-- ---- 1. Phantom-creation prevention trigger ------------------------------

create or replace function tg_check_coa_phantom_creation()
returns trigger language plpgsql
security definer set search_path = public
as $$
declare
  v_offending_count int;
  v_transition     text;
begin
  -- Only check the two transitions that would invalidate existing
  -- budget_stage_lines references:
  --   - posts_directly: true → false (account becomes summary)
  --   - is_pass_thru:   false → true (account becomes pass-thru)
  -- Other column changes (rename, code change, sort_order, flags on
  -- posting accounts, deactivation) don't create phantoms.
  if (OLD.posts_directly = true AND NEW.posts_directly = false) then
    v_transition := 'summary';
  elsif (OLD.is_pass_thru = false AND NEW.is_pass_thru = true) then
    v_transition := 'pass-thru';
  else
    return NEW;
  end if;

  select count(*) into v_offending_count
    from budget_stage_lines
   where account_id = NEW.id;

  if v_offending_count > 0 then
    raise exception
      'Cannot change "%" to a %s account: % active budget line(s) reference it. Remove the account from all active budget scenarios first, then change its kind.',
      NEW.name, v_transition, v_offending_count;
  end if;

  return NEW;
end;
$$;

create trigger chart_of_accounts_phantom_check
  before update on chart_of_accounts
  for each row execute function tg_check_coa_phantom_creation();

-- ---- 2. One-time cleanup -------------------------------------------------

-- Removes any existing phantom rows from budget_stage_lines that point at
-- an account that's currently summary or pass-thru. The trigger above
-- prevents new phantoms; this catches the historical ones (the user
-- found one such row during testing; there may be others in test data
-- across scenarios).
delete from budget_stage_lines
 where id in (
   select bsl.id
     from budget_stage_lines bsl
     join chart_of_accounts coa on coa.id = bsl.account_id
    where coa.posts_directly = false
       or coa.is_pass_thru = true
 );

-- ---- 3. PostgREST schema cache reload ------------------------------------
notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 014
-- ============================================================================
