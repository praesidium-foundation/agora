-- ============================================================================
-- Migration 009: Preliminary Budget — refactored to scenario + line model
--
-- Replaces the legacy flat `preliminary_budget` and `final_budget` tables
-- (Migration 001, line-item rows with text categories) with a multi-scenario
-- structure backed by the Chart of Accounts spine. This is the Migration
-- documented as "008 Refactor" in earlier Appendix B drafts; renumbered to
-- 009 because Migration 008 was used by the Annual Rhythm Settings change.
--
-- Architecture references: Section 4.4 (Budget row schema), Section 8 (the
-- whole module), Section 8.7 (multi-scenario), Section 8.9 (lock workflow),
-- Section 5.1 (snapshot immutability).
--
-- What this migration creates:
--
--   preliminary_budget_scenarios     — header per scenario (label, state,
--                                       narrative, audit, lock metadata)
--   preliminary_budget_lines         — one row per (scenario, account)
--   budget_snapshots                 — atomic capture at lock time
--   budget_snapshot_lines            — captured account state + amount
--   scenario_includes_account()      — helper for "is this account in the
--                                       active scenario?" UI checks
--   tg_prevent_snapshot_update()     — blocks UPDATEs on snapshot tables
--   tg_check_scenario_not_locked()   — blocks line writes when parent
--                                       scenario is locked
--   tg_validate_pb_line_account()    — enforces posting-only and
--                                       not-pass-thru for line account FKs
--
-- What this migration drops:
--
--   preliminary_budget (legacy flat structure)
--   final_budget (legacy flat structure)
--   triggers attached to the above
--
-- A separate, future migration will introduce the Final Budget tables in
-- the same shape. For session one we ship Preliminary only.
-- ============================================================================

-- ---- 0. Extend budget_source_type enum -----------------------------------

-- Original enum (Migration 001) covered manual / linked_staffing /
-- linked_tuition. Architecture Section 3.5 also lists Enrollment Estimator
-- as a Budget feed; add the corresponding source value now so
-- `preliminary_budget_lines.source_type` doesn't need a follow-up migration
-- when the Enrollment integration ships.
alter type budget_source_type add value if not exists 'linked_enrollment';

-- ---- 1. Drop legacy budget tables ----------------------------------------

-- These tables held the v0 flat-list budget shape. No production data is
-- expected at this stage (Phase 1 was COA-only). Their change_log triggers
-- and module-locked-check triggers go with the table drops.
drop table if exists final_budget cascade;
drop table if exists preliminary_budget cascade;

-- ---- 2. preliminary_budget_scenarios -------------------------------------

create table preliminary_budget_scenarios (
  id                       uuid primary key default gen_random_uuid(),
  aye_id                   uuid not null references academic_years(id) on delete cascade,

  scenario_label           text not null,
  description              text,
  is_recommended           boolean not null default false,

  -- Per-scenario lifecycle state. Distinct from `module_instances.state`
  -- (which is per-module-per-AYE) — multiple scenarios can be in different
  -- states under the same module instance. Stored as text + CHECK rather
  -- than reusing the `module_state` enum because the value vocabulary
  -- here ('drafting' vs 'draft') is intentionally different — this is a
  -- scenario, not a module instance.
  state                    text not null default 'drafting'
                           check (state in (
                             'drafting',
                             'pending_lock_review',
                             'locked',
                             'pending_unlock_review'
                           )),

  -- Optional contextual narrative. Section 8.8 notes this is Preliminary-
  -- only and renders in the Operating Budget Detail PDF when set and
  -- `show_narrative_in_pdf = true`.
  narrative                text,
  show_narrative_in_pdf    boolean not null default true,

  -- Locked-state metadata. NULL until the scenario transitions to locked.
  locked_at                timestamptz,
  locked_by                uuid references auth.users(id),
  -- 'normal' for clean lock, 'override' when admin overrode validation.
  locked_via               text,

  -- Override justification (Section 2.3). Captured at submit time when
  -- the user with admin perm overrode cascade-rule validation. Required
  -- when locked_via = 'override'; enforced at the app layer (the form
  -- demands it before submit).
  override_justification   text,

  -- Audit
  created_at               timestamptz not null default now(),
  created_by               uuid references auth.users(id),
  updated_at               timestamptz not null default now(),
  updated_by               uuid references auth.users(id)
);

create index pbs_aye_state_idx
  on preliminary_budget_scenarios (aye_id, state);

-- Only one locked scenario per AYE may be marked recommended. Multiple
-- drafting scenarios can be marked recommended (the user may be sketching
-- alternates); only the locked one matters as "the official choice."
create unique index pbs_one_recommended_locked_per_aye
  on preliminary_budget_scenarios (aye_id)
  where is_recommended = true and state = 'locked';

