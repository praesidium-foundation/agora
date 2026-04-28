-- ============================================================================
-- Migration 008: Annual Rhythm Settings — Lock Cascade Rules
--
-- Architecture Section 3.4 defines the lock-cascade semantic ("a downstream
-- module cannot be locked unless its upstream sources are locked"). Until
-- now those rules lived in code; this migration moves them into a per-school
-- configuration table so other schools can adapt the rules to their own
-- annual rhythm without code changes. Today: just cascade rules. Future
-- Annual-Rhythm migrations will sit alongside this with sibling tables
-- (lock-policy windows, fiscal calendar overrides, etc.).
--
-- Design notes:
--
-- * `module_being_locked` and `required_module` are stored as text codes
--   (matching `modules.code`) rather than FKs to `modules.id`. Two reasons:
--   (1) the code never changes once minted, so no FK is needed for stability;
--   (2) a config row may reference a module whose row hasn't been seeded
--   yet (forward-references during phased rollout). The validation trigger
--   below enforces existence at INSERT/UPDATE time.
--
-- * `is_required` distinguishes hard rule (block lock until upstream
--   satisfies the requirement) from soft rule (warning only). This matches
--   the architecture's "warning, not error" pattern for non-blocking
--   dependencies.
--
-- * `required_state` is a text with CHECK constraint rather than reusing
--   the `module_state` enum. The cascade can require any of several
--   "satisfied" states; restricting to the literal enum values keeps
--   options open without forcing exact-match semantics into the enum
--   itself.
--
-- * Permissions: any authenticated user can READ cascade rules (they're
--   not confidential — they describe how the platform behaves).
--   System admin only for WRITE today. A future `annual_rhythm` module
--   permission could replace the system-admin gate when more configuration
--   surfaces land.
-- ============================================================================

-- ---- 1. Table ------------------------------------------------------------

create table school_lock_cascade_rules (
  id                     uuid primary key default gen_random_uuid(),

  -- The module whose lock action this rule governs. Text-key into
  -- modules.code; validated by trigger.
  module_being_locked    text not null,

  -- The upstream module that must be in `required_state` before
  -- module_being_locked can be locked.
  required_module        text not null,

  -- Which state the upstream must be in for this rule to be satisfied.
  -- 'locked' is the common case; 'pending_approval' / 'pending_lock_review'
  -- left available for soft policies that just need the upstream to be
  -- past drafting.
  required_state         text not null default 'locked'
                         check (required_state in (
                           'locked',
                           'pending_lock_review',
                           'pending_unlock_review'
                         )),

  -- false = warning only (UI surfaces it but doesn't block).
  is_required            boolean not null default true,

  created_at             timestamptz not null default now(),
  created_by             uuid references auth.users(id),
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users(id),

  unique (module_being_locked, required_module)
);

create index slcr_locked_module_idx
  on school_lock_cascade_rules (module_being_locked);

create trigger school_lock_cascade_rules_updated_at
  before update on school_lock_cascade_rules
  for each row execute function tg_set_updated_at();

-- ---- 2. Validation trigger -----------------------------------------------

-- Both module codes must reference real rows in the modules table, and
-- a module can't list itself as its own upstream.
create or replace function tg_validate_cascade_rule_modules()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from modules where code = NEW.module_being_locked) then
    raise exception 'Unknown module code in module_being_locked: %',
      NEW.module_being_locked;
  end if;
  if not exists (select 1 from modules where code = NEW.required_module) then
    raise exception 'Unknown module code in required_module: %',
      NEW.required_module;
  end if;
  if NEW.module_being_locked = NEW.required_module then
    raise exception 'A module cannot list itself as a required upstream: %',
      NEW.module_being_locked;
  end if;
  return NEW;
end;
$$;

create trigger school_lock_cascade_rules_validate_modules
  before insert or update on school_lock_cascade_rules
  for each row execute function tg_validate_cascade_rule_modules();

-- ---- 3. Audit logging ----------------------------------------------------

create trigger school_lock_cascade_rules_change_log
  after insert or update or delete on school_lock_cascade_rules
  for each row execute function tg_log_changes();

-- ---- 4. RLS --------------------------------------------------------------

alter table school_lock_cascade_rules enable row level security;

-- Read: any signed-in user. Cascade rules are not confidential.
create policy school_lock_cascade_rules_read on school_lock_cascade_rules
  for select to authenticated
  using (true);

-- Write: system admin only. A dedicated 'annual_rhythm' module permission
-- can replace this when more configuration surfaces are built.
create policy school_lock_cascade_rules_write on school_lock_cascade_rules
  for all to authenticated
  using (is_system_admin())
  with check (is_system_admin());

-- ---- 5. Extend change_log read policy ------------------------------------

-- The change_log read policy uses a per-target_table case statement (last
-- redefined in Migration 004). To add a new arm we drop and recreate the
-- whole policy. This is repetitive — every migration that adds a logged
-- table has to know the full set of existing arms — but it keeps the
-- policy in one place (the latest migration that touched it) which is
-- the simplest pattern that survives further extensions.
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
      -- New in Migration 008: cascade rules. Public-readable (matches the
      -- table policy itself).
      when 'school_lock_cascade_rules'      then true
      else false
    end
  );

-- ============================================================================
-- END OF MIGRATION 008
-- ============================================================================
