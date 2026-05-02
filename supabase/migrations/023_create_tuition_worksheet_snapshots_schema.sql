-- ============================================================================
-- Migration 023: Tuition Worksheet snapshot tables
--
-- Tuition-A2 (v3.8.1). Snapshot tables parallel to Budget's pattern
-- (Migration 011 + locked-render-binding-rule from §5.1, established
-- in v2.7). Captured-by-value columns are the contract: locked render
-- paths read exclusively from these tables; live joins to source
-- tables (modules, AYEs, user_profiles) are forbidden in locked
-- views per §5.1.
--
-- Two tables:
--   tuition_worksheet_snapshots — header per locked scenario,
--     carrying all configuration fields and computed KPIs at lock
--     time, plus all metadata needed for the family-facing Tuition
--     Schedule PDF letterhead and the locked-banner display.
--   tuition_worksheet_snapshot_family_details — per-family rows
--     (Stage 2 only). Empty for Stage 1 snapshots.
--
-- Snapshot integrity: rows are insert-only-then-immutable. Triggers
-- block UPDATE on both tables (parallel to Migration 011's
-- tg_prevent_snapshot_update on budget_snapshot_lines). DELETE is
-- allowed only via cascading from scenario hard-delete (rare;
-- typically scenarios stay forever once locked) or via explicit
-- system admin action.
-- ============================================================================


-- ---- 1. tuition_worksheet_snapshots --------------------------------------

create table tuition_worksheet_snapshots (
  id                              uuid primary key default gen_random_uuid(),

  -- Source scenario reference. ON DELETE SET NULL preserves the
  -- snapshot if the live scenario row is later hard-deleted (rare;
  -- the scenario row is normally retained as a transitional
  -- artifact even after unlock + new working copy).
  scenario_id                     uuid references tuition_worksheet_scenarios(id) on delete set null,

  -- AYE captured by value. ON DELETE SET NULL on aye_id preserves
  -- the snapshot if an AYE is later hard-deleted (very unusual but
  -- possible per the close ceremony). aye_label_at_lock is the
  -- captured display value for the letterhead and locked banner.
  aye_id                          uuid,
  aye_label_at_lock               text not null,

  -- Stage captured by value. ON DELETE SET NULL on stage_id
  -- preserves the snapshot if the workflow editor (Phase R2)
  -- deletes a stage. The three captured fields are the locked
  -- render path's source of truth for stage identity per §5.1.
  stage_id                        uuid,
  stage_display_name_at_lock      text not null,
  stage_short_name_at_lock        text not null,
  stage_type_at_lock              text not null,

  scenario_label_at_lock          text not null,
  scenario_description_at_lock    text,

  -- ----- All configuration captured by value at lock time ------------------
  tier_count                          int           not null,
  tier_rates                          jsonb         not null,
  faculty_discount_pct                numeric(5,2)  not null,
  other_discount_envelope             numeric(12,2) not null,
  financial_aid_envelope              numeric(12,2) not null,
  curriculum_fee_per_student          numeric(10,2) not null,
  enrollment_fee_per_student          numeric(10,2) not null,
  before_after_school_hourly_rate     numeric(10,2) not null,

  -- Stage 1 carries this (projection) but Stage 2 may inherit and
  -- ignore. Captured for completeness — locked Stage 1 snapshots
  -- show the projection alongside the rates.
  estimated_family_distribution       jsonb,

  -- Stage 2 only; NULL on Stage 1 snapshots.
  actual_before_after_school_hours    numeric(10,2),

  -- ----- KPIs captured by value at lock time -------------------------------
  --
  -- Computed by the lock RPC and stored here so the locked view
  -- never recomputes from live data per §5.1. All fields NOT NULL
  -- with a 0 default — every locked snapshot has every KPI populated
  -- (zero is the meaningful "no contribution to this aggregate"
  -- value, distinct from null which would suggest "not computed").
  kpi_gross_tuition_revenue           numeric(12,2) not null default 0,
  kpi_multi_student_discount_total    numeric(12,2) not null default 0,
  kpi_faculty_discount_total          numeric(12,2) not null default 0,
  kpi_other_discount_total            numeric(12,2) not null default 0,
  kpi_financial_aid_total             numeric(12,2) not null default 0,
  kpi_curriculum_fee_revenue          numeric(12,2) not null default 0,
  kpi_enrollment_fee_revenue          numeric(12,2) not null default 0,
  kpi_before_after_school_revenue     numeric(12,2) not null default 0,
  kpi_net_education_program_revenue   numeric(12,2) not null default 0,

  -- ----- Lock metadata -----------------------------------------------------
  --
  -- locked_by + approved_by are nullable uuids (the user row may be
  -- deleted via auth.users hard-delete) but the captured-by-value
  -- name fields keep the locked artifact renderable forever. Same
  -- pattern as budget_snapshots.locked_by_name_at_lock.
  locked_at                       timestamptz not null,
  locked_by                       uuid,
  locked_by_name_at_lock          text not null,
  locked_via                      text not null,  -- 'cascade' | 'override'; lock RPC validates
  override_justification          text,

  -- approved_by / approved_at distinct from locked_by / locked_at:
  -- approval is the governance event (state went pending → locked);
  -- locking is the moment of snapshot capture. In the current Tuition
  -- workflow (RPC-driven) they're the same caller and timestamp,
  -- but the schema preserves them as separate fields so that future
  -- workflows splitting approval and snapshot capture (e.g. delayed
  -- snapshot via a scheduled job) don't require a schema change.
  approved_by                     uuid,
  approved_by_name_at_lock        text not null,
  approved_at                     timestamptz not null,

  created_at                      timestamptz not null default now()
);