create trigger preliminary_budget_scenarios_updated_at
  before update on preliminary_budget_scenarios
  for each row execute function tg_set_updated_at();

create trigger preliminary_budget_scenarios_change_log
  after insert or update or delete on preliminary_budget_scenarios
  for each row execute function tg_log_changes();

-- ---- 3. preliminary_budget_lines -----------------------------------------

create table preliminary_budget_lines (
  id                              uuid primary key default gen_random_uuid(),
  scenario_id                     uuid not null
                                  references preliminary_budget_scenarios(id)
                                  on delete cascade,
  account_id                      uuid not null references chart_of_accounts(id),

  -- numeric (no scale) so contra-revenue (negative discounts) and large
  -- school budgets both fit without bound. App layer normalizes on input.
  amount                          numeric not null default 0,

  source_type                     budget_source_type not null default 'manual',
  source_ref_id                   uuid,

  -- Strategic Plan linkage placeholders. The Strategic Plan module ships
  -- in a later phase; the columns are reserved here so the FK additions
  -- later are pure ALTER COLUMN, not a structural migration.
  linked_strategic_initiative_id  uuid,
  linked_operational_action_id    uuid,

  notes                           text,

  created_at                      timestamptz not null default now(),
  created_by                      uuid references auth.users(id),
  updated_at                      timestamptz not null default now(),
  updated_by                      uuid references auth.users(id),

  unique (scenario_id, account_id)
);

create index pbl_scenario_idx on preliminary_budget_lines (scenario_id);
create index pbl_account_idx  on preliminary_budget_lines (account_id);

create trigger preliminary_budget_lines_updated_at
  before update on preliminary_budget_lines
  for each row execute function tg_set_updated_at();

create trigger preliminary_budget_lines_change_log
  after insert or update or delete on preliminary_budget_lines
  for each row execute function tg_log_changes();

-- ---- 4. Validation: line account must be posting + not pass-thru ---------

create or replace function tg_validate_pb_line_account()
returns trigger language plpgsql
security definer set search_path = public
as $$
declare
  v_posts_directly boolean;
  v_is_pass_thru   boolean;
  v_account_name   text;
begin
  select coa.posts_directly, coa.is_pass_thru, coa.name
    into v_posts_directly, v_is_pass_thru, v_account_name
    from chart_of_accounts coa
   where coa.id = NEW.account_id;

  if v_posts_directly is null then
    raise exception 'Account % not found in chart_of_accounts', NEW.account_id;
  end if;

  if not v_posts_directly then
    raise exception
      'Budget lines must reference posting accounts. "%" is a summary account.',
      v_account_name;
  end if;

  if v_is_pass_thru then
    raise exception
      'Pass-thru accounts are excluded from operating budgets. "%" is pass-thru.',
      v_account_name;
  end if;

  return NEW;
end;
$$;

create trigger preliminary_budget_lines_validate_account
  before insert or update on preliminary_budget_lines
  for each row execute function tg_validate_pb_line_account();

-- ---- 5. Validation: line writes blocked when parent scenario is locked ---

-- Locked scenarios are immutable from the line-item side. State transitions
-- on the scenario itself flow through the scenarios table and are governed
-- by the lock workflow (Section 8.9) — not blocked here. System admins
-- bypass for break-glass cases.
create or replace function tg_check_scenario_not_locked()
returns trigger language plpgsql
security definer set search_path = public
as $$
declare
  v_scenario_id uuid;
  v_state       text;
begin
  v_scenario_id := case
    when tg_op = 'DELETE' then OLD.scenario_id
    else NEW.scenario_id
  end;

  select state into v_state
    from preliminary_budget_scenarios
   where id = v_scenario_id;

  -- Scenario already deleted (cascade in flight): allow.
  if v_state is null then
    return case when tg_op = 'DELETE' then OLD else NEW end;
  end if;

  if v_state in ('locked', 'pending_lock_review', 'pending_unlock_review')
     and not is_system_admin() then
    raise exception
      'Scenario is %; line writes blocked. Reopen the scenario via the unlock workflow first.',
      v_state;
  end if;

  return case when tg_op = 'DELETE' then OLD else NEW end;
end;
$$;

create trigger preliminary_budget_lines_scenario_lock_check
  before insert or update or delete on preliminary_budget_lines
  for each row execute function tg_check_scenario_not_locked();

-- ---- 6. budget_snapshots -------------------------------------------------

