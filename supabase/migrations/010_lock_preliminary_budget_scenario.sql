-- ============================================================================
-- Migration 010: Atomic lock for Preliminary Budget scenarios
--
-- Architecture Section 5.1 ("Snapshots"): if snapshot capture fails, the
-- lock transition rolls back. There is no scenario where a module says
-- "locked" but the snapshot doesn't exist. To enforce that, the lock
-- transition needs to be a single transaction that inserts the snapshot
-- header, inserts every snapshot line, and flips the scenario state —
-- all or nothing.
--
-- This migration adds:
--
--   coa_hierarchy_path(account_id) — colon-delimited "Top : Mid : Leaf"
--     path for an account, walked from root to the account. Captured by
--     value into budget_snapshot_lines so the snapshot still renders
--     correctly after post-lock COA changes (deactivation, hard-delete,
--     reparenting).
--
--   compute_pb_scenario_kpis(scenario_id) — returns the KPI bundle as a
--     row. Mirrors the JS computeKpis logic in src/lib/budgetTree.js so
--     the captured KPIs match what the user saw in the sidebar at lock
--     time. Personnel total uses the same name-match heuristic
--     ("Personnel" top-level expense account); brittle but matches
--     Libertas's COA structure (CLAUDE.md note for future).
--
--   lock_preliminary_budget_scenario(scenario_id, locked_via,
--                                    override_justification) — the
--     atomic lock entry point. Permissions checked here (approve_lock
--     required); state must be pending_lock_review; on success returns
--     the new snapshot id.
--
-- Submit (drafting → pending_lock_review) and Reject (pending_lock_review
-- → drafting) are still client-side UPDATEs on the scenarios table,
-- gated by the existing edit-perm RLS policy. The UI enforces who can
-- do what (submit_lock / approve_lock); a malicious edit-level user
-- could in theory bypass the UI workflow, which is acceptable under the
-- single-school trust model documented in Appendix D. A column-aware
-- state-transition trigger is the future hardening path.
-- ============================================================================

-- ---- 1. coa_hierarchy_path -----------------------------------------------

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

-- ---- 2. compute_pb_scenario_kpis -----------------------------------------

create or replace function compute_pb_scenario_kpis(p_scenario_id uuid)
returns table (
  total_income          numeric,
  total_expense         numeric,
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
  -- Top-level expense account named 'Personnel' (case-insensitive). Its
  -- whole subtree's amounts contribute to v_personnel_total.
  select id into v_personnel_id
    from chart_of_accounts
   where parent_id is null
     and account_type = 'expense'
     and lower(trim(name)) = 'personnel'
   limit 1;

  -- Aggregates over budget lines × COA flags.
  for v_total_income, v_total_expense, v_ed_program_dollars, v_contributions in
    select
      coalesce(sum(case when a.account_type = 'income'  and not a.is_pass_thru then l.amount end), 0),
      coalesce(sum(case when a.account_type = 'expense' and not a.is_pass_thru then l.amount end), 0),
      coalesce(sum(case when a.is_ed_program_dollars   and not a.is_pass_thru then l.amount end), 0),
      coalesce(sum(case when a.is_contribution         and not a.is_pass_thru then l.amount end), 0)
    from preliminary_budget_lines l
    join chart_of_accounts a on a.id = l.account_id
    where l.scenario_id = p_scenario_id
  loop
    null;  -- single row; the FOR loop is just a clean way to capture into multiple vars
  end loop;

  -- Personnel subtree (recursive walk).
  if v_personnel_id is not null then
    with recursive personnel_tree as (
      select id from chart_of_accounts where id = v_personnel_id
      union all
      select coa.id from chart_of_accounts coa
        join personnel_tree pt on coa.parent_id = pt.id
    )
    select coalesce(sum(l.amount), 0) into v_personnel_total
      from preliminary_budget_lines l
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

grant execute on function compute_pb_scenario_kpis(uuid) to authenticated;

-- ---- 3. lock_preliminary_budget_scenario ---------------------------------

create or replace function lock_preliminary_budget_scenario(
  p_scenario_id uuid,
  p_locked_via text default 'normal',
  p_override_justification text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scenario     record;
  v_snapshot_id  uuid;
  v_kpi          record;
  v_caller       uuid := auth.uid();
begin
  -- Permission check. SECURITY DEFINER bypasses RLS but we still want
  -- to gate by the caller's perm — which we read via auth.uid().
  if not current_user_has_module_perm('preliminary_budget', 'approve_lock') then
    raise exception 'Approve-and-lock requires approve_lock permission';
  end if;

  select * into v_scenario
    from preliminary_budget_scenarios
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

  -- Compute KPIs at lock time.
  select * into v_kpi
    from compute_pb_scenario_kpis(p_scenario_id);

  -- Insert snapshot header. snapshot_type = 'preliminary' for now;
  -- final-budget-side will share this table later via snapshot_type =
  -- 'final'.
  insert into budget_snapshots (
    scenario_id, aye_id, snapshot_type,
    scenario_label, scenario_description, narrative,
    show_narrative_in_pdf, is_recommended,
    kpi_total_income, kpi_total_expenses, kpi_net_income,
    kpi_ed_program_dollars, kpi_ed_program_ratio,
    kpi_contributions_total, kpi_pct_personnel,
    locked_at, locked_by, locked_via, override_justification,
    created_by
  ) values (
    p_scenario_id, v_scenario.aye_id, 'preliminary',
    v_scenario.scenario_label, v_scenario.description, v_scenario.narrative,
    v_scenario.show_narrative_in_pdf, v_scenario.is_recommended,
    v_kpi.total_income, v_kpi.total_expense, v_kpi.net_income,
    v_kpi.ed_program_dollars, v_kpi.ed_program_ratio,
    v_kpi.contributions_total, v_kpi.pct_personnel,
    now(), v_caller,
    p_locked_via,
    case when p_locked_via = 'override' then trim(p_override_justification) else null end,
    v_caller
  )
  returning id into v_snapshot_id;

  -- Insert snapshot lines: one per budget line, with the account state
  -- captured by value (code, name, hierarchy path, flags, type). After
  -- this insert the snapshot is independent of any future COA changes —
  -- deactivation, hard-delete, reparenting all leave snapshot rendering
  -- unchanged.
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
    from preliminary_budget_lines l
    join chart_of_accounts a on a.id = l.account_id
   where l.scenario_id = p_scenario_id;

  -- Flip the scenario state. The line-write trigger from Migration 009
  -- doesn't fire here (we're updating scenarios, not lines); the
  -- scenario itself has no state-transition trigger today.
  update preliminary_budget_scenarios
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

grant execute on function lock_preliminary_budget_scenario(uuid, text, text) to authenticated;

-- ============================================================================
-- END OF MIGRATION 010
-- ============================================================================
