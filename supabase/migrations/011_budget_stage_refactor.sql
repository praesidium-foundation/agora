-- ============================================================================
-- Migration 011: Budget tables refactored to reference workflow stages
--
-- Migration 009 created Budget tables that hardcoded "Preliminary" as a
-- structural distinction (preliminary_budget_scenarios, snapshot_type =
-- 'preliminary' | 'final'). Migration 010 introduced the workflow + stage
-- framework; this migration ports the Budget tables onto stages.
--
-- The old tables (preliminary_budget_scenarios, preliminary_budget_lines,
-- budget_snapshots, budget_snapshot_lines) had no production data — only
-- Phase 2 Session One test data which is disposable. Drop and recreate.
--
-- The module previously coded as 'preliminary_budget' is renamed to
-- 'budget'. The workflow defines whether it has Preliminary, Final,
-- Reforecast, or other stages; the module code is just "Budget."
-- ============================================================================

-- ---- 1. Drop old tables --------------------------------------------------

-- CASCADE removes the dependent change_log triggers and lock-check
-- triggers that referenced these tables in Migration 009.
drop table if exists budget_snapshot_lines           cascade;
drop table if exists budget_snapshots                cascade;
drop table if exists preliminary_budget_lines        cascade;
drop table if exists preliminary_budget_scenarios    cascade;