create table budget_snapshots (
  id                                  uuid primary key default gen_random_uuid(),
  scenario_id                         uuid not null
                                      references preliminary_budget_scenarios(id),
  aye_id                              uuid not null references academic_years(id),

  -- Distinguishes preliminary vs. final snapshots. Final snapshots will
  -- arrive via the Final Budget migration; the field is here from day one
  -- so the snapshot table is shared across both.
  snapshot_type                       text not null default 'preliminary'
                                      check (snapshot_type in ('preliminary', 'final')),

  -- Captured at lock time. Snapshotting these (rather than joining back to
  -- the scenarios table) means the snapshot still renders correctly even
  -- if the scenario is renamed or its description changes after lock.
  scenario_label                      text not null,
  scenario_description                text,
  narrative                           text,
  show_narrative_in_pdf               boolean not null,
  is_recommended                      boolean not null,

  -- Captured upstream module references at lock time. NULL until those
  -- modules ship and are wired in (session one: all NULL).
  tuition_scenario_snapshot_id          uuid,
  staffing_scenario_snapshot_id         uuid,
  enrollment_estimate_snapshot_id       uuid,
  strategic_financial_plan_snapshot_id  uuid,

  -- Captured upstream module STATES at lock time. NULL when the upstream
  -- module didn't yet exist; populated when it does. Specifically for
  -- Staffing, which can be locked at 'projected' state when Preliminary
  -- locks (Section 3.4 exception).
  staffing_state_at_lock              text,

  -- Captured KPIs at lock time (Section 5.1, Section 8.4).
  kpi_total_income                    numeric,
  kpi_total_expenses                  numeric,
  kpi_net_income                      numeric,
  kpi_ed_program_dollars              numeric,
  kpi_ed_program_ratio                numeric,
  kpi_contributions_total             numeric,
  kpi_pct_personnel                   numeric,

  -- Lock metadata. locked_via = 'normal' or 'override'.
  locked_at                           timestamptz not null,
  locked_by                           uuid not null references auth.users(id),
  locked_via                          text,
  override_justification              text,

  created_at                          timestamptz not null default now(),
  created_by                          uuid references auth.users(id)
);

create index bs_scenario_idx on budget_snapshots (scenario_id);
create index bs_aye_idx      on budget_snapshots (aye_id, snapshot_type);

create trigger budget_snapshots_change_log
  after insert or delete on budget_snapshots
  for each row execute function tg_log_changes();
-- NOTE: no AFTER UPDATE arm; the immutability trigger below blocks updates
-- before they reach the change_log trigger.

-- ---- 7. budget_snapshot_lines --------------------------------------------

create table budget_snapshot_lines (
  id                          uuid primary key default gen_random_uuid(),
  snapshot_id                 uuid not null
                              references budget_snapshots(id) on delete cascade,

  -- Captured account state at lock time. account_id is nullable because the
  -- account may be hard-deleted post-lock (Migration 007 allowed that
  -- deliberately, with the snapshot serving as the lasting record). The
  -- text fields are the canonical render source.
  account_id                  uuid references chart_of_accounts(id),
  account_code                text,
  account_name                text not null,
  account_type                text not null,
  account_hierarchy_path      text not null,
  is_pass_thru                boolean not null,
  is_ed_program_dollars       boolean not null,
  is_contribution             boolean not null,

  amount                      numeric not null,
  source_type                 budget_source_type not null,
  notes                       text
);

create index bsl_snapshot_idx on budget_snapshot_lines (snapshot_id);
create index bsl_account_idx  on budget_snapshot_lines (account_id);

create trigger budget_snapshot_lines_change_log
  after insert or delete on budget_snapshot_lines
  for each row execute function tg_log_changes();

-- ---- 8. Snapshot immutability (Section 5.1) ------------------------------

-- The architecture rule: snapshots are insert-only. Once written they are
-- never modified. A trigger raises on any UPDATE attempt, providing a
-- belt-and-suspenders defense alongside the RLS write policy (which has
-- no UPDATE arm).
create or replace function tg_prevent_snapshot_update()
returns trigger language plpgsql as $$
begin
  raise exception 'Snapshots are immutable. UPDATE on % is not allowed.',
    tg_table_name;
end;
$$;

create trigger budget_snapshots_no_update
  before update on budget_snapshots
  for each row execute function tg_prevent_snapshot_update();

create trigger budget_snapshot_lines_no_update
  before update on budget_snapshot_lines
  for each row execute function tg_prevent_snapshot_update();

-- ---- 9. Helper: scenario_includes_account ---------------------------------

-- True iff the (scenario, account) pair has a row in
-- preliminary_budget_lines. The auto-detect notification (Section G of
-- the build spec) uses this with the COA query "find posting non-pass-thru
-- active accounts not in the active scenario."
create or replace function scenario_includes_account(
  p_scenario_id uuid,
  p_account_id  uuid
)
returns boolean language sql stable as $$
  select exists (
    select 1 from preliminary_budget_lines
     where scenario_id = p_scenario_id
       and account_id  = p_account_id
  );
