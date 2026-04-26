-- ============================================================================
-- Libertas Agora — Initial Schema Migration (001)
-- ============================================================================
-- Stack:    Supabase (Postgres 15+) + React + Vercel + GitHub
-- Scope:    Single school, no tenant layer (YAGNI per spec).
-- Time:     All operational data scoped via academic_years (AYE).
-- Identity: user_profiles extends auth.users; staff is a separate global roster
--           that may or may not link to a system user.
-- Workflow: module_instances hold per-(module × AYE) state; transitions go
--           through transition_module_state() function only.
--
-- DESIGN DECISIONS (flagged here, repeated inline at the relevant tables):
--
--   * Computed fields:
--       - tuition_scenarios:        trigger-based (chained formulas)
--       - staffing_scenario_positions: trigger-based (branches on comp type)
--       - enrollment_audit_families.net_tuition:   GENERATED column
--       - enrollment_audit_summary.total_ed_program_dollars: GENERATED column
--
--   * Lock enforcement: DB-level trigger blocks writes on module data tables
--     when state in (locked, pending_lock_review, pending_unlock_review).
--     System admins bypass. Belt-and-suspenders on top of app-layer checks.
--
--   * Permission model: hierarchical enum (view < edit < submit_lock <
--     approve_lock < admin). Module permissions are GLOBAL (not AYE-scoped).
--     Lock state is the AYE enforcement mechanism.
--
--   * is_system_admin lives on user_profiles. Needed for cross-module
--     operations (AYE management, permission grants, lock override).
--
--   * Change reasons: app sets SET LOCAL app.change_reason = '...' before
--     write; the generic change_log trigger picks it up. Optional.
--
--   * Family-detail visibility: separate boolean on user_module_permissions,
--     only meaningful for enrollment_audit module. RLS enforces.
--
--   * Enrollment Audit module is intentionally NOT lock-enforced. Mid-year
--     FA changes and roster moves are expected. change_log is the
--     accountability mechanism here.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. ENUM TYPES
-- ============================================================================

-- Hierarchical: ordering matters for >= comparisons
create type permission_level as enum (
  'view',
  'edit',
  'submit_lock',
  'approve_lock',
  'admin'
);

create type module_state as enum (
  'draft',
  'pending_lock_review',
  'locked',
  'pending_unlock_review'
);

create type state_action as enum (
  'submit_lock',
  'approve_lock',
  'reject_lock',
  'submit_unlock',
  'approve_unlock',
  'reject_unlock'
);

create type module_category as enum (
  'financial',
  'governance',
  'operations'
);

create type position_type as enum (
  'faculty',
  'staff',
  'admin'
);

create type compensation_type as enum (
  'hourly',
  'salary',
  'leadership',
  'stipend',
  'contractor',
  'substitute'
);

create type budget_source_type as enum (
  'manual',
  'linked_staffing',
  'linked_tuition'
);

-- ============================================================================
-- 2. SHARED HELPERS (updated_at + admin check)
-- ============================================================================

create or replace function tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- is_system_admin() is defined later, AFTER user_profiles is created
-- (see end of section 3). plpgsql defers name resolution to runtime, but we
-- still keep the definition in dependency order for clarity.

-- ============================================================================
-- 3. FOUNDATION TABLES
-- ============================================================================

-- ---- academic_years --------------------------------------------------------
create table academic_years (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique,                  -- e.g. 'AYE 2027'
  start_date  date not null,                         -- e.g. 2026-07-01
  end_date    date not null,                         -- e.g. 2027-06-30
  is_current  boolean not null default false,        -- default-shown AYE only;
                                                     -- does NOT control editability
  is_locked   boolean not null default false,        -- structural lock on the AYE itself
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  updated_by  uuid references auth.users(id),
  constraint  aye_dates_valid check (end_date > start_date)
);

-- Only one AYE may have is_current = true at any time
create unique index academic_years_one_current_idx
  on academic_years (is_current) where is_current = true;

create trigger academic_years_updated_at
  before update on academic_years
  for each row execute function tg_set_updated_at();

-- ---- user_profiles ---------------------------------------------------------
create table user_profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  full_name       text not null,
  email           text not null,
  title           text,                              -- descriptive only,
                                                     -- not used for authorization
  is_active       boolean not null default true,
  is_system_admin boolean not null default false,    -- cross-module admin
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger user_profiles_updated_at
  before update on user_profiles
  for each row execute function tg_set_updated_at();

-- Auto-create profile row when an auth user is created
create or replace function handle_new_user()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---- is_system_admin() ----------------------------------------------------
-- Defined AFTER user_profiles exists. Uses plpgsql so reference resolution
-- happens at call time, which makes future reorderings safer too.
create or replace function is_system_admin()
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_admin boolean;
begin
  select up.is_system_admin into v_admin
    from user_profiles up
   where up.id = auth.uid();
  return coalesce(v_admin, false);
end;
$$;

-- ---- staff (global roster, NOT AYE-scoped) --------------------------------
create table staff (
  id                uuid primary key default gen_random_uuid(),
  first_name        text not null,
  last_name         text not null,
  email             text,
  position_type     position_type not null,
  hire_date         date,
  termination_date  date,
  is_active         boolean not null default true,
  linked_user_id    uuid references user_profiles(id) on delete set null,
                                                     -- nullable: staff without
                                                     -- a system login is valid
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id),
  updated_by        uuid references auth.users(id)
);