create index tuition_worksheet_snapshots_scenario_idx on tuition_worksheet_snapshots (scenario_id);
create index tuition_worksheet_snapshots_aye_stage_idx on tuition_worksheet_snapshots (aye_id, stage_id);
create index tuition_worksheet_snapshots_locked_at_idx on tuition_worksheet_snapshots (locked_at desc);


-- ---- 2. tuition_worksheet_snapshot_family_details ------------------------

create table tuition_worksheet_snapshot_family_details (
  id                       uuid primary key default gen_random_uuid(),
  snapshot_id              uuid not null references tuition_worksheet_snapshots(id) on delete cascade,

  family_label             text not null,
  students_enrolled        int  not null,
  applied_tier_size        int  not null,
  applied_tier_rate        numeric(10,2) not null,
  faculty_discount_amount  numeric(10,2),
  other_discount_amount    numeric(10,2),
  financial_aid_amount     numeric(10,2),
  notes                    text,

  -- Sort order captured at lock time so post-lock list re-orderings
  -- in the live table (if any) don't disturb the locked render order.
  sort_order               int
);

create index tuition_worksheet_snapshot_family_details_snapshot_idx
  on tuition_worksheet_snapshot_family_details (snapshot_id);


-- ---- 3. Snapshot immutability triggers -----------------------------------
--
-- Reuses tg_prevent_snapshot_update from Migration 011 (generic;
-- raises on any UPDATE).

create trigger tuition_worksheet_snapshots_no_update
  before update on tuition_worksheet_snapshots
  for each row execute function tg_prevent_snapshot_update();

create trigger tuition_worksheet_snapshot_family_details_no_update
  before update on tuition_worksheet_snapshot_family_details
  for each row execute function tg_prevent_snapshot_update();


-- ---- 4. change_log triggers ----------------------------------------------
--
-- Snapshot tables: log INSERT and DELETE only (the rows are immutable
-- between insert and delete; UPDATE is blocked by the no_update
-- trigger above so logging it would be dead code). Same pattern as
-- Migration 011's budget_snapshot_lines_change_log.

create trigger tuition_worksheet_snapshots_change_log
  after insert or delete on tuition_worksheet_snapshots
  for each row execute function tg_log_changes();

create trigger tuition_worksheet_snapshot_family_details_change_log
  after insert or delete on tuition_worksheet_snapshot_family_details
  for each row execute function tg_log_changes();


-- ---- 5. RLS --------------------------------------------------------------

alter table tuition_worksheet_snapshots                enable row level security;
alter table tuition_worksheet_snapshot_family_details  enable row level security;

create policy tuition_snapshots_read on tuition_worksheet_snapshots
  for select to authenticated
  using (current_user_has_module_perm('tuition', 'view'));

-- Snapshot inserts come from the SECURITY DEFINER lock RPC only; the
-- INSERT policy gates direct client INSERTs at submit_lock. Mirrors
-- Migration 011's budget_snapshots_insert.
create policy tuition_snapshots_insert on tuition_worksheet_snapshots
  for insert to authenticated
  with check (current_user_has_module_perm('tuition', 'submit_lock'));

create policy tuition_snapshot_family_details_read on tuition_worksheet_snapshot_family_details
  for select to authenticated
  using (
    current_user_has_module_perm('tuition', 'view')
    and can_view_family_details(auth.uid())
  );

create policy tuition_snapshot_family_details_insert on tuition_worksheet_snapshot_family_details
  for insert to authenticated
  with check (
    current_user_has_module_perm('tuition', 'submit_lock')
    and can_view_family_details(auth.uid())
  );


-- ---- 6. Refresh change_log_read with snapshot table arms -----------------
--
-- Adds tuition_worksheet_snapshots and tuition_worksheet_snapshot_
-- family_details to the policy. All other arms carried forward
-- verbatim from Migration 022's rebuild.

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
      -- Tuition (Migration 022 + 023)
      when 'tuition_worksheet_scenarios'                 then current_user_has_module_perm('tuition', 'view')
      when 'tuition_worksheet_family_details'            then
        current_user_has_module_perm('tuition', 'view')
        and can_view_family_details(auth.uid())
      when 'tuition_worksheet_snapshots'                 then current_user_has_module_perm('tuition', 'view')
      when 'tuition_worksheet_snapshot_family_details'   then
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
      -- Workflow framework (Migration 010)
      when 'module_workflows'               then is_system_admin()
      when 'module_workflow_stages'         then is_system_admin()
      -- Budget (Migration 011)
      when 'budget_stage_scenarios'         then current_user_has_module_perm('budget', 'view')
      when 'budget_stage_lines'             then current_user_has_module_perm('budget', 'view')
      when 'budget_snapshots'               then current_user_has_module_perm('budget', 'view')
      when 'budget_snapshot_lines'          then current_user_has_module_perm('budget', 'view')
      else false
    end
  );


-- ---- 7. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 023
-- ============================================================================