$$;

grant execute on function scenario_includes_account(uuid, uuid) to authenticated;

-- ---- 10. Module + permission seeds ---------------------------------------

-- The 'preliminary_budget' module was seeded in Migration 001. The on-
-- conflict-do-nothing here is defensive; if a future migration relocates
-- the seed, this still runs idempotently.
insert into modules (code, display_name, category, requires_lock_workflow, is_active, sort_order)
values ('preliminary_budget', 'Preliminary Budget', 'financial', true, true, 40)
on conflict (code) do nothing;

-- Seed admin permission for every system admin (Migration 004 used the
-- same pattern for chart_of_accounts).
insert into user_module_permissions (user_id, module_id, permission_level, granted_by)
select up.id, m.id, 'admin'::permission_level, up.id
  from user_profiles up
  cross join modules m
 where up.is_system_admin = true
   and m.code = 'preliminary_budget'
on conflict (user_id, module_id) do nothing;

-- ---- 11. RLS -------------------------------------------------------------

alter table preliminary_budget_scenarios enable row level security;
alter table preliminary_budget_lines     enable row level security;
alter table budget_snapshots             enable row level security;
alter table budget_snapshot_lines        enable row level security;

-- Scenarios: read with view, write with edit.
create policy pb_scenarios_read on preliminary_budget_scenarios
  for select to authenticated
  using (current_user_has_module_perm('preliminary_budget', 'view'));

create policy pb_scenarios_write on preliminary_budget_scenarios
  for all to authenticated
  using (current_user_has_module_perm('preliminary_budget', 'edit'))
  with check (current_user_has_module_perm('preliminary_budget', 'edit'));

-- Lines: same gating.
create policy pb_lines_read on preliminary_budget_lines
  for select to authenticated
  using (current_user_has_module_perm('preliminary_budget', 'view'));

create policy pb_lines_write on preliminary_budget_lines
  for all to authenticated
  using (current_user_has_module_perm('preliminary_budget', 'edit'))
  with check (current_user_has_module_perm('preliminary_budget', 'edit'));

-- Snapshots: read with view; INSERT requires submit_lock or higher;
-- UPDATE/DELETE forbidden by trigger and absence of policy arms.
create policy budget_snapshots_read on budget_snapshots
  for select to authenticated
  using (current_user_has_module_perm('preliminary_budget', 'view'));

create policy budget_snapshots_insert on budget_snapshots
  for insert to authenticated
  with check (current_user_has_module_perm('preliminary_budget', 'submit_lock'));

create policy budget_snapshot_lines_read on budget_snapshot_lines
  for select to authenticated
  using (current_user_has_module_perm('preliminary_budget', 'view'));

create policy budget_snapshot_lines_insert on budget_snapshot_lines
  for insert to authenticated
  with check (current_user_has_module_perm('preliminary_budget', 'submit_lock'));

-- ---- 12. Extend change_log read policy with new arms ---------------------

-- Same DROP+RECREATE-with-all-arms pattern as Migration 008. The arms for
-- the four new tables all gate behind `preliminary_budget` view perm —
-- snapshots are part of the budget audit history and follow the module's
-- read gate.
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
      when 'school_lock_cascade_rules'      then true
      -- New in Migration 009:
      when 'preliminary_budget_scenarios'   then current_user_has_module_perm('preliminary_budget', 'view')
      when 'preliminary_budget_lines'       then current_user_has_module_perm('preliminary_budget', 'view')
      when 'budget_snapshots'               then current_user_has_module_perm('preliminary_budget', 'view')
      when 'budget_snapshot_lines'          then current_user_has_module_perm('preliminary_budget', 'view')
      else false
    end
  );

-- ---- 13. Seed Libertas's lock cascade rules ------------------------------

-- Architecture Section 3.4: Preliminary Budget requires Tuition Worksheet
-- locked AND Enrollment Estimator locked before it can lock. Staffing is
-- the documented exception (allowed in projected state). Admin override
-- is always available with required justification.
--
-- For session one these rules largely no-op because the upstream modules
-- don't yet have lockable scenario state. The Submit-for-Lock-Review flow
-- treats unsatisfied rules as "needs override," which is fine — every
-- first-time Preliminary lock will go through override with a justification
-- that's logged. As Tuition Worksheet and Enrollment Estimator gain real
-- lock states in later sessions, the rules become real.

insert into school_lock_cascade_rules (module_being_locked, required_module, required_state, is_required)
values
  ('preliminary_budget', 'tuition_worksheet',    'locked', true),
  ('preliminary_budget', 'enrollment_estimator', 'locked', true)
on conflict (module_being_locked, required_module) do nothing;

-- ============================================================================
-- END OF MIGRATION 009
-- ============================================================================
