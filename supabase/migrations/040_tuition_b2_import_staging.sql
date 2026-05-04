-- ============================================================================
-- Migration 040: Tuition-B2-import — staging tables (v3.8.18)
--
-- Bulk family import via XLSX/CSV with staging review. Operators
-- download a multi-tab XLSX template, fill it externally, upload
-- (XLSX or CSV), review the parsed rows in a staging UI alongside
-- computed columns, and accept the batch in append-or-replace mode.
--
-- Two staging tables introduced in this migration:
--
--   tuition_audit_import_batches      — header per upload session
--   tuition_audit_import_staged_rows  — one row per parsed
--                                       spreadsheet line, mirrors
--                                       tuition_worksheet_family_
--                                       details with parse_errors /
--                                       parse_warnings jsonb arrays
--
-- The RPC layer (Migration 041) provides:
--   create_tuition_audit_import_batch(scenario_id, file_name,
--                                     file_format, parsed_rows)
--   accept_tuition_audit_import_batch(batch_id, mode)
--   reject_tuition_audit_import_batch(batch_id, reason)
--
-- Architecture references: §7.3 (Stage 2 audit), Migration 022
-- (family_details schema), Migration 036 (M036 family_details
-- columns), Migration 027/028/029/032 (scenario column additions
-- relevant to import validation).
--
-- COA bulk-import pattern (precedent): the COA module already has
-- a staging-review pattern for CSV imports; this Tuition variant
-- diverges in two ways — XLSX-first template (with embedded
-- Instructions tab); per-row computed-column preview in the
-- staging UI for fiscal-decision visibility before commit.
--
-- RLS: SELECT/INSERT/UPDATE scoped to users with `tuition.edit` on
-- the parent scenario, mirroring tuition_worksheet_family_details
-- semantics. DELETE is allowed via cascade (FK constraint) when a
-- scenario or batch is removed; explicit DELETE is not exposed at
-- the RLS layer (the reject path keeps batches as historical
-- records rather than deleting them).
-- ============================================================================


-- ---- 1. tuition_audit_import_batches ------------------------------------

create table tuition_audit_import_batches (
  id              uuid primary key default gen_random_uuid(),
  scenario_id     uuid not null references tuition_worksheet_scenarios(id) on delete cascade,
  uploaded_by     uuid not null references auth.users(id) on delete set null,
  uploaded_at     timestamptz not null default now(),

  -- Operator's original filename for traceability. Used in the
  -- staging UI subtitle and in audit log summaries.
  file_name       text not null,
  file_format     text not null check (file_format in ('csv', 'xlsx')),
  row_count       int  not null check (row_count >= 0),

  -- Lifecycle. 'staged' means uploaded + parsed; 'accepted' means
  -- committed to family_details; 'rejected' means operator declined.
  -- 'expired' is reserved for future cleanup of stale batches that
  -- sit at 'staged' indefinitely; not used today.
  status          text not null default 'staged'
    check (status in ('staged', 'accepted', 'rejected', 'expired')),

  -- Set at accept time only; NULL while staged. The append/replace
  -- choice is deliberately NOT chosen at upload time — it is a
  -- deliberate destructive-action gate that the operator confirms
  -- after reviewing the staged data.
  mode            text check (mode is null or mode in ('append', 'replace')),

  accepted_at     timestamptz,
  rejected_at     timestamptz,
  rejected_reason text,

  -- One of accepted_at / rejected_at must be set when status is in
  -- a terminal state, but not at insert time when status='staged'.
  constraint import_batch_status_consistency check (
    (status = 'staged'   and accepted_at is null and rejected_at is null and mode is null) or
    (status = 'accepted' and accepted_at is not null and rejected_at is null and mode is not null) or
    (status = 'rejected' and rejected_at is not null and accepted_at is null) or
    (status = 'expired'  and accepted_at is null and rejected_at is null)
  )
);

create index tuition_import_batches_scenario_idx
  on tuition_audit_import_batches(scenario_id, uploaded_at desc);
create index tuition_import_batches_status_idx
  on tuition_audit_import_batches(status, uploaded_at desc);


-- ---- 2. tuition_audit_import_staged_rows --------------------------------
--
-- One row per parsed spreadsheet line. Mirrors tuition_worksheet_
-- family_details data shape but allows NULLs everywhere (validation
-- runs in the parse pass and surfaces as parse_errors/parse_warnings
-- on the row, not as schema rejections — operators need to see
-- their broken rows in the staging UI to fix them).

create table tuition_audit_import_staged_rows (
  id                       uuid primary key default gen_random_uuid(),
  batch_id                 uuid not null references tuition_audit_import_batches(id) on delete cascade,

  -- 1-indexed source row position from the spreadsheet, used in the
  -- staging UI for "Row #" display so operators can locate failing
  -- rows in their source file.
  row_number               int not null check (row_number >= 1),

  -- Family-detail fields, all nullable in staging. Validation
  -- surfaces missing / malformed data via parse_errors.
  family_label             text,
  students_enrolled        int,
  is_faculty_family        boolean,
  date_enrolled            date,
  date_withdrawn           date,
  faculty_discount_amount  numeric(12,2),
  other_discount_amount    numeric(12,2),
  financial_aid_amount     numeric(12,2),
  notes                    text,

  -- Parse outcomes. Each is a jsonb array of {field, message}
  -- objects — the staging UI reads these directly and renders
  -- inline error/warning badges per row. parse_errors block accept;
  -- parse_warnings advise but do not block.
  parse_errors             jsonb not null default '[]'::jsonb,
  parse_warnings           jsonb not null default '[]'::jsonb,

  -- Original parsed row from the spreadsheet (after header
  -- normalization but before validation). Stored for diagnostic
  -- visibility — if an operator says "the system rejected my row
  -- 47", we can pull raw_row to see exactly what was uploaded.
  raw_row                  jsonb not null
);

