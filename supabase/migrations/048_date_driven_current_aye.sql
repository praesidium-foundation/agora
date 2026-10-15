-- ============================================================================
-- Migration 048: Date-driven current AYE (v3.8.27)
--
-- Replaces the manually-managed `academic_years.is_current` boolean with
-- date-derivation. The "current" AYE is now the row where `CURRENT_DATE`
-- falls between `start_date` and `end_date` — no operator-managed flag,
-- no demote-then-promote dance, no risk of a stale `is_current` state.
--
-- Operator unblock: Jenna is 2.5 months into AYE 2027 (Jul 1, 2026 –
-- Jun 30, 2027) and the system was still showing AYE 2026 as current.
-- The pre-M048 AYE Management UI only let operators flip `is_current`
-- by creating a NEW AYE row via `bootstrap_aye(..., p_set_current :=
-- true)`, not by editing an existing one. Date-driven removes the flag
-- entirely so the "current" designation always matches reality.
--
-- Pure replacement — `is_current` is dropped, not layered. The flag's
-- four consumers (AppShell sidebar, Dashboard subtitle, AYESelector
-- dropdown default, AYEManagement list badge) switch to calling the
-- new RPC. The sole validation-script consumer in
-- supabase/validation/v381_tuition_a2_smoke_test.sql is updated to
-- match (two-line edit alongside this migration).
--
-- Also introduces `update_academic_year(...)` to support edit-in-place
-- on existing AYE rows — the pre-M048 UX had no edit path at all,
-- forcing operators into the create-new-with-current-flag workaround.
-- The new RPC lands alongside the date-driven work so Chunk 3's edit
-- UX can call it without a follow-up migration.
--
-- Architecture references:
--   - Appendix C (new v3.8.27 decision row — see history entry)
--   - Appendix B v3.8.27 Migration 048 entry
--   - §3 single-tenant note (academic_years is global; no school_id)
-- ============================================================================


-- ---- 1. get_current_academic_year() RPC --------------------------------
--
-- Returns the full academic_years row whose date window covers today,
-- or NULL if no row covers today. The LIMIT 1 + order-by-start-date is
-- a defensive guard against overlapping rows (the aye_dates_valid
-- CHECK constraint prevents each row from being malformed, but doesn't
-- enforce non-overlap across rows). Earliest start_date wins
-- deterministically.
--
-- Plain function (not SECURITY DEFINER): the `authenticated` role has
-- RLS SELECT on academic_years (001_initial_schema.sql:1117–1124), so
-- the caller's own privileges are sufficient. STABLE marker lets the
-- planner cache the result within a statement.

create or replace function get_current_academic_year()
returns academic_years
language sql
stable
set search_path = public
as $$
  select *
    from academic_years
   where current_date between start_date and end_date
   order by start_date asc
   limit 1;
$$;

grant execute on function get_current_academic_year() to authenticated;


-- ---- 2. Drop partial unique index + is_current column -------------------
--
-- Order matters: drop the index first (it references the column in
-- both the indexed columns AND the WHERE clause of the partial
-- predicate), then drop the column. Without the explicit DROP INDEX,
-- the ALTER TABLE DROP COLUMN would error on RESTRICT (default).

drop index if exists academic_years_one_current_idx;

alter table academic_years drop column is_current;


-- ---- 3. Refactor bootstrap_aye to drop p_set_current --------------------
--
-- Postgres identifies functions by (name, argument types), so a
-- parameter-list change requires DROP FUNCTION before CREATE — same
-- gotcha as M037 and M039. The old 4-arg (text, date, date, boolean)
-- signature is dropped; the new 4-arg (text, date, date, text) signature
-- replaces it with p_notes.
--
-- Behavior changes:
--   - Removed the demote-then-insert block (lines 32–39 of M002) — no
--     more is_current flag to demote.
--   - Removed is_current from the INSERT column list and values list.
--   - Added p_notes (optional) — populates academic_years.notes on
--     create. Previously the column could only be set via a later
--     UPDATE (and there was no update path, so it was always NULL in
--     practice).
--
-- The seed-draft-module-instances block is preserved verbatim (lines
-- 50–55 of M002).

