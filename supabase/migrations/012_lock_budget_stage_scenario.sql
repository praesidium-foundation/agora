-- ============================================================================
-- Migration 012: Atomic lock for stage-aware Budget scenarios
--
-- Replaces the dropped-and-never-applied lock_preliminary_budget_scenario.
-- The new function is stage-agnostic — it works for any stage in the
-- Budget workflow (Preliminary, Final, Reforecast, etc.) and captures
-- the stage's display name / short name / type into the snapshot at
-- lock time so post-lock workflow renames don't disturb history.
--
-- Atomicity guarantee (architecture Section 5.1): if any step fails,
-- the whole transaction rolls back. There is no scenario where the
-- row says 'locked' but the snapshot is missing.
-- ============================================================================

-- ---- 1. coa_hierarchy_path -----------------------------------------------

-- Walks up parent_id chain from leaf to root and returns colon-delimited
-- "Top : Mid : Leaf". Captured by value into budget_snapshot_lines so the
-- snapshot still renders correctly after deactivation, hard-delete, or
-- reparenting of any account in the chain.
create or replace function coa_hierarchy_path(p_account_id uuid)
returns text
language sql stable
set search_path = public
as $$
  with recursive walk as (
    select id, name, parent_id, 0 as depth
      from chart_of_accounts
     where id = p_account_id
    union all
    select coa.id, coa.name, coa.parent_id, walk.depth + 1
      from chart_of_accounts coa
      join walk on walk.parent_id = coa.id
  )
  select string_agg(name, ' : ' order by depth desc)
    from walk
$$;

grant execute on function coa_hierarchy_path(uuid) to authenticated;

-- ---- 2. compute_budget_scenario_kpis -------------------------------------

-- Reused for two purposes: (a) live KPI sidebar reads (eventually — the
-- UI today computes client-side via budgetTree.js but can be migrated
-- here when consistent capture is needed), (b) the snapshot capture
-- inside the lock function below.
--
-- Personnel total is identified by name match on the top-level expense
-- account containing 'personnel' (case-insensitive). Brittle but matches
-- the existing JS computeKpis logic; future refinement makes Personnel
-- a school-configurable mapping.
create or replace function compute_budget_scenario_kpis(p_scenario_id uuid)
returns table (
  total_income          numeric,
  total_expenses        numeric,
  net_income            numeric,
  ed_program_dollars    numeric,
  ed_program_ratio      numeric,
  contributions_total   numeric,
  pct_personnel         numeric
)
language plpgsql stable
set search_path = public
as $$
declare
  v_total_income       numeric := 0;
  v_total_expense      numeric := 0;
  v_ed_program_dollars numeric := 0;
  v_contributions      numeric := 0;
  v_personnel_total    numeric := 0;
  v_personnel_id       uuid;
begin
  -- Top-level expense account named 'Personnel' (case-insensitive).
  select id into v_personnel_id
    from chart_of_accounts
   where parent_id is null
     and account_type = 'expense'
     and lower(trim(name)) = 'personnel'
   limit 1;

  -- Aggregates over budget lines × COA flags.
  select
    coalesce(sum(case when a.account_type = 'income'  and not a.is_pass_thru then l.amount end), 0),
    coalesce(sum(case when a.account_type = 'expense' and not a.is_pass_thru then l.amount end), 0),
    coalesce(sum(case when a.is_ed_program_dollars   and not a.is_pass_thru then l.amount end), 0),
    coalesce(sum(case when a.is_contribution         and not a.is_pass_thru then l.amount end), 0)
   into v_total_income, v_total_expense, v_ed_program_dollars, v_contributions
   from budget_stage_lines l
   join chart_of_accounts a on a.id = l.account_id
  where l.scenario_id = p_scenario_id;

  -- Personnel subtree (recursive walk).
  if v_personnel_id is not null then
    with recursive personnel_tree as (
      select id from chart_of_accounts where id = v_personnel_id
      union all
      select coa.id from chart_of_accounts coa
        join personnel_tree pt on coa.parent_id = pt.id
    )
    select coalesce(sum(l.amount), 0) into v_personnel_total
      from budget_stage_lines l
     where l.scenario_id = p_scenario_id
       and l.account_id in (select id from personnel_tree);
  end if;

  return query select
    v_total_income,
    v_total_expense,
    v_total_income - v_total_expense,
    v_ed_program_dollars,
    case when v_total_expense = 0 then null else v_ed_program_dollars / v_total_expense end,
    v_contributions,
    case when v_personnel_id is null or v_total_expense = 0
         then null
         else v_personnel_total / v_total_expense end;
end;
$$;

grant execute on function compute_budget_scenario_kpis(uuid) to authenticated;