-- A user can be linked to at most one staff record
create unique index staff_linked_user_unique_idx
  on staff(linked_user_id) where linked_user_id is not null;

create index staff_active_idx on staff(is_active) where is_active = true;

create trigger staff_updated_at
  before update on staff
  for each row execute function tg_set_updated_at();

-- ============================================================================
-- 4. MODULE REGISTRY + PERMISSIONS
-- ============================================================================

-- ---- modules (canonical registry) -----------------------------------------
create table modules (
  id                      uuid primary key default gen_random_uuid(),
  code                    text not null unique,
  display_name            text not null,
  category                module_category not null,
  requires_lock_workflow  boolean not null default false,
  is_active               boolean not null default true,
  sort_order              int not null default 0,
  created_at              timestamptz not null default now()
);

-- Seed the known modules
insert into modules (code, display_name, category, requires_lock_workflow, sort_order) values
  ('enrollment_estimator', 'Enrollment Estimator', 'financial', true,  10),
  ('tuition_worksheet',    'Tuition Worksheet',    'financial', true,  20),
  ('staffing',             'Staffing',             'financial', true,  30),
  ('preliminary_budget',   'Preliminary Budget',   'financial', true,  40),
  ('enrollment_audit',     'Enrollment Audit',     'financial', false, 50),
  ('final_budget',         'Final Budget',         'financial', true,  60);

-- ---- user_module_permissions ----------------------------------------------
create table user_module_permissions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references user_profiles(id) on delete cascade,
  module_id                uuid not null references modules(id) on delete cascade,
  permission_level         permission_level not null,
  -- only meaningful when module = 'enrollment_audit'; ignored otherwise
  can_view_family_details  boolean not null default false,
  granted_by               uuid references auth.users(id),
  granted_at               timestamptz not null default now(),
  unique (user_id, module_id)
);

create index ump_user_idx on user_module_permissions(user_id);

-- ---- permission helper -----------------------------------------------------
create or replace function current_user_has_module_perm(
  p_module_code     text,
  p_required_level  permission_level
)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select ump.permission_level >= p_required_level
       from user_module_permissions ump
       join modules m on m.id = ump.module_id
      where ump.user_id = auth.uid()
        and m.code = p_module_code
      limit 1),
    false
  ) or is_system_admin();
$$;

create or replace function can_view_family_details(p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select ump.can_view_family_details
       from user_module_permissions ump
       join modules m on m.id = ump.module_id
      where ump.user_id = p_user_id
        and m.code = 'enrollment_audit'
      limit 1),
    false
  ) or coalesce(
    (select up.is_system_admin from user_profiles up where up.id = p_user_id),
    false
  );
$$;

-- ============================================================================
-- 5. MODULE INSTANCES + STATE TRANSITIONS
-- ============================================================================

create table module_instances (
  id              uuid primary key default gen_random_uuid(),
  module_id       uuid not null references modules(id),
  aye_id          uuid not null references academic_years(id) on delete restrict,
  state           module_state not null default 'draft',
  last_action_by  uuid references auth.users(id),
  last_action_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (module_id, aye_id)
);

create index module_instances_aye_idx on module_instances(aye_id);
create index module_instances_state_idx on module_instances(state);

create trigger module_instances_updated_at
  before update on module_instances
  for each row execute function tg_set_updated_at();

create table module_state_transitions (
  id                  uuid primary key default gen_random_uuid(),
  module_instance_id  uuid not null references module_instances(id) on delete cascade,
  from_state          module_state not null,
  to_state            module_state not null,
  action_type         state_action not null,
  performed_by        uuid not null references auth.users(id),
  performed_at        timestamptz not null default now(),
  notes               text,
  -- rejections require a reason
  constraint rejection_requires_notes check (
    action_type not in ('reject_lock', 'reject_unlock')
    or (notes is not null and length(trim(notes)) > 0)
  )
);

create index mst_instance_idx
  on module_state_transitions(module_instance_id, performed_at desc);

-- ---- state machine validation trigger -------------------------------------
-- Belt-and-suspenders: even if someone bypasses transition_module_state(),
-- this trigger still blocks invalid transitions and enforces permissions.
create or replace function tg_validate_state_transition()
returns trigger language plpgsql
security definer set search_path = public
as $$
declare
  v_module_code   text;
  v_required_perm permission_level;
begin
  if old.state = new.state then
    return new;
  end if;

  select m.code into v_module_code from modules m where m.id = new.module_id;

  v_required_perm := case
    when old.state = 'draft'                  and new.state = 'pending_lock_review'   then 'submit_lock'::permission_level
    when old.state = 'pending_lock_review'    and new.state = 'locked'                then 'approve_lock'::permission_level
    when old.state = 'pending_lock_review'    and new.state = 'draft'                 then 'approve_lock'::permission_level  -- reject_lock
    when old.state = 'locked'                 and new.state = 'pending_unlock_review' then 'submit_lock'::permission_level
    when old.state = 'pending_unlock_review'  and new.state = 'draft'                 then 'approve_lock'::permission_level  -- approve_unlock
    when old.state = 'pending_unlock_review'  and new.state = 'locked'                then 'approve_lock'::permission_level  -- reject_unlock
    else null
  end;

  if v_required_perm is null then
    raise exception 'Invalid module state transition: % -> %', old.state, new.state;
  end if;

  if not current_user_has_module_perm(v_module_code, v_required_perm) then
    raise exception 'Insufficient permission for transition % -> % on module %',
      old.state, new.state, v_module_code;
  end if;

  new.last_action_by := auth.uid();
  new.last_action_at := now();
  return new;