drop function if exists bootstrap_aye(text, date, date, boolean);

create or replace function bootstrap_aye(
  p_label       text,
  p_start_date  date,
  p_end_date    date,
  p_notes       text default null
)
returns academic_years
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_aye academic_years;
begin
  if not is_system_admin() then
    raise exception 'Only system admins can create academic years';
  end if;

  insert into academic_years (
    label, start_date, end_date, notes, created_by, updated_by
  )
  values (
    p_label, p_start_date, p_end_date, p_notes, auth.uid(), auth.uid()
  )
  returning * into v_new_aye;

  -- Seed a draft module_instances row for every active module so users
  -- can immediately start working on this AYE's data.
  insert into module_instances (module_id, aye_id, state)
  select m.id, v_new_aye.id, 'draft'::module_state
    from modules m
   where m.is_active = true;

  return v_new_aye;
end;
$$;

grant execute on function bootstrap_aye(text, date, date, text) to authenticated;


-- ---- 4. update_academic_year RPC (edit-in-place support) ---------------
--
-- Admin-gated update of an existing AYE's label / start_date /
-- end_date / notes. All four fields are overwritten; the UI MUST
-- pass the full current state (not a sparse patch). The table-level
-- aye_dates_valid CHECK constraint (001_initial_schema.sql:133)
-- rejects end_date <= start_date; the client surfaces the resulting
-- error to the operator.
--
-- Does not touch is_locked — that's a structural lock on the AYE
-- itself and should have its own dedicated toggle affordance when
-- the UX for it ships. Not in scope for v3.8.27.
--
-- Raises if the row doesn't exist (NOT FOUND) — defensive against
-- stale UI state where the row was deleted externally.

create or replace function update_academic_year(
  p_id          uuid,
  p_label       text,
  p_start_date  date,
  p_end_date    date,
  p_notes       text default null
)
returns academic_years
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row academic_years;
begin
  if not is_system_admin() then
    raise exception 'Only system admins can update academic years';
  end if;

  update academic_years
     set label      = p_label,
         start_date = p_start_date,
         end_date   = p_end_date,
         notes      = p_notes,
         updated_at = now(),
         updated_by = auth.uid()
   where id = p_id
   returning * into v_row;

  if v_row.id is null then
    raise exception 'Academic year % not found', p_id;
  end if;

  return v_row;
end;
$$;

grant execute on function update_academic_year(uuid, text, date, date, text) to authenticated;


-- ---- 5. PostgREST schema cache reload ----------------------------------

notify pgrst, 'reload schema';


-- ---- 6. Post-apply verification (operator runs manually) ---------------
--
-- Run each of these after apply. Per the v3.8.23 Appendix C commitment,
-- migration success is not the same as migration correctness.
--
-- (a) is_current column is gone — should return zero rows:
--
--     SELECT column_name
--       FROM information_schema.columns
--      WHERE table_name = 'academic_years'
--        AND column_name = 'is_current';
--
-- (b) Partial unique index is gone — should return zero rows:
--
--     SELECT indexname
--       FROM pg_indexes
--      WHERE tablename  = 'academic_years'
--        AND indexname  = 'academic_years_one_current_idx';
--
-- (c) get_current_academic_year() returns the AYE 2027 row today
--     (Jul 1, 2026 – Jun 30, 2027 window covers 2026-10-15):
--
--     SELECT (get_current_academic_year()).*;
--
-- (d) bootstrap_aye and update_academic_year signatures match the new
--     definitions — should return two rows:
--
--     SELECT proname, pg_get_function_arguments(oid)
--       FROM pg_proc
--      WHERE proname IN ('bootstrap_aye', 'update_academic_year');
--
--     Expected:
--       bootstrap_aye        | p_label text, p_start_date date, p_end_date date, p_notes text DEFAULT NULL::text
--       update_academic_year | p_id uuid, p_label text, p_start_date date, p_end_date date, p_notes text DEFAULT NULL::text

-- ============================================================================
-- END OF MIGRATION 048
-- ============================================================================