create index tuition_import_staged_rows_batch_idx
  on tuition_audit_import_staged_rows(batch_id, row_number);


-- ---- 3. RLS --------------------------------------------------------------
--
-- Read access requires tuition.view AND can_view_family_details
-- (mirrors family_details policies — staged rows can carry the same
-- per-family identifying information as live family_details rows
-- so the same redaction-aware permission model applies).
-- Insert/update/delete via the RPCs only (SECURITY DEFINER paths
-- that perform their own permission checks before touching these
-- tables).

alter table tuition_audit_import_batches      enable row level security;
alter table tuition_audit_import_staged_rows  enable row level security;

create policy tuition_import_batches_read on tuition_audit_import_batches
  for select to authenticated
  using (current_user_has_module_perm('tuition', 'view'));

create policy tuition_import_staged_rows_read on tuition_audit_import_staged_rows
  for select to authenticated
  using (
    current_user_has_module_perm('tuition', 'view')
    and can_view_family_details(auth.uid())
  );

-- INSERT/UPDATE policies gate the RPC paths. The RPCs are
-- SECURITY DEFINER and perform their own permission checks before
-- hitting these tables; the RLS INSERT policies below are belt-and-
-- suspenders to ensure no client can bypass.
create policy tuition_import_batches_insert on tuition_audit_import_batches
  for insert to authenticated
  with check (current_user_has_module_perm('tuition', 'edit'));

create policy tuition_import_batches_update on tuition_audit_import_batches
  for update to authenticated
  using (current_user_has_module_perm('tuition', 'edit'))
  with check (current_user_has_module_perm('tuition', 'edit'));

create policy tuition_import_staged_rows_insert on tuition_audit_import_staged_rows
  for insert to authenticated
  with check (
    current_user_has_module_perm('tuition', 'edit')
    and can_view_family_details(auth.uid())
  );


-- ---- 4. change_log triggers ---------------------------------------------
--
-- Apply the standard change_log trigger to both tables so
-- INSERT/UPDATE/DELETE events are captured for audit. This produces
-- target_table='tuition_audit_import_batches' / 'tuition_audit_
-- import_staged_rows' rows in change_log; the user-facing Recent
-- Activity feed picks up the import batch events via synthetic
-- change_log entries written by the RPCs (Migration 041) pointed at
-- the parent scenario row, so the activity feed surfaces them
-- correctly without requiring MODULE_AUDIT_CONFIGS extension.

create trigger tuition_audit_import_batches_change_log
  after insert or update or delete on tuition_audit_import_batches
  for each row execute function tg_log_changes();

create trigger tuition_audit_import_staged_rows_change_log
  after insert or update or delete on tuition_audit_import_staged_rows
  for each row execute function tg_log_changes();


-- ---- 5. Refresh change_log_read with new tables -------------------------
--
-- Add the two new tables to change_log_read RLS so authorized users
-- can see audit-log rows. Mirrors the snapshot-table pattern from
-- Migration 023. The full policy is rebuilt to include all extant
-- arms (carrying forward every previous arm verbatim).

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
      -- Tuition (Migrations 022 + 023; Migration 040 adds import staging)
      when 'tuition_worksheet_scenarios'                 then current_user_has_module_perm('tuition', 'view')
      when 'tuition_worksheet_family_details'            then
        current_user_has_module_perm('tuition', 'view')
        and can_view_family_details(auth.uid())
      when 'tuition_worksheet_snapshots'                 then current_user_has_module_perm('tuition', 'view')
      when 'tuition_worksheet_snapshot_family_details'   then
        current_user_has_module_perm('tuition', 'view')
        and can_view_family_details(auth.uid())
      when 'tuition_audit_import_batches'                then current_user_has_module_perm('tuition', 'view')
      when 'tuition_audit_import_staged_rows'            then
        current_user_has_module_perm('tuition', 'view')
        and can_view_family_details(auth.uid())
      when 'staffing_scenarios'             then current_user_has_module_perm('staffing', 'view')
      when 'staffing_scenario_positions'    then current_user_has_module_perm('staffing', 'view')
      when 'enrollment_audit_families'      then
        current_user_has_module_perm('enrollment_audit', 'view')
        and can_view_family_details(auth.uid())
      when 'enrollment_audit_summary'       then current_user_has_module_perm('enrollment_audit', 'view')
      when 'chart_of_accounts'              then current_user_has_module_perm('chart_of_accounts', 'view')
      when 'school_lock_cascade_rules'      then true
      when 'module_workflows'               then is_system_admin()
      when 'module_workflow_stages'         then is_system_admin()
      when 'budget_stage_scenarios'         then current_user_has_module_perm('budget', 'view')
      when 'budget_stage_lines'             then current_user_has_module_perm('budget', 'view')
      when 'budget_snapshots'               then current_user_has_module_perm('budget', 'view')
      when 'budget_snapshot_lines'          then current_user_has_module_perm('budget', 'view')
      else false
    end
  );


-- ---- 6. PostgREST schema cache reload -----------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 040
-- ============================================================================