end;
$$;

create trigger module_instances_validate_state
  before update of state on module_instances
  for each row execute function tg_validate_state_transition();

-- ---- transition_module_state: the canonical entry point -------------------
-- All app-layer state transitions should call this function. It atomically:
--   1. Validates the transition + permission (also enforced by trigger above)
--   2. Updates module_instances.state
--   3. Inserts module_state_transitions row with notes
-- Rejections require non-empty notes.
create or replace function transition_module_state(
  p_module_instance_id  uuid,
  p_new_state           module_state,
  p_notes               text default null
)
returns module_instances
language plpgsql
security definer set search_path = public
as $$
declare
  v_old_state   module_state;
  v_module_code text;
  v_action      state_action;
  v_result      module_instances;
begin
  select mi.state, m.code
    into v_old_state, v_module_code
    from module_instances mi
    join modules m on m.id = mi.module_id
   where mi.id = p_module_instance_id
   for update;

  if not found then
    raise exception 'Module instance not found: %', p_module_instance_id;
  end if;

  v_action := case
    when v_old_state = 'draft'                 and p_new_state = 'pending_lock_review'   then 'submit_lock'::state_action
    when v_old_state = 'pending_lock_review'   and p_new_state = 'locked'                then 'approve_lock'::state_action
    when v_old_state = 'pending_lock_review'   and p_new_state = 'draft'                 then 'reject_lock'::state_action
    when v_old_state = 'locked'                and p_new_state = 'pending_unlock_review' then 'submit_unlock'::state_action
    when v_old_state = 'pending_unlock_review' and p_new_state = 'draft'                 then 'approve_unlock'::state_action
    when v_old_state = 'pending_unlock_review' and p_new_state = 'locked'                then 'reject_unlock'::state_action
    else null
  end;

  if v_action is null then
    raise exception 'Invalid state transition: % -> %', v_old_state, p_new_state;
  end if;

  if v_action in ('reject_lock', 'reject_unlock')
     and (p_notes is null or length(trim(p_notes)) = 0) then
    raise exception 'Rejections require a reason in notes (action: %)', v_action;
  end if;

  -- Permission check is also done by the validate trigger; doing it here
  -- gives a cleaner error message before the UPDATE fires.
  if not current_user_has_module_perm(
       v_module_code,
       case when v_action in ('submit_lock', 'submit_unlock')
            then 'submit_lock'::permission_level
            else 'approve_lock'::permission_level end
     ) then
    raise exception 'Insufficient permission: % on module %', v_action, v_module_code;
  end if;

  update module_instances
     set state = p_new_state
   where id = p_module_instance_id
   returning * into v_result;

  insert into module_state_transitions(
    module_instance_id, from_state, to_state, action_type, performed_by, notes
  )
  values (p_module_instance_id, v_old_state, p_new_state, v_action, auth.uid(), p_notes);

  return v_result;
end;
$$;

-- ---- shared lock-enforcement helper for module data tables ----------------
-- Generic check: blocks writes when the module instance for the row's AYE
-- is in a state that should freeze data (locked or under review).
-- Pass the module code as the first trigger argument.
create or replace function tg_check_module_locked_direct()
returns trigger language plpgsql
security definer set search_path = public
as $$
declare
  v_module_code text := tg_argv[0];
  v_aye_id      uuid;
  v_state       module_state;
begin
  v_aye_id := case when tg_op = 'DELETE' then old.aye_id else new.aye_id end;

  select mi.state into v_state
    from module_instances mi
    join modules m on m.id = mi.module_id
   where m.code = v_module_code and mi.aye_id = v_aye_id;

  if v_state in ('locked', 'pending_lock_review', 'pending_unlock_review')
     and not is_system_admin() then
    raise exception 'Module % is locked for this AYE (state: %); writes blocked',
      v_module_code, v_state;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- For child tables whose AYE comes from a parent (tuition_scenarios via
-- tuition_worksheet, staffing_scenario_positions via staffing_scenarios)
-- we define table-specific variants below.

-- ============================================================================
-- 6. ENROLLMENT (program structure + monthly tracking)
-- ============================================================================

-- ---- aye_grade_sections ---------------------------------------------------
create table aye_grade_sections (
  id              uuid primary key default gen_random_uuid(),
  aye_id          uuid not null references academic_years(id) on delete cascade,
  grade_level     text not null,                    -- 'TK','K','1'..'12'
  section_name    text not null,                    -- e.g. 'TK #1'
  is_combo        boolean not null default false,
  combo_label     text,                             -- e.g. '2/3 Combo'
  max_enrollment  int,
  is_active       boolean not null default true,
  sort_order      int not null default 0,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  updated_by      uuid references auth.users(id),
  unique (aye_id, section_name),
  constraint combo_label_when_combo check (
    (is_combo = false) or (combo_label is not null and length(trim(combo_label)) > 0)
  )
);

create index ags_aye_idx on aye_grade_sections(aye_id);

create trigger aye_grade_sections_updated_at
  before update on aye_grade_sections
  for each row execute function tg_set_updated_at();

create trigger aye_grade_sections_lock_check
  before insert or update or delete on aye_grade_sections
  for each row execute function tg_check_module_locked_direct('enrollment_estimator');

