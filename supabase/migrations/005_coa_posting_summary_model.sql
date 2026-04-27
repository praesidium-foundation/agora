-- ============================================================================
-- Migration 005: Chart of Accounts — posting vs summary account model
--
-- Replaces the leaf-only governance flag rule with a posting-only rule.
--
-- The leaf-only rule (Migration 004) conflated two distinct concepts: posting
-- vs summary accounts, and parent vs leaf position in the hierarchy. Real
-- QuickBooks COAs routinely contain parent accounts that post directly
-- (e.g., "4100 Revenue – Tuition" posts gross tuition while having a
-- "4190 Tuition Discounts" child that summarizes deductions). Under the
-- leaf-only rule such parents could not be flagged, producing incorrect
-- KPI math.
--
-- New model:
--   - posts_directly  boolean. true = money posts here directly. false = pure
--                     rollup of children.
--   - Governance flags require posts_directly = true. They are no longer
--     restricted by leaf vs parent position.
--   - Posting accounts can have children. Summary accounts must have children
--     (or they're useless).
--
-- See architecture doc v1.2, Section 4 (rewritten) and Section 4.10
-- (Deprecated rules).
-- ============================================================================

-- ---- 1. Add posts_directly column ----------------------------------------
-- Default true: existing rows become posting accounts. Users will mark
-- summaries explicitly via the UI or during CSV import (next session).
alter table chart_of_accounts
  add column posts_directly boolean not null default true;

-- ---- 2. Drop the leaf-only trigger and function --------------------------
drop trigger if exists coa_check_leaf_only_flags on chart_of_accounts;
drop function if exists tg_coa_check_leaf_only_flags();

-- ---- 3. New: posting-only flag trigger -----------------------------------
-- Governance flags (is_pass_thru, is_ed_program_dollars, is_contribution)
-- may only be true when posts_directly = true. Summary accounts cannot
-- carry flags; the flags would be meaningless because nothing posts there.
create or replace function tg_coa_check_flags_require_posting()
returns trigger language plpgsql as $$
begin
  if not new.posts_directly
     and (new.is_pass_thru or new.is_ed_program_dollars or new.is_contribution) then
    raise exception
      'Governance flags can only be set on posting accounts. Account "%" is marked as a summary account; clear flags or change to posting.',
      new.name;
  end if;
  return new;
end;
$$;

create trigger coa_check_flags_require_posting
  before insert or update on chart_of_accounts
  for each row execute function tg_coa_check_flags_require_posting();

-- ---- 4. is_posting_account() helper --------------------------------------
-- Replaces is_leaf_account() for budget validation purposes. Budget rows
-- (Migration 006, the renumbered budget refactor) will reference posting
-- accounts, not strictly leaves. is_leaf_account() remains in the schema
-- for any callers that still want pure leaf semantics, but is deprecated
-- for COA validation.
create or replace function is_posting_account(p_account_id uuid)
returns boolean language sql stable as $$
  select posts_directly from chart_of_accounts where id = p_account_id;
$$;

grant execute on function is_posting_account(uuid) to authenticated;

-- ---- 5. Restate base table grants (idempotent) ---------------------------
-- Per the GRANT discipline note in CLAUDE.md: every migration that touches
-- a new table should re-state the base grants. Idempotent if already in
-- place from Migration 004's amended file.
grant select, insert, update, delete on chart_of_accounts to authenticated;

-- ============================================================================
-- END OF MIGRATION 005
-- ============================================================================
