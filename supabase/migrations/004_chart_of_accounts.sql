-- ============================================================================
-- Migration 004: Chart of Accounts schema
--
-- Self-referential hierarchical chart of accounts that mirrors the school's
-- accounting system (typically QuickBooks). Per architecture Section 4.
--
-- Includes:
--   1. chart_of_accounts table + indexes
--   2. account_type inheritance trigger (children must match parent's type)
--   3. Leaf-only governance flag trigger (is_pass_thru, is_ed_program_dollars,
--      is_contribution may only be true on accounts with no children;
--      adding a child under a flagged account is rejected)
--   4. Semantic flag CHECK constraint (is_ed_program_dollars and
--      is_contribution only meaningful for income, non-pass-thru accounts)
--   5. Cycle-prevention trigger on parent_id UPDATEs
--   6. is_leaf_account() helper for downstream tables (e.g. budget rows)
--      to validate they reference leaf accounts only
--   7. RLS keyed off the chart_of_accounts module permission
--   8. modules-table registration + admin permission seed for system admins
--   9. Extension to change_log read policy so audit history is visible
--
-- Numbering note: this migration is 004, not 003 as originally planned in
-- the architecture doc v1.0. Migration 003 (tuition target ratio fix) was
-- implemented in the interim. See architecture doc v1.1 for the corrected
-- migration sequence.
-- ============================================================================

-- ---- chart_of_accounts table ----------------------------------------------

create table chart_of_accounts (
  id                     uuid primary key default gen_random_uuid(),
  parent_id              uuid references chart_of_accounts(id),  -- null = top-level
  code                   text,                                   -- optional QB-style code
  name                   text not null,
  account_type           text not null check (account_type in ('income', 'expense')),

  -- Governance flags (only meaningful for leaf accounts — see triggers below)
  is_pass_thru           boolean not null default false,
  is_ed_program_dollars  boolean not null default false,
  is_contribution        boolean not null default false,

  -- Lifecycle
  is_active              boolean not null default true,

  -- Display
  sort_order             int not null default 0,
  notes                  text,

  -- Audit
  created_at             timestamptz not null default now(),
  created_by             uuid references auth.users(id),
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users(id),

  -- Semantic flag rule:
  -- is_ed_program_dollars and is_contribution are only meaningful when the
  -- account is income AND not a pass-through. For expense accounts or
  -- pass-throughs, both flags must be false.
  constraint coa_semantic_flags check (
    (account_type = 'income' and not is_pass_thru)
    or (not is_ed_program_dollars and not is_contribution)
  )
);

create index coa_parent_idx on chart_of_accounts(parent_id);
create index coa_active_idx on chart_of_accounts(is_active) where is_active = true;
create index coa_type_idx   on chart_of_accounts(account_type);

-- ---- Trigger: account_type inheritance ------------------------------------
-- A child's account_type must equal its parent's. Cannot mix income/expense
-- within a single tree.
create or replace function tg_coa_check_type_inheritance()
returns trigger language plpgsql as $$
declare
  v_parent_type text;
begin
  if new.parent_id is not null then
    select account_type into v_parent_type
      from chart_of_accounts where id = new.parent_id;
    if v_parent_type is distinct from new.account_type then
      raise exception
        'Account type % does not match parent''s type %',
        new.account_type, v_parent_type;
    end if;
  end if;
  return new;
end;
$$;

create trigger coa_check_type_inheritance
  before insert or update on chart_of_accounts
  for each row execute function tg_coa_check_type_inheritance();

-- ---- Trigger: leaf-only governance flags ----------------------------------
-- Flags (is_pass_thru, is_ed_program_dollars, is_contribution) may only be
-- true on accounts with no children. Two cases this trigger blocks:
--   (a) Setting any flag = true on an account that has children.
--   (b) Inserting/updating a row to attach to a parent that currently has
--       flags = true (which would make the parent a non-leaf and violate
--       its invariant).
create or replace function tg_coa_check_leaf_only_flags()
returns trigger language plpgsql as $$
declare
  v_self_has_children boolean;
  v_parent_flagged    boolean;
begin
  -- Case (a): if any flag is true on this row, it must be a leaf.
  if (new.is_pass_thru or new.is_ed_program_dollars or new.is_contribution) then
    select exists (select 1 from chart_of_accounts where parent_id = new.id)
      into v_self_has_children;
    if v_self_has_children then
      raise exception
        'Cannot set governance flags on account "%": it has children. Flags are valid only on leaf accounts.',
        new.name;
    end if;
  end if;

  -- Case (b): if attaching to a parent, the parent must not be flagged
  -- (parents lose their leaf status when a child is added).
  if new.parent_id is not null then
    select (is_pass_thru or is_ed_program_dollars or is_contribution)
      into v_parent_flagged
      from chart_of_accounts where id = new.parent_id;
    if v_parent_flagged then
      raise exception
        'Cannot add a child under a flagged account. Clear governance flags on the parent first.';
    end if;
  end if;

  return new;
end;
$$;

create trigger coa_check_leaf_only_flags
  before insert or update on chart_of_accounts
  for each row execute function tg_coa_check_leaf_only_flags();

-- ---- Trigger: cycle prevention --------------------------------------------
-- On UPDATE where parent_id changes, walk up from the new parent. If we hit
-- this row's own id, reparenting would create a cycle.
create or replace function tg_coa_check_no_cycle()
returns trigger language plpgsql as $$
declare
  v_check_id uuid;
  v_steps    int := 0;
begin
  if new.parent_id is not null
     and new.parent_id is distinct from old.parent_id then
    v_check_id := new.parent_id;
    while v_check_id is not null and v_steps < 100 loop
      if v_check_id = new.id then
        raise exception
          'Reparenting "%" would create a cycle (it would become its own ancestor).',
          new.name;
      end if;
      select parent_id into v_check_id
        from chart_of_accounts where id = v_check_id;
      v_steps := v_steps + 1;
    end loop;
  end if;
  return new;
end;
$$;

create trigger coa_check_no_cycle
  before update on chart_of_accounts
  for each row execute function tg_coa_check_no_cycle();

-- ---- Trigger: updated_at ---------------------------------------------------
create trigger coa_updated_at
  before update on chart_of_accounts
  for each row execute function tg_set_updated_at();

-- ---- Trigger: change_log --------------------------------------------------
-- Generic field-level diff logging (defined in 001).
create trigger coa_change_log
  after insert or update or delete on chart_of_accounts
  for each row execute function tg_log_changes();

-- ---- Helper function: is_leaf_account --------------------------------------
-- Reusable check for downstream tables. Budget rows reference leaf accounts
-- only (architecture Section 4.4). Migration 005 (budget refactor) will call
-- this in its own constraint trigger.
create or replace function is_leaf_account(p_account_id uuid)
returns boolean language sql stable as $$
  select not exists (
    select 1 from chart_of_accounts where parent_id = p_account_id
  );
$$;

grant execute on function is_leaf_account(uuid) to authenticated;

-- ---- RLS -------------------------------------------------------------------
alter table chart_of_accounts enable row level security;

create policy coa_read on chart_of_accounts
  for select to authenticated
  using (current_user_has_module_perm('chart_of_accounts', 'view'));

create policy coa_write on chart_of_accounts
  for all to authenticated
  using (current_user_has_module_perm('chart_of_accounts', 'edit'))
  with check (current_user_has_module_perm('chart_of_accounts', 'edit'));

-- ---- Module registration --------------------------------------------------
-- requires_lock_workflow=false: COA is org-wide configuration, not AYE-scoped
-- data, so it does not participate in the lock/unlock workflow that gates
-- per-AYE module instances.
insert into modules (code, display_name, category, requires_lock_workflow, is_active, sort_order)
values ('chart_of_accounts', 'Chart of Accounts', 'financial', false, true, 5)
on conflict (code) do nothing;

-- ---- Permission seed for system admins ------------------------------------
-- current_user_has_module_perm() auto-grants for system admins, but seeding
-- explicit rows makes the permission state legible in any future Users &
-- Access UI.
insert into user_module_permissions (user_id, module_id, permission_level, granted_by)
select
  up.id,
  m.id,
  'admin'::permission_level,
  up.id
from user_profiles up
cross join modules m
where up.is_system_admin = true
  and m.code = 'chart_of_accounts'
on conflict (user_id, module_id) do nothing;

-- ---- Extend change_log read policy to cover chart_of_accounts -------------
-- The existing policy keys read access off the module each row's target_table
-- relates to, with an `else false` fallback. Replace it to add a
-- chart_of_accounts arm.
drop policy if exists change_log_read on change_log;

create policy change_log_read on change_log
  for select to authenticated
  using (
    is_system_admin() or
    case target_table
      when 'staff'                          then current_user_has_module_perm('staffing', 'view')
      when 'academic_years'                 then true
      when 'aye_grade_sections'             then current_user_has_module_perm('enrollment_estimator', 'view')
      when 'enrollment_monthly'             then current_user_has_module_perm('enrollment_estimator', 'view')
      when 'tuition_worksheet'              then current_user_has_module_perm('tuition_worksheet', 'view')
      when 'tuition_scenarios'              then current_user_has_module_perm('tuition_worksheet', 'view')
      when 'staffing_scenarios'             then current_user_has_module_perm('staffing', 'view')
      when 'staffing_scenario_positions'    then current_user_has_module_perm('staffing', 'view')
      when 'preliminary_budget'             then current_user_has_module_perm('preliminary_budget', 'view')
      when 'final_budget'                   then current_user_has_module_perm('final_budget', 'view')
      when 'enrollment_audit_families'      then
        current_user_has_module_perm('enrollment_audit', 'view')
        and can_view_family_details(auth.uid())
      when 'enrollment_audit_summary'       then current_user_has_module_perm('enrollment_audit', 'view')
      when 'chart_of_accounts'              then current_user_has_module_perm('chart_of_accounts', 'view')
      else false
    end
  );

-- ---- Base table grants ----------------------------------------------------
-- Migration 001's `grant ... on all tables in schema public to authenticated`
-- is a one-time grant; tables added in later migrations don't inherit. Without
-- this, RLS-protected operations error with "permission denied for table"
-- before the RLS policy is even evaluated.
grant select, insert, update, delete on chart_of_accounts to authenticated;

-- ============================================================================
-- END OF MIGRATION 004
-- ============================================================================
