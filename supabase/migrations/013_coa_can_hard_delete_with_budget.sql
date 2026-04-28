-- ============================================================================
-- Migration 013: Extended safe-to-delete check for COA accounts
--
-- Migration 007 originally established this function with subaccount-only
-- checks and TODO comments to add budget table checks "when Phase 2 lands."
-- Phase 2 landed; the function was lost during the architectural correction
-- (Migrations 010 / 011 / 012, which dropped and recreated the budget
-- tables) and was manually patched via SQL Editor with the budget check
-- added. This migration restores the source of truth.
--
-- ⚠️ FK-COMPLETENESS DISCIPLINE ⚠️
--
-- When new tables are added that FK to chart_of_accounts.id, this function
-- MUST be updated to check them. Otherwise the modal's "no other module
-- references this account" message becomes inaccurate, and a confidently-
-- offered Delete will fail at the FK layer with a poor UX. That's a trust
-- failure as much as a bug.
--
-- Tables checked here (must be reflected in the function body below):
--   - chart_of_accounts.parent_id          — subaccounts (self-ref)
--   - budget_stage_lines.account_id        — active budget references
--
-- Tables that exist but DO NOT block deletion (and the rationale):
--   - budget_snapshot_lines.account_id     — the FK uses ON DELETE SET NULL
--                                            (Migration 011); snapshots
--                                            preserve account state by value
--                                            at lock time, so post-lock
--                                            hard-delete is intended and safe.
--                                            Locked snapshots continue to
--                                            render the account by its
--                                            captured name.
--
-- Future tables to add when implemented:
--   - tuition_scenario_lines variants referencing accounts
--   - staffing_scenario_positions account references
--   - cash flow / actuals integration tables
--   - any module-to-account mapping rows
--
-- Architecture doc Appendix B has the FK-completeness practice note.
-- ============================================================================

create or replace function chart_of_accounts_can_hard_delete(p_account_id uuid)
returns table (
  can_delete       boolean,
  blocking_reason  text
)
language plpgsql stable as $$
declare
  v_subaccount_count   int;
  v_budget_line_count  int;
begin
  -- Check 1: subaccounts (self-referential FK on parent_id)
  select count(*) into v_subaccount_count
    from chart_of_accounts
   where parent_id = p_account_id;

  if v_subaccount_count > 0 then
    return query select
      false,
      format(
        'Account has %s subaccount(s). Delete or move subaccounts first, or deactivate this account.',
        v_subaccount_count
      );
    return;
  end if;

  -- Check 2: active (live, non-snapshot) budget line references.
  -- Migration 011 renamed the budget line table to budget_stage_lines;
  -- this is the canonical place to look for current references.
  select count(*) into v_budget_line_count
    from budget_stage_lines
   where account_id = p_account_id;

  if v_budget_line_count > 0 then
    return query select
      false,
      format(
        'Account is referenced by %s active budget line(s). Remove from budgets or deactivate this account.',
        v_budget_line_count
      );
    return;
  end if;

  -- All blocking checks passed. Locked-snapshot references
  -- (budget_snapshot_lines) are intentionally NOT a blocker; see header
  -- comment for rationale.
  return query select true::boolean, null::text;
end;
$$;

grant execute on function chart_of_accounts_can_hard_delete(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- PostgREST schema cache reload
-- ----------------------------------------------------------------------------
-- PostgREST does not refresh its schema cache automatically when migrations
-- run. Without this notification, the API layer would report "could not
-- find function in schema cache" until the cache happens to refresh, which
-- is precisely the bug that lost the original Migration 007 function. The
-- reload is idempotent and cheap; include it defensively at the end of
-- every migration that touches an RPC-callable surface.
notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 013
-- ============================================================================
