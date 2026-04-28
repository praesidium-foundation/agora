-- ============================================================================
-- Migration 007: Safe-to-delete check for COA accounts + delete-permission split
--
-- 1. chart_of_accounts_can_hard_delete(account_id) — returns whether the
--    account is safe to hard-delete (no other table references it). Today
--    the only check is the self-referential subaccount FK on parent_id.
--    When Phase 2+ modules add FK references to chart_of_accounts (budget
--    line items, tuition references, etc.), the function expands to check
--    those tables. The signature stays stable; the body grows.
--
--    Returns a table with two columns: `can_delete` (bool) and
--    `blocking_reason` (text, null when can_delete = true). The UI calls
--    this before showing the Delete affordance and at click time as a
--    safety check.
--
-- 2. RLS policy split — the existing `coa_write` policy granted INSERT,
--    UPDATE, and DELETE all under one `edit` permission gate. Hard delete
--    is destructive and should require `admin`, not `edit`. Splitting into
--    coa_insert / coa_update / coa_delete preserves existing edit-level
--    capability for INSERT and UPDATE while restricting DELETE to admins.
--    Soft-delete (UPDATE setting is_active = false) remains accessible to
--    edit-level users; only the actual DELETE statement is admin-gated.
--
-- The existing coa_change_log trigger from Migration 004 fires on DELETE
-- (after insert or update or delete on chart_of_accounts), so hard-delete
-- audit-logging happens automatically — no schema change needed there.
-- ============================================================================

-- ---- 1. Safe-to-delete check ---------------------------------------------

create or replace function chart_of_accounts_can_hard_delete(p_account_id uuid)
returns table (
  can_delete       boolean,
  blocking_reason  text
)
language plpgsql stable as $$
declare
  v_subaccount_count int;
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

  -- Future checks (Phase 2+) — uncomment / extend as new tables add FKs:
  --
  -- if exists (select 1 from preliminary_budget_lines where account_id = p_account_id) then
  --   return query select false, 'Account is referenced by Preliminary Budget rows.';
  --   return;
  -- end if;
  --
  -- if exists (select 1 from final_budget_lines where account_id = p_account_id) then
  --   return query select false, 'Account is referenced by Final Budget rows.';
  --   return;
  -- end if;

  -- All checks passed
  return query select true::boolean, null::text;
end;
$$;

-- Grant note: Migration 006 set default privileges on functions in public,
-- so this is redundant but harmless. Keeping the explicit grant makes the
-- intent obvious to anyone reading just this migration.
grant execute on function chart_of_accounts_can_hard_delete(uuid) to authenticated;

-- ---- 2. Split coa_write into per-operation policies ----------------------

drop policy if exists coa_write on chart_of_accounts;

create policy coa_insert on chart_of_accounts
  for insert to authenticated
  with check (current_user_has_module_perm('chart_of_accounts', 'edit'));

create policy coa_update on chart_of_accounts
  for update to authenticated
  using       (current_user_has_module_perm('chart_of_accounts', 'edit'))
  with check  (current_user_has_module_perm('chart_of_accounts', 'edit'));

create policy coa_delete on chart_of_accounts
  for delete to authenticated
  using       (current_user_has_module_perm('chart_of_accounts', 'admin'));

-- ============================================================================
-- END OF MIGRATION 007
-- ============================================================================