-- ---- enrollment_monthly ---------------------------------------------------
-- enrolled_next_aye and actual_current_aye are independent data points that
-- happen to share the UI; do not derive one from the other.
create table enrollment_monthly (
  id                   uuid primary key default gen_random_uuid(),
  aye_id               uuid not null references academic_years(id) on delete cascade,
  grade_section_id     uuid not null references aye_grade_sections(id) on delete cascade,
  month                int not null check (month between 1 and 12),
  enrolled_next_aye    int default 0,               -- pre-enrollment for following year
  actual_current_aye   int default 0,               -- current month headcount
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references auth.users(id),
  updated_by           uuid references auth.users(id),
  unique (grade_section_id, month)
);

create index em_aye_idx on enrollment_monthly(aye_id);
create index em_section_idx on enrollment_monthly(grade_section_id);

create trigger enrollment_monthly_updated_at
  before update on enrollment_monthly
  for each row execute function tg_set_updated_at();

create trigger enrollment_monthly_lock_check
  before insert or update or delete on enrollment_monthly
  for each row execute function tg_check_module_locked_direct('enrollment_estimator');

-- ============================================================================
-- 7. TUITION (worksheet + scenarios)
-- ============================================================================

create table tuition_worksheet (
  id                       uuid primary key default gen_random_uuid(),
  aye_id                   uuid not null references academic_years(id) on delete cascade,
  recommended_scenario_id  uuid,                    -- FK added after tuition_scenarios
  narrative                text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid references auth.users(id),
  updated_by               uuid references auth.users(id),
  unique (aye_id)
);

create trigger tuition_worksheet_updated_at
  before update on tuition_worksheet
  for each row execute function tg_set_updated_at();

create trigger tuition_worksheet_lock_check
  before insert or update or delete on tuition_worksheet
  for each row execute function tg_check_module_locked_direct('tuition_worksheet');

-- ---- tuition_scenarios -----------------------------------------------------
-- Computed fields populated by tg_compute_tuition_scenario_totals (trigger).
-- Chosen over generated columns because formulas chain (e.g., ed_program_ratio
-- depends on total_ed_program_dollars, which depends on net_tuition).
create table tuition_scenarios (
  id                            uuid primary key default gen_random_uuid(),
  worksheet_id                  uuid not null references tuition_worksheet(id) on delete cascade,
  scenario_label                text not null check (scenario_label in ('A','B','C','D')),

  -- proposed rates (per student / per family)
  proposed_rate                 numeric(10,2) not null default 0,
  curriculum_fee_rate           numeric(10,2) not null default 0,
  enrollment_fee_rate           numeric(10,2) not null default 0,
  volunteer_buyout_fee          numeric(10,2) not null default 0,

  -- enrollment projections
  projected_students            int not null default 0,
  families_1_student            int not null default 0,
  families_2_student            int not null default 0,
  families_3_student            int not null default 0,
  families_4plus_student        int not null default 0,

  -- aggregate discounts
  multi_student_discount_total  numeric(12,2) not null default 0,
  faculty_discount_total        numeric(12,2) not null default 0,
  other_discount_total          numeric(12,2) not null default 0,
  financial_aid_total           numeric(12,2) not null default 0,

  -- BA Care + total expense projection
  ba_care_estimate              numeric(12,2) not null default 0,
  projected_expenses            numeric(12,2) not null default 0,

  -- COMPUTED (trigger-populated; do not write directly)
  gross_tuition                 numeric(12,2),
  net_tuition                   numeric(12,2),
  curriculum_fees_total         numeric(12,2),
  enrollment_fees_total         numeric(12,2),
  volunteer_buyout_total        numeric(12,2),
  total_ed_program_dollars      numeric(12,2),
  ed_program_ratio              numeric(8,4),       -- target = 1.20
  gap_to_target                 numeric(12,2),      -- (expenses * 1.2) - ed_dollars
  fundraising_needed            numeric(12,2),      -- max(0, expenses - ed_dollars)

  is_recommended                boolean not null default false,

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  unique (worksheet_id, scenario_label)
);

-- Now wire the FK back from worksheet -> scenarios
alter table tuition_worksheet
  add constraint tuition_worksheet_recommended_scenario_fk
  foreign key (recommended_scenario_id) references tuition_scenarios(id)
  on delete set null;

create index ts_worksheet_idx on tuition_scenarios(worksheet_id);

create or replace function tg_compute_tuition_scenario_totals()
returns trigger language plpgsql as $$
declare
  v_total_families int;
  v_ed_dollars     numeric(12,2);
begin
  v_total_families := new.families_1_student + new.families_2_student
                    + new.families_3_student + new.families_4plus_student;

  new.gross_tuition          := new.proposed_rate * new.projected_students;
  new.net_tuition            := new.gross_tuition
                              - new.multi_student_discount_total
                              - new.faculty_discount_total
                              - new.other_discount_total
                              - new.financial_aid_total;
  new.curriculum_fees_total  := new.curriculum_fee_rate * new.projected_students;
  new.enrollment_fees_total  := new.enrollment_fee_rate * new.projected_students;
  new.volunteer_buyout_total := new.volunteer_buyout_fee * v_total_families;

  v_ed_dollars := new.net_tuition
                + new.curriculum_fees_total
                + new.enrollment_fees_total
                + new.volunteer_buyout_total
                + new.ba_care_estimate;

  new.total_ed_program_dollars := v_ed_dollars;

  new.ed_program_ratio := case
    when new.projected_expenses > 0 then v_ed_dollars / new.projected_expenses
    else null
  end;

  -- 1:1.2 target ratio (Ed Program $ should be 120% of expenses)
  new.gap_to_target       := (new.projected_expenses * 1.2) - v_ed_dollars;
  new.fundraising_needed  := greatest(0, new.projected_expenses - v_ed_dollars);

  new.updated_at := now();
  return new;