-- ---- 3. lock_budget_stage_scenario ---------------------------------------

create or replace function lock_budget_stage_scenario(
  p_scenario_id            uuid,
  p_locked_via             text default 'normal',
  p_override_justification text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scenario     record;
  v_stage        record;
  v_kpis         record;
  v_snapshot_id  uuid;
  v_caller       uuid := auth.uid();
begin
  -- Permission gate. SECURITY DEFINER bypasses RLS but we still want
  -- to check the caller's permission via auth.uid().
  if not current_user_has_module_perm('budget', 'approve_lock') then
    raise exception 'Approve-and-lock requires approve_lock permission on budget.';
  end if;

  -- Lock + read scenario row.
  select * into v_scenario
    from budget_stage_scenarios
   where id = p_scenario_id
   for update;

  if v_scenario is null then
    raise exception 'Scenario % not found', p_scenario_id;
  end if;
  if v_scenario.state != 'pending_lock_review' then
    raise exception 'Scenario must be in pending_lock_review state to lock (current: %)', v_scenario.state;
  end if;
  if not v_scenario.is_recommended then
    raise exception 'Only the recommended scenario can be locked. Mark this scenario as recommended first.';
  end if;
  if p_locked_via not in ('normal', 'override') then
    raise exception 'locked_via must be ''normal'' or ''override''; got %', p_locked_via;
  end if;
  if p_locked_via = 'override' and (p_override_justification is null or length(trim(p_override_justification)) = 0) then
    raise exception 'Override requires a non-empty justification';
  end if;

  -- Capture stage metadata at lock time so post-lock label edits don't
  -- alter what this snapshot represents.
  select s.display_name, s.short_name, s.stage_type
    into v_stage
    from module_workflow_stages s
   where s.id = v_scenario.stage_id;

  if v_stage is null then
    raise exception 'Stage % referenced by scenario % not found', v_scenario.stage_id, p_scenario_id;
  end if;

  -- KPI capture.
  select * into v_kpis
    from compute_budget_scenario_kpis(p_scenario_id);

  -- Snapshot header.
  insert into budget_snapshots (
    scenario_id, aye_id, stage_id,
    scenario_label, scenario_description, narrative,
    show_narrative_in_pdf, is_recommended,
    stage_display_name_at_lock, stage_short_name_at_lock, stage_type_at_lock,
    kpi_total_income, kpi_total_expenses, kpi_net_income,
    kpi_ed_program_dollars, kpi_ed_program_ratio,
    kpi_contributions_total, kpi_pct_personnel,
    locked_at, locked_by, locked_via, override_justification,
    created_by
  ) values (
    p_scenario_id, v_scenario.aye_id, v_scenario.stage_id,
    v_scenario.scenario_label, v_scenario.description, v_scenario.narrative,
    v_scenario.show_narrative_in_pdf, v_scenario.is_recommended,
    v_stage.display_name, v_stage.short_name, v_stage.stage_type,
    v_kpis.total_income, v_kpis.total_expenses, v_kpis.net_income,
    v_kpis.ed_program_dollars, v_kpis.ed_program_ratio,
    v_kpis.contributions_total, v_kpis.pct_personnel,
    now(), v_caller,
    p_locked_via,
    case when p_locked_via = 'override' then trim(p_override_justification) else null end,
    v_caller
  )
  returning id into v_snapshot_id;

  -- Snapshot lines: account state captured by value.
  insert into budget_snapshot_lines (
    snapshot_id, account_id, account_code, account_name, account_type,
    account_hierarchy_path, is_pass_thru, is_ed_program_dollars,
    is_contribution, amount, source_type, notes
  )
  select
    v_snapshot_id, l.account_id, a.code, a.name, a.account_type,
    coalesce(coa_hierarchy_path(a.id), a.name),
    a.is_pass_thru, a.is_ed_program_dollars, a.is_contribution,
    l.amount, l.source_type, l.notes
    from budget_stage_lines l
    join chart_of_accounts a on a.id = l.account_id
   where l.scenario_id = p_scenario_id;

  -- Flip scenario state. Only the scenarios row state changes here;
  -- the line trigger from Migration 011 doesn't fire on this UPDATE
  -- (we're updating scenarios, not lines).
  update budget_stage_scenarios
     set state = 'locked',
         locked_at = now(),
         locked_by = v_caller,
         locked_via = p_locked_via,
         override_justification =
           case when p_locked_via = 'override' then trim(p_override_justification) else null end,
         updated_by = v_caller
   where id = p_scenario_id;

  return v_snapshot_id;
end;
$$;

grant execute on function lock_budget_stage_scenario(uuid, text, text) to authenticated;

-- ============================================================================
-- END OF MIGRATION 012
-- ============================================================================
