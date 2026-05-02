-- ============================================================================
-- Migration 022: Tuition Worksheet schema (two-stage)
--
-- Tuition-A2 (v3.8.1). Implements the two-stage Tuition module schema
-- whose architecture landed in v3.8 (commit 0284480). UI work follows
-- in Tuition-B as a separate session.
--
-- Architecture references: §7.3 (Tuition Worksheet, two-stage),
-- §3.5 (Module-scoped governance authority), §3.8 (Module workflows
-- and stages), §5.1 (Snapshot binding rules), §7.5 (Cross-module
-- lock cascade rules). CLAUDE.md "Two-stage modules" and "Three-
-- layer enforcement for state invariants" are the operating ground
-- rules for the immutability mechanism.
--
-- This migration:
--
--   0. Drops legacy tuition_worksheet + tuition_scenarios tables (the
--      single-stage A/B/C/D scenario design from Migration 001).
--      Confirmed empty by user pre-flight count check before applying.
--      No application code writes these tables; one read-only display
--      page (TuitionWorksheet.jsx) is replaced with a placeholder in
--      this commit.
--
--   1. Renames modules.code from 'tuition_worksheet' to 'tuition'.
--      Parallel to Migration 011's preliminary_budget → budget rename.
--      Existing user_module_permissions rows survive (they reference
--      module_id, not code).
--
--   2. Configures the Tuition module workflow per §3.8: two stages,
--      both reusing the existing stage_type catalog. Stage type
--      judgment per v3.8 §7.3: 'preliminary' for Tuition Planning
--      (sets configuration that downstream commitments rely on),
--      'final' for Tuition Audit (actuals captured, terminal). The
--      school's display name carries the module-specific vocabulary
--      ("Tuition Planning"); the stage type drives generic machinery.
--
--   3. Creates tuition_worksheet_scenarios (parallel to
--      budget_stage_scenarios in shape — standard scenario / lock /
--      unlock columns) plus the layered-discount-taxonomy
--      configuration columns (tier rates, discount envelopes, fee
--      rates) per §7.3. Stage-1-only and Stage-2-only fields named
--      explicitly.
--
--   4. Creates tuition_worksheet_family_details (Stage 2 only — one
--      row per enrolled family; carries per-family discount
--      allocations and a notes column for governance annotations).
--
--   5. Installs three layers of integrity enforcement:
--      a. CHECK constraints (initiator separation + sequential
--         ordering on the unlock workflow fields, mirroring
--         budget's pattern from Migration 016 + 020).
--      b. Partial unique index "one locked + recommended per
--         (aye_id, stage_id)" mirroring Migration 011's budget index.
--      c. Triggers:
--         - tg_unlock_only_when_locked (REUSED — generic function
--           from Migration 016; works for any table with the same
--           column names).
--         - tg_enforce_tuition_stage_2_immutability (NEW — hard
--           guard for the §7.3 immutability rule: tier rates and
--           per-student fees, set in Stage 1, cannot be edited in
--           Stage 2 because families have signed agreements at
--           those rates).
--         - tg_check_tuition_family_details_stage (NEW — blocks
--           inserting family_details rows on Stage 1 scenarios; the
--           per-family detail belongs to Stage 2 only).
--         - tg_prevent_recommend_while_sibling_locked_tuition (NEW —
--           parallel to Migration 015's budget guard; tuition-
--           specific copy because the 015 function references
--           budget_stage_scenarios by name in its SELECT).
--         - tg_prevent_lock_submit_while_sibling_locked_tuition (NEW
--           — parallel ditto).
--         - tg_log_changes (REUSED — generic via TG_TABLE_NAME).
--
--   6. RLS policies: read on view permission, write on edit
--      permission. Mirrors Migration 011's budget pattern.
--
--   7. change_log_read policy rebuild: drops the legacy
--      'tuition_worksheet' / 'tuition_scenarios' arms, adds new arms
--      for tuition_worksheet_scenarios and tuition_worksheet_family_
--      details. All other arms from Migration 011 carried forward
--      verbatim. Family details are gated by the
--      can_view_family_details detail-visibility flag in addition
--      to the module view permission, parallel to enrollment_audit_
--      families in 011.
--
--   8. NOTIFY pgrst at the end (CLAUDE.md "PostgREST schema cache
--      reload — every migration").
-- ============================================================================


-- ---- 0. Drop legacy tuition tables ---------------------------------------
--
-- Migration 001 created tuition_worksheet (one-row-per-AYE header) and
-- tuition_scenarios (A/B/C/D children with computed-totals trigger).
-- The new design is stage-aware multi-scenario, parallel to Budget's
-- post-Migration-011 shape. CASCADE removes attached triggers, FKs,
-- and RLS policies. change_log rows referencing the dropped tables
-- by target_table name remain in change_log (text-keyed); they
-- become unreadable to non-admins after the change_log_read arm
-- swap below — acceptable since they're historical records of
-- abandoned-design test data.

drop table if exists tuition_scenarios cascade;
drop table if exists tuition_worksheet cascade;


-- ---- 1. Rename modules.code 'tuition_worksheet' → 'tuition' --------------
--
-- Module identity stays (same row, same id, same FKs). The code
-- alone changes. user_module_permissions rows survive because they
-- reference module_id; they continue to authorize the same users
-- against the same module.
--
-- The display_name on the modules row was already 'Tuition Worksheet'
-- in Migration 001. Updated to 'Tuition' to match the new naming;
-- the architecture v3.8 §7.3 talks about the "Tuition module."
-- Sidebar and other UI surfaces will read this if they ever do.

update modules
   set code = 'tuition',
       display_name = 'Tuition'
 where code = 'tuition_worksheet';


-- ---- 2. Tuition workflow + stages ----------------------------------------

do $$
declare
  v_module_id   uuid;
  v_workflow_id uuid;
begin
  select id into v_module_id from modules where code = 'tuition';
  if v_module_id is null then
    raise exception 'Tuition module not found in modules table after rename';
  end if;

  insert into module_workflows (module_id, name, description, is_active)
  values (
    v_module_id,
    'Tuition workflow (Libertas default)',
    'Two-stage workflow: Tuition Planning (January) feeds Preliminary Budget; Tuition Audit (September) feeds Final Budget. Architecture §7.3.',
    true
  )
  returning id into v_workflow_id;

  insert into module_workflow_stages
    (workflow_id, stage_type, display_name, short_name, description, sort_order, target_month)
  values
    (v_workflow_id, 'preliminary', 'Tuition Planning', 'Planning',
     'Sets tuition rates, fees, and discount budgets for the upcoming AYE. Tuition Committee reviews and recommends; Treasurer approves; locks in January. Feeds Preliminary Budget revenue projections.',
     1, 1),
    (v_workflow_id, 'final', 'Tuition Audit', 'Audit',
     'Captures per-family enrollment and actual discount allocations after September enrollment finalizes. Locks in September. Feeds Final Budget actuals.',
     2, 9);
end $$;


-- ---- 3. tuition_worksheet_scenarios --------------------------------------

create table tuition_worksheet_scenarios (
  id                          uuid primary key default gen_random_uuid(),
  aye_id                      uuid not null references academic_years(id),
  stage_id                    uuid not null references module_workflow_stages(id),

  scenario_label              text not null,
  description                 text,
  is_recommended              boolean not null default false,

  -- State machine. 'pending_unlock_review' is reserved per architecture
  -- §8.13 (mirrors budget); the v3.7 two-identity unlock model uses
  -- flag fields on top of state = 'locked' rather than a separate
  -- state value, so 'pending_unlock_review' is unused under the
  -- current design.
  state                       text not null default 'drafting'
    check (state in ('drafting', 'pending_lock_review', 'locked', 'pending_unlock_review')),

  -- Lock metadata
  locked_at                   timestamptz,
  locked_by                   uuid references auth.users(id) on delete set null,
  locked_via                  text,  -- 'cascade' | 'override'; RPC validates (no DB CHECK, mirrors budget pattern from Migration 011)
  override_justification      text,

  -- ----- Configuration (set in Stage 1, immutable in Stage 2 per §7.3) ----
  --
  -- These six fields are the contractual surface of the Tuition
  -- module: families sign agreements at these rates. Once Stage 1
  -- locks, they must not change in Stage 2 (audit) — that's enforced
  -- by tg_enforce_tuition_stage_2_immutability below.
  tier_count                          int            not null default 4,
  tier_rates                          jsonb          not null default '[]'::jsonb,
                                                     -- shape: [{tier_size: int, per_student_rate: numeric}, ...]
  faculty_discount_pct                numeric(5,2)   not null default 50.00,
  curriculum_fee_per_student          numeric(10,2)  not null default 0,
  enrollment_fee_per_student          numeric(10,2)  not null default 0,
  before_after_school_hourly_rate     numeric(10,2)  not null default 0,

  -- ----- Discount envelopes (set in Stage 1; editable in Stage 2 -----------
  --       only in the rare case the board adjusts mid-cycle per §7.3) -------
  other_discount_envelope             numeric(12,2)  not null default 0,
  financial_aid_envelope              numeric(12,2)  not null default 0,

  -- ----- Stage-1-only fields (Stage 2 ignores or inherits as reference) ---
  estimated_family_distribution       jsonb          default '[]'::jsonb,
                                                     -- shape: [{tier_size: int, family_count: int}, ...]

  -- ----- Stage-2-only fields ----------------------------------------------
  actual_before_after_school_hours    numeric(10,2),

  -- ----- Cross-module linkage (manual today; FK-resolvable later) ---------
  --
  -- No FK constraint yet — Enrollment Estimator module isn't built.
  -- When it ships, a follow-up migration adds REFERENCES.
  linked_enrollment_estimate_id       uuid,

  -- ----- Standard audit fields ---------------------------------------------
  created_at                  timestamptz not null default now(),
  created_by                  uuid references auth.users(id) on delete set null,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references auth.users(id) on delete set null,

  -- ----- Unlock workflow flag fields (v3.7 two-identity model) ------------
  unlock_requested              boolean not null default false,
  unlock_request_justification  text,
  unlock_requested_at           timestamptz,
  unlock_requested_by           uuid references auth.users(id) on delete set null,
  unlock_approval_1_at          timestamptz,
  unlock_approval_1_by          uuid references auth.users(id) on delete set null,
  unlock_approval_2_at          timestamptz,
  unlock_approval_2_by          uuid references auth.users(id) on delete set null,

  -- Same constraint family as budget_stage_scenarios (Migrations 016 + 020):
  --   - Initiator may not be approval_2 (initiator IS approval_1 in v3.7).
  --   - The two approvers are distinct from each other.
  --   - approval_2 cannot populate before approval_1.
  -- The "initiator != approval_1" CHECK was deliberately dropped in the
  -- v3.7 refactor (Migration 020) — under the two-identity model the
  -- requester's submission is approval_1.
  constraint tuition_unlock_initiator_not_approver_2 check (
    unlock_requested_by is null
    or unlock_approval_2_by is null
    or unlock_requested_by <> unlock_approval_2_by
  ),
  constraint tuition_unlock_approvers_distinct check (
    unlock_approval_1_by is null
    or unlock_approval_2_by is null
    or unlock_approval_1_by <> unlock_approval_2_by
  ),
  constraint tuition_unlock_sequential_ordering check (
    (unlock_approval_2_at is null and unlock_approval_2_by is null)
    or (unlock_approval_1_at is not null and unlock_approval_1_by is not null)
  )
);

create index tuition_worksheet_scenarios_aye_stage_idx
  on tuition_worksheet_scenarios (aye_id, stage_id);

-- One locked + recommended scenario per (AYE, Stage). Mirrors
-- Migration 011's budget_stage_scenarios_one_locked_recommended.
-- Multiple drafting scenarios per (AYE, Stage) allowed; only the
-- locked one is the official approved tuition for that slot. The
-- two stages (Planning, Audit) for the same AYE each have their own
-- locked + recommended scenario.
create unique index tuition_worksheet_scenarios_one_locked_recommended
  on tuition_worksheet_scenarios (aye_id, stage_id)
  where is_recommended = true and state = 'locked';

-- Pending-unlock-request lookup index, mirrors Migration 016's
-- budget_stage_scenarios_unlock_pending.
create index tuition_worksheet_scenarios_unlock_pending
  on tuition_worksheet_scenarios (aye_id, stage_id)
  where unlock_requested = true;


-- ---- 4. tuition_worksheet_family_details (Stage 2 only) ------------------

create table tuition_worksheet_family_details (
  id                       uuid primary key default gen_random_uuid(),
  scenario_id              uuid not null references tuition_worksheet_scenarios(id) on delete cascade,
  family_label             text not null,
  students_enrolled        int  not null check (students_enrolled > 0),

  -- Auto-derived at row creation; snapshotted from scenario.tier_rates
  -- so post-Stage-1 edits never reach here (Stage 1 locks before Stage
  -- 2 begins; tier rates are immutable in Stage 2 anyway).
  applied_tier_size        int           not null,
  applied_tier_rate        numeric(10,2) not null,

  -- Per-family discount allocations. Nullable because most families
  -- have only the tier discount; only some have Faculty / Other / FA
  -- awards. Storing 0 vs NULL distinguishes "explicitly zero" from
  -- "not applicable."
  faculty_discount_amount  numeric(10,2),
  other_discount_amount    numeric(10,2),
  financial_aid_amount     numeric(10,2),

  -- Governance annotations — non-optional in spirit (the audit trail
  -- belongs here when any discount is allocated) but enforced at the
  -- application validator layer in Tuition-B, not at the DB level.
  -- Hard-requiring at DB would block legitimate empty-notes families
  -- (those with no special discount allocation).
  notes                    text,

  created_at               timestamptz not null default now(),
  created_by               uuid references auth.users(id) on delete set null,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references auth.users(id) on delete set null
);

create index tuition_worksheet_family_details_scenario_idx
  on tuition_worksheet_family_details (scenario_id);


-- ---- 5. Triggers ---------------------------------------------------------

-- 5a. tg_unlock_only_when_locked — REUSED from Migration 016. Generic
--     function references NEW.unlock_requested and NEW.state, both
--     of which exist on tuition_worksheet_scenarios with identical
--     semantics.
create trigger tuition_worksheet_scenarios_unlock_only_when_locked
  before insert or update on tuition_worksheet_scenarios
  for each row execute function tg_unlock_only_when_locked();

-- 5b. tg_enforce_tuition_stage_2_immutability — three-layer enforcement
--     of §7.3 Stage 2 immutability rules. Hard guard at the DB level;
--     application validator (Tuition-B) and UI affordance (Tuition-B)
--     are the other two layers per CLAUDE.md.
create or replace function tg_enforce_tuition_stage_2_immutability()
returns trigger language plpgsql as $$
declare
  v_stage_type     text;
  v_changed_fields text := '';
begin
  -- Resolve the scenario's stage type. Only Stage 2 (final) is gated.
  select stage_type into v_stage_type
    from module_workflow_stages
   where id = NEW.stage_id;

  if v_stage_type is null or v_stage_type <> 'final' then
    return NEW;
  end if;

  -- Field-by-field check. Use IS DISTINCT FROM so NULL changes are
  -- caught (though all six fields are NOT NULL with defaults today,
  -- the comparison is safe in case of a future schema change).
  if NEW.tier_count is distinct from OLD.tier_count then
    v_changed_fields := v_changed_fields || ', tier_count';
  end if;
  if NEW.tier_rates is distinct from OLD.tier_rates then
    v_changed_fields := v_changed_fields || ', tier_rates';
  end if;
  if NEW.faculty_discount_pct is distinct from OLD.faculty_discount_pct then
    v_changed_fields := v_changed_fields || ', faculty_discount_pct';
  end if;
  if NEW.curriculum_fee_per_student is distinct from OLD.curriculum_fee_per_student then
    v_changed_fields := v_changed_fields || ', curriculum_fee_per_student';
  end if;
  if NEW.enrollment_fee_per_student is distinct from OLD.enrollment_fee_per_student then
    v_changed_fields := v_changed_fields || ', enrollment_fee_per_student';
  end if;
  if NEW.before_after_school_hourly_rate is distinct from OLD.before_after_school_hourly_rate then
    v_changed_fields := v_changed_fields || ', before_after_school_hourly_rate';
  end if;

  if v_changed_fields <> '' then
    raise exception
      'Stage 2 (Tuition Audit) scenarios are immutable on configuration fields. Cannot change: %. To update tuition rates, edit the Stage 1 (Tuition Planning) scenario and re-lock. Architecture §7.3 Stage 2 immutability rules.',
      substring(v_changed_fields from 3); -- strip leading ', '
  end if;

  return NEW;
end;
$$;

create trigger tuition_worksheet_scenarios_stage_2_immutability
  before update on tuition_worksheet_scenarios
  for each row execute function tg_enforce_tuition_stage_2_immutability();

-- 5c. tg_check_tuition_family_details_stage — blocks inserting family
--     detail rows on Stage 1 scenarios. Per-family detail is the
--     audit substance of Stage 2; Stage 1 is configuration only.
create or replace function tg_check_tuition_family_details_stage()
returns trigger language plpgsql as $$
declare
  v_stage_type text;
begin
  select s.stage_type into v_stage_type
    from tuition_worksheet_scenarios sc
    join module_workflow_stages s on s.id = sc.stage_id
   where sc.id = NEW.scenario_id;

  if v_stage_type is null then
    raise exception
      'Cannot create family detail row: scenario % not found or has no stage assignment.',
      NEW.scenario_id;
  end if;

  if v_stage_type <> 'final' then
    raise exception
      'Family detail rows are only allowed on Stage 2 (Tuition Audit) scenarios. The referenced scenario has stage_type = %. Per §7.3, per-family detail belongs to Stage 2 only.',
      v_stage_type;
  end if;

  return NEW;
end;
$$;

create trigger tuition_worksheet_family_details_stage_check
  before insert on tuition_worksheet_family_details
  for each row execute function tg_check_tuition_family_details_stage();

-- 5d + 5e. Sibling-lock guards — parallel to Migration 015's budget
--          triggers. The 015 functions reference budget_stage_scenarios
--          by name in their SELECTs, so they don't generalize via
--          TG_TABLE_NAME. Tuition gets dedicated copies.
create or replace function tg_prevent_recommend_while_sibling_locked_tuition()
returns trigger language plpgsql as $$
declare
  v_blocking_label text;
begin
  if NEW.is_recommended is distinct from true then return NEW; end if;
  if OLD.is_recommended = true then return NEW; end if;

  select scenario_label into v_blocking_label
    from tuition_worksheet_scenarios
   where aye_id = NEW.aye_id
     and stage_id = NEW.stage_id
     and id != NEW.id
     and state = 'locked'
   limit 1;

  if v_blocking_label is not null then
    raise exception
      'Cannot mark "%" as recommended: scenario "%" in this (AYE, stage) is currently locked. Unlock it first.',
      NEW.scenario_label, v_blocking_label;
  end if;

  return NEW;
end;
$$;

create trigger tuition_scenarios_recommend_guard
  before update on tuition_worksheet_scenarios
  for each row execute function tg_prevent_recommend_while_sibling_locked_tuition();

create or replace function tg_prevent_lock_submit_while_sibling_locked_tuition()
returns trigger language plpgsql as $$
declare
  v_blocking_label text;
begin
  if NEW.state is distinct from 'pending_lock_review' then return NEW; end if;
  if OLD.state = 'pending_lock_review' then return NEW; end if;

  select scenario_label into v_blocking_label
    from tuition_worksheet_scenarios
   where aye_id = NEW.aye_id
     and stage_id = NEW.stage_id
     and id != NEW.id
     and state = 'locked'
   limit 1;

  if v_blocking_label is not null then
    raise exception
      'Cannot submit "%" for lock review: scenario "%" in this (AYE, stage) is currently locked. Unlock it first.',
      NEW.scenario_label, v_blocking_label;
  end if;

  return NEW;
end;
$$;

create trigger tuition_scenarios_lock_submit_guard
  before update on tuition_worksheet_scenarios
  for each row execute function tg_prevent_lock_submit_while_sibling_locked_tuition();

-- 5f. updated_at + change_log triggers (REUSED — generic functions)
create trigger tuition_worksheet_scenarios_updated_at
  before update on tuition_worksheet_scenarios
  for each row execute function tg_set_updated_at();

create trigger tuition_worksheet_scenarios_change_log
  after insert or update or delete on tuition_worksheet_scenarios
  for each row execute function tg_log_changes();

create trigger tuition_worksheet_family_details_updated_at
  before update on tuition_worksheet_family_details
  for each row execute function tg_set_updated_at();

create trigger tuition_worksheet_family_details_change_log
  after insert or update or delete on tuition_worksheet_family_details
  for each row execute function tg_log_changes();


-- ---- 6. RLS --------------------------------------------------------------

alter table tuition_worksheet_scenarios       enable row level security;
alter table tuition_worksheet_family_details  enable row level security;

create policy tuition_scenarios_read on tuition_worksheet_scenarios
  for select to authenticated
  using (current_user_has_module_perm('tuition', 'view'));

create policy tuition_scenarios_write on tuition_worksheet_scenarios
  for all to authenticated
  using (current_user_has_module_perm('tuition', 'edit'))
  with check (current_user_has_module_perm('tuition', 'edit'));

-- Family details additionally gated by can_view_family_details detail-
-- visibility flag, parallel to Migration 001's enrollment_audit_families
-- pattern. Module-level edit alone is not enough to view per-family
-- rows; the detail-visibility flag is required for redaction support.
create policy tuition_family_details_read on tuition_worksheet_family_details
  for select to authenticated
  using (
    current_user_has_module_perm('tuition', 'view')
    and can_view_family_details(auth.uid())
  );

create policy tuition_family_details_write on tuition_worksheet_family_details
  for all to authenticated
  using (
    current_user_has_module_perm('tuition', 'edit')
    and can_view_family_details(auth.uid())
  )
  with check (
    current_user_has_module_perm('tuition', 'edit')
    and can_view_family_details(auth.uid())
  );


-- ---- 7. Refresh change_log_read with tuition arms swapped ----------------
--
-- Drops the legacy 'tuition_worksheet' / 'tuition_scenarios' arms (the
-- old design's tables, dropped in section 0 above). Adds new arms for
-- the new tuition_worksheet_scenarios / tuition_worksheet_family_details
-- tables. Family details arm includes the can_view_family_details
-- detail-visibility check parallel to enrollment_audit_families.
-- All other arms from Migration 011 carried forward verbatim.
--
-- The legacy change_log rows referencing the dropped tables by
-- target_table name remain in change_log (text-keyed). After this
-- arm swap they're readable only to system admins (catch-all).
-- Acceptable since they're historical records of the abandoned
-- single-stage design.

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
      -- Tuition (rewritten in Migration 022 — replaces legacy tuition_worksheet / tuition_scenarios arms)
      when 'tuition_worksheet_scenarios'    then current_user_has_module_perm('tuition', 'view')
      when 'tuition_worksheet_family_details' then
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


-- ---- 8. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 022
-- ============================================================================