end;
$$;

create trigger tuition_scenarios_compute_totals
  before insert or update on tuition_scenarios
  for each row execute function tg_compute_tuition_scenario_totals();

create trigger tuition_scenarios_updated_at
  before update on tuition_scenarios
  for each row execute function tg_set_updated_at();

-- Lock check derives AYE from the parent worksheet
create or replace function tg_check_locked_tuition_scenario()
returns trigger language plpgsql
security definer set search_path = public
as $$
declare
  v_aye_id uuid;
  v_state  module_state;
begin
  select tw.aye_id into v_aye_id
    from tuition_worksheet tw
   where tw.id = case when tg_op = 'DELETE' then old.worksheet_id else new.worksheet_id end;

  select mi.state into v_state
    from module_instances mi
    join modules m on m.id = mi.module_id
   where m.code = 'tuition_worksheet' and mi.aye_id = v_aye_id;

  if v_state in ('locked', 'pending_lock_review', 'pending_unlock_review')
     and not is_system_admin() then
    raise exception 'Tuition Worksheet is locked for this AYE (state: %); writes blocked', v_state;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger tuition_scenarios_lock_check
  before insert or update or delete on tuition_scenarios
  for each row execute function tg_check_locked_tuition_scenario();

-- ============================================================================
-- 8. STAFFING (scenarios + per-scenario position lines)
-- ============================================================================

create table staffing_scenarios (
  id                      uuid primary key default gen_random_uuid(),
  aye_id                  uuid not null references academic_years(id) on delete cascade,
  scenario_label          text not null check (scenario_label in ('A','B','C')),
  description             text,
  is_recommended          boolean not null default false,
  instruction_days        int,
  staff_development_days  int,
  payroll_tax_pct         numeric(5,2) not null default 7.65,
  workers_comp_estimate   numeric(12,2) not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references auth.users(id),
  updated_by              uuid references auth.users(id),
  unique (aye_id, scenario_label)
);

create index ss_aye_idx on staffing_scenarios(aye_id);

create trigger staffing_scenarios_updated_at
  before update on staffing_scenarios
  for each row execute function tg_set_updated_at();

create trigger staffing_scenarios_lock_check
  before insert or update or delete on staffing_scenarios
  for each row execute function tg_check_module_locked_direct('staffing');

-- ---- staffing_scenario_positions ------------------------------------------
-- A staff member may appear on multiple rows in the same scenario (e.g. a
-- salary line + a stipend line + a leadership line). Each row is a separate
-- compensation line; no unique constraint on (scenario_id, staff_id).
--
-- proposed_total computed by trigger because formula branches on comp type.
create table staffing_scenario_positions (
  id                  uuid primary key default gen_random_uuid(),
  scenario_id         uuid not null references staffing_scenarios(id) on delete cascade,
  staff_id            uuid references staff(id),    -- null = open / planned
  position_title      text not null,
  compensation_type   compensation_type not null,

  base_amount         numeric(12,2) not null default 0,
  increase_pct        numeric(5,2)  not null default 3.0,
  increase_override   boolean       not null default false,
  additional_amount   numeric(12,2) not null default 0,

  -- hourly only (nullable for other comp types)
  hours_per_week      numeric(5,2),
  weeks               int default 34,
  additional_hours    numeric(7,2) default 0,

  days_per_week       numeric(3,1),

  -- COMPUTED (trigger-populated)
  proposed_total      numeric(12,2),

  is_active           boolean not null default true,  -- false = zeroed out
  notes               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id),
  updated_by          uuid references auth.users(id)
);

create index ssp_scenario_idx on staffing_scenario_positions(scenario_id);
create index ssp_staff_idx    on staffing_scenario_positions(staff_id) where staff_id is not null;

create or replace function tg_compute_position_total()
returns trigger language plpgsql as $$
begin
  if not new.is_active then
    new.proposed_total := 0;
  elsif new.compensation_type = 'hourly' then
    new.proposed_total := (
        coalesce(new.hours_per_week, 0) * coalesce(new.weeks, 0)
        + coalesce(new.additional_hours, 0)
      ) * new.base_amount;
  else
    -- salary, leadership, stipend, contractor, substitute
    new.proposed_total := new.base_amount * (1 + new.increase_pct / 100.0)
                        + new.additional_amount;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger ssp_compute_total
  before insert or update on staffing_scenario_positions
  for each row execute function tg_compute_position_total();

-- Lock check derives AYE from parent scenario
create or replace function tg_check_locked_ssp()
returns trigger language plpgsql
security definer set search_path = public
as $$
declare
  v_aye_id uuid;
  v_state  module_state;
begin
  select ss.aye_id into v_aye_id
    from staffing_scenarios ss
   where ss.id = case when tg_op = 'DELETE' then old.scenario_id else new.scenario_id end;

  select mi.state into v_state
    from module_instances mi
    join modules m on m.id = mi.module_id
   where m.code = 'staffing' and mi.aye_id = v_aye_id;

  if v_state in ('locked', 'pending_lock_review', 'pending_unlock_review')
     and not is_system_admin() then
    raise exception 'Staffing is locked for this AYE (state: %); writes blocked', v_state;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger ssp_lock_check
  before insert or update or delete on staffing_scenario_positions
  for each row execute function tg_check_locked_ssp();

