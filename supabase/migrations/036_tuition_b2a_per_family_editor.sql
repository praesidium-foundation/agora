-- ============================================================================
-- Migration 036: Tuition-B2a — per-family editor schema (v3.8.14)
--
-- Three nullable / default-false columns on tuition_worksheet_family_
-- details to support the Stage 2 per-family editor that ships in B2a.
-- Mirrored on tuition_worksheet_snapshot_family_details for snapshot
-- fidelity per §5.1.
--
--   is_faculty_family  bool NOT NULL DEFAULT false
--     Drives the "faculty discount REPLACES multi-student tier
--     discount" rule (architecture §7.3 / Appendix C v3.8.14
--     decision row). When true: applied_tier_size = 1, applied_tier_
--     rate = base_rate, faculty_discount_amount auto-populates from
--     base_rate × students_enrolled × faculty_discount_pct/100, and
--     the row's Multi-Student Discount renders $0 in the editor.
--     Manual overrides remain possible for non-standard cases (the
--     spreadsheet's Cookson example, where faculty discount applied
--     AFTER multi-student tier discount due to FA / contract timing).
--
--   date_enrolled    date NULL
--   date_withdrawn   date NULL
--     Operational dates for mid-year enrollment tracking. NULL
--     defaults — the operator enters real dates as they happen.
--     The school year (when students actually attend) is
--     operationally distinct from the AYE / fiscal year (architecture
--     §3.3 v3.8.14 decision); date_enrolled and date_withdrawn are
--     raw operator-entered dates with no system-side school-year
--     inference. A future Governance Calendar module (Phase 8) will
--     provide school-year start / end dates that these fields can
--     default from.
--
-- No backfill needed — both tables have zero production rows at
-- v3.8.14 ship time (no Stage 2 scenario has been created yet).
-- No new triggers. No RLS changes. No new RPCs.
--
-- KNOWN GAP for B2b: lock_tuition_scenario copies family_details rows
-- to snapshot_family_details with an explicit column list that does
-- not yet include the three new columns. Stage 2 lock today (only
-- triggerable via direct RPC call — there is no UI affordance until
-- B2b) would lose is_faculty_family / date_enrolled / date_withdrawn
-- on snapshot capture. B2b's lock-workflow rewrite of lock_tuition_
-- scenario must extend the snapshot INSERT to include all three
-- columns. The audit-discipline lesson from Migration 034 applies:
-- B2b's rewrite must read the CURRENT lock_tuition_scenario body
-- (Migration 034) as its baseline, not an older migration.
--
-- ============================================================================


-- ---- 1. tuition_worksheet_family_details extensions ---------------------

alter table tuition_worksheet_family_details
  add column is_faculty_family boolean not null default false,
  add column date_enrolled     date,
  add column date_withdrawn    date;


-- ---- 2. tuition_worksheet_snapshot_family_details extensions ------------
--
-- Mirror the same three columns. Snapshot rows are immutable per
-- Migration 023 (tg_prevent_snapshot_update); the value is captured
-- by value at lock time from the live row. ALTER TABLE ADD COLUMN is
-- a DDL operation, not an UPDATE, so it does not trigger the
-- immutability guard.

alter table tuition_worksheet_snapshot_family_details
  add column is_faculty_family boolean not null default false,
  add column date_enrolled     date,
  add column date_withdrawn    date;


-- ---- 3. PostgREST schema cache reload -----------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 036
-- ============================================================================