-- The triggers above cascade-delete; the helper functions from Migration
-- 009 stay (they're not table-bound). Defensively drop the
-- scenario-not-locked check function — Migration 011 recreates an
-- equivalent on the new tables, but we drop and replace to be clean.
drop function if exists tg_check_scenario_not_locked();
drop function if exists tg_validate_pb_line_account();
drop function if exists scenario_includes_account(uuid, uuid);

-- ---- 2. Rename module code: preliminary_budget -> budget ----------------

-- The "Preliminary" / "Final" distinction is now a stage attribute, not
-- a module attribute. Rename to reflect the generalization.
--
-- FK references in user_module_permissions, school_lock_cascade_rules,
-- module_instances, module_workflows all use module_id (uuid), so the
-- rename is transparent to them. The cascade rule rows that referenced
-- 'preliminary_budget' as a TEXT code DO need updating (next step).
update modules
   set code = 'budget',
       display_name = 'Budget'
 where code = 'preliminary_budget';

-- ---- 3. Update cascade rules that referenced the old code ---------------

-- Module rename leaves text-keyed cascade rules pointing at the dead
-- code. The validation trigger from Migration 008 demands the new code
-- exists in modules (it now does, since we just renamed it).
update school_lock_cascade_rules
   set module_being_locked = 'budget'
 where module_being_locked = 'preliminary_budget';

-- (required_module references like 'tuition_worksheet' don't change.)

-- ---- 4. budget_stage_scenarios (was preliminary_budget_scenarios) -------

-- Scope is now (AYE, Stage). One scenario set per stage of the workflow.
-- Locked + recommended scenarios are unique per (AYE, Stage), not per AYE.
create table budget_stage_scenarios (
  id                       uuid primary key default gen_random_uuid(),
  aye_id                   uuid not null references academic_years(id) on delete cascade,
  stage_id                 uuid not null references module_workflow_stages(id),

  scenario_label           text not null,
  description              text,
  is_recommended           boolean not null default false,

  state                    text not null default 'drafting'
                           check (state in (
                             'drafting',
                             'pending_lock_review',
                             'locked',
                             'pending_unlock_review'
                           )),

  narrative                text,
  show_narrative_in_pdf    boolean not null default true,

  locked_at                timestamptz,
  locked_by                uuid references auth.users(id),
  locked_via               text,
  override_justification   text,

  created_at               timestamptz not null default now(),
  created_by               uuid references auth.users(id),
  updated_at               timestamptz not null default now(),
  updated_by               uuid references auth.users(id)
);

create index budget_stage_scenarios_aye_stage_state
  on budget_stage_scenarios (aye_id, stage_id, state);

-- One locked + recommended scenario per (AYE, Stage). Multiple drafting
-- scenarios per (AYE, Stage) are allowed; only the locked one is
-- "official." Two stages (e.g. Preliminary and Final for the same AYE)
-- can each have their own locked + recommended scenario.
create unique index budget_stage_scenarios_one_locked_recommended
  on budget_stage_scenarios (aye_id, stage_id)
  where is_recommended = true and state = 'locked';

create trigger budget_stage_scenarios_updated_at
  before update on budget_stage_scenarios
  for each row execute function tg_set_updated_at();

create trigger budget_stage_scenarios_change_log
  after insert or update or delete on budget_stage_scenarios
  for each row execute function tg_log_changes();

-- ---- 5. budget_stage_lines (was preliminary_budget_lines) ---------------

create table budget_stage_lines (
  id                              uuid primary key default gen_random_uuid(),
  scenario_id                     uuid not null
                                  references budget_stage_scenarios(id)
                                  on delete cascade,
  account_id                      uuid not null references chart_of_accounts(id),

  amount                          numeric not null default 0,

  source_type                     budget_source_type not null default 'manual',
  source_ref_id                   uuid,

  -- Strategic Plan linkage placeholders (FK constraints add when the
  -- Strategic Plan module ships).
  linked_strategic_initiative_id  uuid,
  linked_operational_action_id    uuid,

  notes                           text,

  created_at                      timestamptz not null default now(),
  created_by                      uuid references auth.users(id),
  updated_at                      timestamptz not null default now(),
  updated_by                      uuid references auth.users(id),

  unique (scenario_id, account_id)
);

create index budget_stage_lines_scenario_idx on budget_stage_lines (scenario_id);
create index budget_stage_lines_account_idx  on budget_stage_lines (account_id);

create trigger budget_stage_lines_updated_at
  before update on budget_stage_lines
  for each row execute function tg_set_updated_at();

create trigger budget_stage_lines_change_log
  after insert or update or delete on budget_stage_lines
  for each row execute function tg_log_changes();

-- Account-shape validation (posting + non-pass-thru). Same logic as the
-- dropped trigger from Migration 009; renamed for the new table.
create or replace function tg_validate_budget_line_account()
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

create trigger budget_stage_lines_validate_account
  before insert or update on budget_stage_lines
  for each row execute function tg_validate_budget_line_account();

-- Locked-scenario writes blocked at the line level. The scenario state
-- table can be UPDATEd (state transitions need to flow); the lines
-- table is what gets frozen.
create or replace function tg_check_budget_scenario_not_locked()
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
    from budget_stage_scenarios
   where id = v_scenario_id;

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

create trigger budget_stage_lines_scenario_lock_check
  before insert or update or delete on budget_stage_lines
  for each row execute function tg_check_budget_scenario_not_locked();

-- ---- 6. budget_snapshots (stage-aware) ----------------------------------

-- snapshot_type from old design is replaced by stage_id. Stage metadata
-- (name + short name + type code) is captured at lock time so post-lock
-- workflow renames don't disturb history.
create table budget_snapshots (
  id                                  uuid primary key default gen_random_uuid(),
  scenario_id                         uuid not null references budget_stage_scenarios(id),
  aye_id                              uuid not null references academic_years(id),
  stage_id                            uuid not null references module_workflow_stages(id),

  -- Captured at lock time: scenario metadata.
  scenario_label                      text not null,
  scenario_description                text,
  narrative                           text,
  show_narrative_in_pdf               boolean not null,
  is_recommended                      boolean not null,

  -- Captured at lock time: stage metadata. Display labels can be edited
  -- after the snapshot exists; the snapshot remembers what they were
  -- when the scenario was locked.
  stage_display_name_at_lock          text not null,
  stage_short_name_at_lock            text not null,
  stage_type_at_lock                  text not null,

  -- Captured upstream module references at lock time (NULL until those
  -- modules ship and are wired in).
  tuition_scenario_snapshot_id          uuid,
  staffing_scenario_snapshot_id         uuid,
  enrollment_estimate_snapshot_id       uuid,
  strategic_financial_plan_snapshot_id  uuid,

  staffing_state_at_lock              text,

  -- Captured KPIs.
  kpi_total_income                    numeric,
  kpi_total_expenses                  numeric,
  kpi_net_income                      numeric,
  kpi_ed_program_dollars              numeric,
  kpi_ed_program_ratio                numeric,
  kpi_contributions_total             numeric,
  kpi_pct_personnel                   numeric,

  -- Lock metadata.
  locked_at                           timestamptz not null,
  locked_by                           uuid not null references auth.users(id),
  locked_via                          text,
  override_justification              text,

  created_at                          timestamptz not null default now(),
  created_by                          uuid references auth.users(id)
);

create index budget_snapshots_aye_stage_idx on budget_snapshots (aye_id, stage_id);
create index budget_snapshots_scenario_idx  on budget_snapshots (scenario_id);

-- Immutability trigger from Migration 009 still exists (function-level,
-- not table-bound); apply it to the new snapshot tables.
create trigger budget_snapshots_no_update
  before update on budget_snapshots
  for each row execute function tg_prevent_snapshot_update();

-- INSERT/DELETE only on change_log — UPDATE is blocked above.
create trigger budget_snapshots_change_log
  after insert or delete on budget_snapshots
  for each row execute function tg_log_changes();

-- ---- 7. budget_snapshot_lines (carried forward, account_id ON DELETE SET NULL) ---

-- account_id is nullable AND ON DELETE SET NULL because Migration 007
-- deliberately allows hard-delete of orphan COA accounts post-lock; the
-- snapshot's text fields remain the canonical render.
create table budget_snapshot_lines (
  id                          uuid primary key default gen_random_uuid(),
  snapshot_id                 uuid not null references budget_snapshots(id) on delete cascade,

  account_id                  uuid references chart_of_accounts(id) on delete set null,
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

create index budget_snapshot_lines_snapshot_idx on budget_snapshot_lines (snapshot_id);
create index budget_snapshot_lines_account_idx  on budget_snapshot_lines (account_id);

create trigger budget_snapshot_lines_no_update
  before update on budget_snapshot_lines
  for each row execute function tg_prevent_snapshot_update();

create trigger budget_snapshot_lines_change_log
  after insert or delete on budget_snapshot_lines
  for each row execute function tg_log_changes();

-- ---- 8. Helper: scenario_includes_account (renamed for new tables) ------

create or replace function scenario_includes_account(
  p_scenario_id uuid,
  p_account_id  uuid
)
returns boolean language sql stable as $$
  select exists (
    select 1 from budget_stage_lines
     where scenario_id = p_scenario_id
       and account_id  = p_account_id
  );
$$;

grant execute on function scenario_includes_account(uuid, uuid) to authenticated;

-- ---- 9. RLS --------------------------------------------------------------

alter table budget_stage_scenarios enable row level security;
alter table budget_stage_lines     enable row level security;
alter table budget_snapshots       enable row level security;
alter table budget_snapshot_lines  enable row level security;

create policy budget_scenarios_read on budget_stage_scenarios
  for select to authenticated
  using (current_user_has_module_perm('budget', 'view'));

create policy budget_scenarios_write on budget_stage_scenarios
  for all to authenticated
  using (current_user_has_module_perm('budget', 'edit'))
  with check (current_user_has_module_perm('budget', 'edit'));

create policy budget_lines_read on budget_stage_lines
  for select to authenticated
  using (current_user_has_module_perm('budget', 'view'));

create policy budget_lines_write on budget_stage_lines
  for all to authenticated
  using (current_user_has_module_perm('budget', 'edit'))
  with check (current_user_has_module_perm('budget', 'edit'));

create policy budget_snapshots_read on budget_snapshots
  for select to authenticated
  using (current_user_has_module_perm('budget', 'view'));

create policy budget_snapshots_insert on budget_snapshots
  for insert to authenticated
  with check (current_user_has_module_perm('budget', 'submit_lock'));

create policy budget_snapshot_lines_read on budget_snapshot_lines
  for select to authenticated
  using (current_user_has_module_perm('budget', 'view'));

create policy budget_snapshot_lines_insert on budget_snapshot_lines
  for insert to authenticated
  with check (current_user_has_module_perm('budget', 'submit_lock'));

-- ---- 10. Refresh change_log_read policy with new arms -------------------

-- The policy is the established DROP+RECREATE-with-all-arms pattern.
-- Old arms for preliminary_budget_scenarios / preliminary_budget_lines
-- removed (the tables no longer exist; entries still in change_log
-- remain readable to system admins via the catch-all). New arms added
-- for the four new budget tables and the two workflow tables.
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
      when 'enrollment_audit_families'      then
        current_user_has_module_perm('enrollment_audit', 'view')
        and can_view_family_details(auth.uid())
      when 'enrollment_audit_summary'       then current_user_has_module_perm('enrollment_audit', 'view')
      when 'chart_of_accounts'              then current_user_has_module_perm('chart_of_accounts', 'view')
      when 'school_lock_cascade_rules'      then true
      -- Workflow framework (Migration 010)
      when 'module_workflows'               then is_system_admin()
      when 'module_workflow_stages'         then is_system_admin()
      -- Budget (Migration 011 — replaces the old preliminary_budget_* arms)
      when 'budget_stage_scenarios'         then current_user_has_module_perm('budget', 'view')
      when 'budget_stage_lines'             then current_user_has_module_perm('budget', 'view')
      when 'budget_snapshots'               then current_user_has_module_perm('budget', 'view')
      when 'budget_snapshot_lines'          then current_user_has_module_perm('budget', 'view')
      else false
    end
  );

-- ============================================================================
-- END OF MIGRATION 011
-- ============================================================================