-- ============================================================================
-- 9. BUDGETS (preliminary + final, identical shape)
-- ============================================================================

create table preliminary_budget (
  id            uuid primary key default gen_random_uuid(),
  aye_id        uuid not null references academic_years(id) on delete cascade,
  category      text not null,
  subcategory   text,
  description   text not null,
  amount        numeric(12,2) not null default 0,
  source_type   budget_source_type not null default 'manual',
  source_ref_id uuid,                                -- nullable cross-ref
  notes         text,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id)
);

create index pb_aye_idx on preliminary_budget(aye_id);

create trigger preliminary_budget_updated_at
  before update on preliminary_budget
  for each row execute function tg_set_updated_at();

create trigger preliminary_budget_lock_check
  before insert or update or delete on preliminary_budget
  for each row execute function tg_check_module_locked_direct('preliminary_budget');

create table final_budget (
  id            uuid primary key default gen_random_uuid(),
  aye_id        uuid not null references academic_years(id) on delete cascade,
  category      text not null,
  subcategory   text,
  description   text not null,
  amount        numeric(12,2) not null default 0,
  source_type   budget_source_type not null default 'manual',
  source_ref_id uuid,
  notes         text,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_by    uuid references auth.users(id)
);

create index fb_aye_idx on final_budget(aye_id);

create trigger final_budget_updated_at
  before update on final_budget
  for each row execute function tg_set_updated_at();

create trigger final_budget_lock_check
  before insert or update or delete on final_budget
  for each row execute function tg_check_module_locked_direct('final_budget');

-- ============================================================================
-- 10. ENROLLMENT AUDIT (family-level + summary)
-- ============================================================================
-- NOT lock-enforced. Mid-year FA changes are expected; change_log is the
-- accountability mechanism.

create table enrollment_audit_families (
  id                      uuid primary key default gen_random_uuid(),
  aye_id                  uuid not null references academic_years(id) on delete cascade,
  family_name             text not null,
  student_count           int not null default 0,
  base_tuition            numeric(12,2) not null default 0,
  multi_student_discount  numeric(12,2) not null default 0,
  faculty_discount        numeric(12,2) not null default 0,
  other_discount          numeric(12,2) not null default 0,
  financial_aid           numeric(12,2) not null default 0,
  -- simple non-chained generated column
  net_tuition             numeric(12,2) generated always as (
    base_tuition - multi_student_discount - faculty_discount
                 - other_discount - financial_aid
  ) stored,
  semester                int not null check (semester in (1, 2)),
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references auth.users(id),
  updated_by              uuid references auth.users(id)
);

create index eaf_aye_idx on enrollment_audit_families(aye_id);
create index eaf_aye_semester_idx on enrollment_audit_families(aye_id, semester);

create trigger eaf_updated_at
  before update on enrollment_audit_families
  for each row execute function tg_set_updated_at();

create table enrollment_audit_summary (
  id                        uuid primary key default gen_random_uuid(),
  aye_id                    uuid not null references academic_years(id) on delete cascade,
  audit_date                date not null,
  total_families            int not null default 0,
  total_students            int not null default 0,
  gross_tuition             numeric(12,2) not null default 0,
  total_discounts           numeric(12,2) not null default 0,
  net_tuition               numeric(12,2) not null default 0,
  curriculum_fees           numeric(12,2) not null default 0,
  enrollment_fees           numeric(12,2) not null default 0,
  volunteer_buyout          numeric(12,2) not null default 0,
  ba_care                   numeric(12,2) not null default 0,
  total_ed_program_dollars  numeric(12,2) generated always as (
    net_tuition + curriculum_fees + enrollment_fees + volunteer_buyout + ba_care
  ) stored,
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid references auth.users(id),
  updated_by                uuid references auth.users(id),
  unique (aye_id, audit_date)
);

create index eas_aye_idx on enrollment_audit_summary(aye_id);

create trigger eas_updated_at
  before update on enrollment_audit_summary
  for each row execute function tg_set_updated_at();

-- ============================================================================
-- 11. GENERIC CHANGE LOG
-- ============================================================================

create table change_log (
  id            uuid primary key default gen_random_uuid(),
  target_table  text not null,
  target_id     uuid not null,
  field_name    text not null,
  old_value     jsonb,
  new_value     jsonb,
  changed_by    uuid references auth.users(id),
  changed_at    timestamptz not null default now(),
  reason        text                              -- optional, set via
                                                  -- SET LOCAL app.change_reason
);

create index change_log_target_idx
  on change_log(target_table, target_id, changed_at desc);
create index change_log_changed_by_idx
  on change_log(changed_by, changed_at desc);

-- ---- generic logging trigger -----------------------------------------------
-- Captures field-level diffs on UPDATE; whole-row snapshots on INSERT/DELETE.
-- Skips updated_at/updated_by columns to reduce noise.
-- App may set a reason via:  SET LOCAL app.change_reason = 'Mid-year FA bump';
create or replace function tg_log_changes()
returns trigger language plpgsql
security definer set search_path = public
as $$
declare
  v_old_row jsonb;
  v_new_row jsonb;
  v_key     text;
  v_changer uuid;
  v_reason  text;
