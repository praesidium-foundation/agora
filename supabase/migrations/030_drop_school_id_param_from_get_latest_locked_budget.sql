-- ============================================================================
-- Migration 030: Drop unused school_id parameter from
--                get_latest_locked_budget_for_school RPC
--
-- v3.8.8 (Tuition-C.1). Single-tenant alignment cleanup. The RPC
-- introduced in Migration 029 (Tuition-C) carried a preserved-but-
-- unused p_school_id parameter for forward-compat with eventual
-- multi-tenancy. Architecture §1 and CLAUDE.md both explicitly
-- direct against multi-tenant scaffolding ahead of the coordinated
-- migration: "Do NOT add org_id columns... those migrations are
-- deferred until a second school onboards."
--
-- This micro-commit aligns the RPC signature with the stated
-- single-tenant architecture. When multi-tenancy lands, this RPC
-- gets re-parameterized as part of that coordinated migration
-- anyway — adding scaffolding ahead of time was a misstep.
--
-- Function body unchanged except for the dropped parameter:
--   - Same TABLE return shape (scenario_id, aye, stage_type,
--     total_expenses, locked_at)
--   - Same SELECT against budget_snapshots joined to academic_years
--   - Same ordering (start_date DESC, locked_at DESC)
--   - Same kpi_total_expenses read per §5.1 binding rule
--   - SECURITY DEFINER preserved
--   - GRANT EXECUTE TO authenticated preserved
-- ============================================================================


-- ---- 1. Drop the old function -------------------------------------------
--
-- PostgreSQL identifies functions by signature (name + argument
-- types), so we must drop the (uuid)-parameterized version
-- explicitly before creating the no-arg replacement. CREATE OR
-- REPLACE cannot change a function's parameter list — that
-- requires DROP + CREATE.

drop function if exists get_latest_locked_budget_for_school(uuid);


-- ---- 2. Create the renamed, no-parameter function -----------------------

create or replace function get_latest_locked_budget()
returns table (
  scenario_id    uuid,
  aye            text,
  stage_type     text,
  total_expenses numeric,
  locked_at      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    bs.scenario_id,
    ay.label                  as aye,
    bs.stage_type_at_lock     as stage_type,
    bs.kpi_total_expenses     as total_expenses,
    bs.locked_at
  from budget_snapshots bs
  join academic_years ay on ay.id = bs.aye_id
  order by ay.start_date desc, bs.locked_at desc
  limit 1
$$;

grant execute on function get_latest_locked_budget() to authenticated;


-- ---- 3. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 030
-- ============================================================================