begin
  begin
    v_changer := auth.uid();
  exception when others then
    v_changer := null;
  end;

  v_reason := nullif(current_setting('app.change_reason', true), '');

  if tg_op = 'INSERT' then
    insert into change_log(target_table, target_id, field_name,
                           old_value, new_value, changed_by, reason)
    values (tg_table_name, new.id, '__insert__',
            null, to_jsonb(new), v_changer, v_reason);
    return new;

  elsif tg_op = 'DELETE' then
    insert into change_log(target_table, target_id, field_name,
                           old_value, new_value, changed_by, reason)
    values (tg_table_name, old.id, '__delete__',
            to_jsonb(old), null, v_changer, v_reason);
    return old;

  elsif tg_op = 'UPDATE' then
    v_old_row := to_jsonb(old);
    v_new_row := to_jsonb(new);
    for v_key in select jsonb_object_keys(v_new_row) loop
      if v_key in ('updated_at', 'updated_by') then continue; end if;
      if v_old_row->v_key is distinct from v_new_row->v_key then
        insert into change_log(target_table, target_id, field_name,
                               old_value, new_value, changed_by, reason)
        values (tg_table_name, new.id, v_key,
                v_old_row->v_key, v_new_row->v_key, v_changer, v_reason);
      end if;
    end loop;
    return new;
  end if;
  return null;
end;
$$;

-- Apply to: roster (staff), AY structure (academic_years, aye_grade_sections,
-- enrollment_monthly), and budget-adjacent modules.
create trigger staff_change_log
  after insert or update or delete on staff
  for each row execute function tg_log_changes();

create trigger academic_years_change_log
  after insert or update or delete on academic_years
  for each row execute function tg_log_changes();

create trigger aye_grade_sections_change_log
  after insert or update or delete on aye_grade_sections
  for each row execute function tg_log_changes();

create trigger enrollment_monthly_change_log
  after insert or update or delete on enrollment_monthly
  for each row execute function tg_log_changes();

create trigger tuition_worksheet_change_log
  after insert or update or delete on tuition_worksheet
  for each row execute function tg_log_changes();

create trigger tuition_scenarios_change_log
  after insert or update or delete on tuition_scenarios
  for each row execute function tg_log_changes();

create trigger staffing_scenarios_change_log
  after insert or update or delete on staffing_scenarios
  for each row execute function tg_log_changes();

create trigger staffing_scenario_positions_change_log
  after insert or update or delete on staffing_scenario_positions
  for each row execute function tg_log_changes();

create trigger preliminary_budget_change_log
  after insert or update or delete on preliminary_budget
  for each row execute function tg_log_changes();

create trigger final_budget_change_log
  after insert or update or delete on final_budget
  for each row execute function tg_log_changes();

create trigger enrollment_audit_families_change_log
  after insert or update or delete on enrollment_audit_families
  for each row execute function tg_log_changes();

create trigger enrollment_audit_summary_change_log
  after insert or update or delete on enrollment_audit_summary
  for each row execute function tg_log_changes();

-- ============================================================================
-- 12. ROW-LEVEL SECURITY
-- ============================================================================

-- ---- foundation ------------------------------------------------------------
alter table academic_years enable row level security;

create policy academic_years_read on academic_years
  for select to authenticated using (true);
create policy academic_years_write on academic_years
  for all to authenticated
  using (is_system_admin())
  with check (is_system_admin());

alter table user_profiles enable row level security;

create policy user_profiles_read on user_profiles
  for select to authenticated
  using (id = auth.uid() or is_system_admin());
create policy user_profiles_update_own on user_profiles
  for update to authenticated
  using (id = auth.uid() or is_system_admin())
  with check (id = auth.uid() or is_system_admin());
create policy user_profiles_admin_insert on user_profiles
  for insert to authenticated
  with check (is_system_admin() or id = auth.uid());

alter table staff enable row level security;

create policy staff_read on staff
  for select to authenticated using (true);
create policy staff_write on staff
  for all to authenticated
  using (current_user_has_module_perm('staffing', 'edit'))
  with check (current_user_has_module_perm('staffing', 'edit'));

-- ---- module registry + permissions ----------------------------------------
alter table modules enable row level security;

create policy modules_read on modules
  for select to authenticated using (true);
-- intentionally no write policy: modules are seed data, no app writes

alter table user_module_permissions enable row level security;

create policy ump_read on user_module_permissions
  for select to authenticated
  using (user_id = auth.uid() or is_system_admin());
create policy ump_admin_write on user_module_permissions
  for all to authenticated
  using (is_system_admin())
  with check (is_system_admin());

-- ---- module instances + transitions ---------------------------------------
alter table module_instances enable row level security;

create policy mi_read on module_instances
  for select to authenticated using (true);
-- writes happen via transition_module_state(); also allow direct UPDATE
-- by users with submit_lock or higher (validate trigger enforces correctness)
create policy mi_insert on module_instances
  for insert to authenticated
  with check (
    is_system_admin() or exists (
      select 1 from modules m
       where m.id = module_id
         and current_user_has_module_perm(m.code, 'edit')
    )
  );
create policy mi_update on module_instances
  for update to authenticated
  using (
    is_system_admin() or exists (
      select 1 from modules m
       where m.id = module_id
         and current_user_has_module_perm(m.code, 'submit_lock')
    )
  )
  with check (
    is_system_admin() or exists (
      select 1 from modules m
       where m.id = module_id
         and current_user_has_module_perm(m.code, 'submit_lock')
    )
  );

alter table module_state_transitions enable row level security;

create policy mst_read on module_state_transitions
  for select to authenticated using (true);
-- inserts happen via transition_module_state() (security definer); no
-- direct insert policy needed for normal app flow.

-- ---- enrollment estimator --------------------------------------------------
alter table aye_grade_sections enable row level security;

create policy ags_read on aye_grade_sections
  for select to authenticated
  using (current_user_has_module_perm('enrollment_estimator', 'view'));
create policy ags_write on aye_grade_sections
  for all to authenticated
  using (current_user_has_module_perm('enrollment_estimator', 'edit'))
  with check (current_user_has_module_perm('enrollment_estimator', 'edit'));

alter table enrollment_monthly enable row level security;

create policy em_read on enrollment_monthly
  for select to authenticated
  using (current_user_has_module_perm('enrollment_estimator', 'view'));
create policy em_write on enrollment_monthly
  for all to authenticated
  using (current_user_has_module_perm('enrollment_estimator', 'edit'))
  with check (current_user_has_module_perm('enrollment_estimator', 'edit'));

-- ---- tuition ---------------------------------------------------------------
alter table tuition_worksheet enable row level security;

create policy tw_read on tuition_worksheet
  for select to authenticated
  using (current_user_has_module_perm('tuition_worksheet', 'view'));
create policy tw_write on tuition_worksheet
  for all to authenticated
  using (current_user_has_module_perm('tuition_worksheet', 'edit'))
  with check (current_user_has_module_perm('tuition_worksheet', 'edit'));

alter table tuition_scenarios enable row level security;

create policy ts_read on tuition_scenarios
  for select to authenticated
  using (current_user_has_module_perm('tuition_worksheet', 'view'));
create policy ts_write on tuition_scenarios
  for all to authenticated
  using (current_user_has_module_perm('tuition_worksheet', 'edit'))
  with check (current_user_has_module_perm('tuition_worksheet', 'edit'));

-- ---- staffing --------------------------------------------------------------
alter table staffing_scenarios enable row level security;

create policy ss_read on staffing_scenarios
  for select to authenticated
  using (current_user_has_module_perm('staffing', 'view'));
create policy ss_write on staffing_scenarios
  for all to authenticated
  using (current_user_has_module_perm('staffing', 'edit'))
  with check (current_user_has_module_perm('staffing', 'edit'));

alter table staffing_scenario_positions enable row level security;

create policy ssp_read on staffing_scenario_positions
  for select to authenticated
  using (current_user_has_module_perm('staffing', 'view'));
create policy ssp_write on staffing_scenario_positions
  for all to authenticated
  using (current_user_has_module_perm('staffing', 'edit'))
  with check (current_user_has_module_perm('staffing', 'edit'));

-- ---- budgets ---------------------------------------------------------------
alter table preliminary_budget enable row level security;

create policy pb_read on preliminary_budget
  for select to authenticated
  using (current_user_has_module_perm('preliminary_budget', 'view'));
create policy pb_write on preliminary_budget
  for all to authenticated
  using (current_user_has_module_perm('preliminary_budget', 'edit'))
  with check (current_user_has_module_perm('preliminary_budget', 'edit'));

alter table final_budget enable row level security;

create policy fb_read on final_budget
  for select to authenticated
  using (current_user_has_module_perm('final_budget', 'view'));
create policy fb_write on final_budget
  for all to authenticated
  using (current_user_has_module_perm('final_budget', 'edit'))
  with check (current_user_has_module_perm('final_budget', 'edit'));

-- ---- enrollment audit ------------------------------------------------------
-- Family-level requires BOTH the module view perm AND can_view_family_details
alter table enrollment_audit_families enable row level security;

create policy eaf_read on enrollment_audit_families
  for select to authenticated
  using (
    current_user_has_module_perm('enrollment_audit', 'view')
    and can_view_family_details(auth.uid())
  );
create policy eaf_write on enrollment_audit_families
  for all to authenticated
  using (
    current_user_has_module_perm('enrollment_audit', 'edit')
    and can_view_family_details(auth.uid())
  )
  with check (
    current_user_has_module_perm('enrollment_audit', 'edit')
    and can_view_family_details(auth.uid())
  );

-- Summary table: standard module perm only; no family-level requirement
alter table enrollment_audit_summary enable row level security;

create policy eas_read on enrollment_audit_summary
  for select to authenticated
  using (current_user_has_module_perm('enrollment_audit', 'view'));
create policy eas_write on enrollment_audit_summary
  for all to authenticated
  using (current_user_has_module_perm('enrollment_audit', 'edit'))
  with check (current_user_has_module_perm('enrollment_audit', 'edit'));

-- ---- change log ------------------------------------------------------------
-- Read access keyed off the module the change relates to
alter table change_log enable row level security;

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
      else false
    end
  );
-- no write policy: change_log is only written by SECURITY DEFINER triggers

-- ============================================================================
-- 13. GRANTS (Supabase exposes "authenticated" + "anon" roles via PostgREST)
-- ============================================================================

grant usage on schema public to authenticated, anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on modules to anon;       -- module list could be public if needed
grant execute on all functions in schema public to authenticated;

-- ============================================================================
-- END OF MIGRATION 001
-- ============================================================================
-- Next migrations will likely add: governance + operations module tables,
-- views for board-meeting reporting, seeded permission grants for known users.
-- ============================================================================
