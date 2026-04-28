-- ============================================================================
-- Migration 010: Module workflows + stages (configurable workflow framework)
--
-- Replaces the previously-dropped Migration 010 (lock_preliminary_budget_
-- scenario), which baked a Libertas-shaped two-stage assumption into the
-- Budget module. Real-world testing surfaced that schools have varying
-- budget cadences (single-stage, two-stage, quarterly reforecasts, etc.).
-- The architectural correction generalizes the model: modules have
-- configurable workflows; workflows are made of stages; each stage can
-- be locked and snapshotted independently.
--
-- The hybrid taxonomy:
--   - Schools NAME and ORDER stages freely (display_name, short_name,
--     sort_order in module_workflow_stages).
--   - Each stage is TYPED from a curated set (stage_type_definitions.code
--     = 'preliminary' | 'adopted' | 'reforecast' | 'final' | …).
--   - Display names are school-specific. Types let Agora reason about
--     stages for KPI / reporting / cascade-rule purposes.
--
-- The catalog of stage types is curated by Praesidium. Schools choose
-- from the catalog but cannot add new types (a future migration would).
-- School-specific configuration lives in module_workflows and
-- module_workflow_stages.
--
-- The same pattern will apply to Strategic Plan and Accreditation when
-- those modules are built; this migration only sets up the framework
-- and seeds Libertas's Budget workflow. Migration 011 refactors the
-- Budget tables to reference stages; Migration 012 rewrites the lock
-- function against the new model.
-- ============================================================================

-- ---- 1. Stage type taxonomy (library table) ------------------------------

create table stage_type_definitions (
  code               text primary key,
  display_name       text not null,
  description        text not null,

  -- Coarse category for KPI / reporting logic. 'closing' types are
  -- terminal for the cycle; 'revision' types follow an 'approved' stage.
  semantic_category  text not null check (semantic_category in (
    'draft', 'approved', 'revision', 'closing'
  )),

  -- True when locking this stage closes out the cycle for the module
  -- (no further stages expected). UI may treat terminal stages
  -- differently (e.g., the "official" budget for board reports).
  is_terminal        boolean not null default false,

  sort_order         int not null default 0
);

insert into stage_type_definitions
  (code, display_name, description, semantic_category, is_terminal, sort_order)
values
  ('working',     'Working',
    'A draft stage in active development before any approval.',
    'draft',     false, 10),
  ('preliminary', 'Preliminary',
    'An early-cycle stage approved as a planning baseline, with revisions expected.',
    'approved',  false, 20),
  ('adopted',     'Adopted',
    'A formally adopted stage that becomes the operating baseline.',
    'approved',  false, 30),
  ('reforecast',  'Reforecast',
    'A mid-cycle revision of a previously adopted stage.',
    'revision',  false, 40),
  ('final',       'Final',
    'The closing stage for the cycle; once locked, the cycle is complete.',
    'closing',   true,  50);

-- Read-only for everyone signed in. Catalog is curated, not edited from
-- the app. Future migrations can add types; the app cannot.
alter table stage_type_definitions enable row level security;

create policy stage_type_definitions_read on stage_type_definitions
  for select to authenticated using (true);

-- No write policy — only superuser / migration scripts can modify.

-- ---- 2. Workflow definitions ---------------------------------------------

create table module_workflows (
  id           uuid primary key default gen_random_uuid(),
  module_id    uuid not null references modules(id),
  name         text not null,
  description  text,
  is_active    boolean not null default true,

  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id)
);

-- Single-tenant for now: at most one active workflow per module per school.
-- The partial unique index lets retired workflows linger (is_active=false)
-- without conflicting with the live one.
create unique index module_workflows_one_active_per_module
  on module_workflows (module_id)
  where is_active = true;

create trigger module_workflows_updated_at
  before update on module_workflows
  for each row execute function tg_set_updated_at();

create trigger module_workflows_change_log
  after insert or update or delete on module_workflows
  for each row execute function tg_log_changes();

-- ---- 3. Stage definitions within a workflow ------------------------------

create table module_workflow_stages (
  id            uuid primary key default gen_random_uuid(),
  workflow_id   uuid not null references module_workflows(id) on delete cascade,
  stage_type    text not null references stage_type_definitions(code),

  -- School-specific labeling. display_name is for the page title
  -- ("Preliminary Budget"); short_name for the sidebar ("Prelim. Budget").
  display_name  text not null,
  short_name    text not null,
  description   text,

  sort_order    int  not null,

  -- Optional metadata. target_month informs sidebar / dashboard
  -- "where in the year are we" affordances; null when not meaningful
  -- (e.g., reforecast stages that fire when needed, not on a calendar).
  target_month  int check (target_month is null or (target_month between 1 and 12)),

  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id)
);

create unique index workflow_stages_unique_display_name
  on module_workflow_stages (workflow_id, display_name);

create unique index workflow_stages_unique_sort_order
  on module_workflow_stages (workflow_id, sort_order);

-- A workflow MUST have at least one terminal stage (so the cycle can
-- end). Enforced at workflow-save time by application logic in the
-- future Settings UI; not encoded as a constraint here because the
-- check is across multiple rows.

create trigger workflow_stages_updated_at
  before update on module_workflow_stages
  for each row execute function tg_set_updated_at();

create trigger workflow_stages_change_log
  after insert or update or delete on module_workflow_stages
  for each row execute function tg_log_changes();

-- ---- 4. RLS --------------------------------------------------------------

alter table module_workflows       enable row level security;
alter table module_workflow_stages enable row level security;

-- Read: any signed-in user (workflow definitions are not confidential).
create policy module_workflows_read on module_workflows
  for select to authenticated using (true);

create policy workflow_stages_read on module_workflow_stages
  for select to authenticated using (true);

-- Write: system admin only. A dedicated 'workflow_config' module
-- permission can replace this when the Settings UI ships (Phase R2).
create policy module_workflows_admin on module_workflows
  for all to authenticated
  using (is_system_admin())
  with check (is_system_admin());

create policy workflow_stages_admin on module_workflow_stages
  for all to authenticated
  using (is_system_admin())
  with check (is_system_admin());

-- ---- 5. Helper: get workflow stages for a module by code -----------------

-- Single round-trip the UI uses to populate the sidebar and load stage
-- metadata. Returns the active workflow's stages in sort order, joined
-- against the type catalog so the caller knows which stage is terminal.
create or replace function get_module_workflow_stages(p_module_code text)
returns table (
  stage_id      uuid,
  stage_type    text,
  display_name  text,
  short_name    text,
  sort_order    int,
  target_month  int,
  is_terminal   boolean
)
language sql stable as $$
  select
    s.id,
    s.stage_type,
    s.display_name,
    s.short_name,
    s.sort_order,
    s.target_month,
    std.is_terminal
  from module_workflow_stages s
  join module_workflows w     on w.id = s.workflow_id
  join modules m              on m.id = w.module_id
  join stage_type_definitions std on std.code = s.stage_type
  where m.code = p_module_code
    and w.is_active = true
  order by s.sort_order;
$$;

grant execute on function get_module_workflow_stages(text) to authenticated;

-- ---- 6. Seed Libertas's Budget workflow ----------------------------------

-- The existing 'preliminary_budget' module is what we're seeding the
-- workflow against. Migration 011 renames the module code to 'budget'
-- (the workflow concept makes "Preliminary" a stage, not a module).
-- We seed against the current code here so this migration runs before
-- the rename in 011 — the workflow rows reference module_id, not code,
-- so the rename in 011 leaves them intact.
do $$
declare
  v_budget_module_id uuid;
  v_workflow_id      uuid;
begin
  select id into v_budget_module_id
    from modules
   where code = 'preliminary_budget';

  if v_budget_module_id is null then
    raise exception 'Module preliminary_budget not found; cannot seed workflow';
  end if;

  insert into module_workflows (module_id, name, description)
  values (
    v_budget_module_id,
    'Budget Workflow',
    'Libertas''s budget process: Preliminary baseline followed by Final adoption.'
  )
  returning id into v_workflow_id;

  insert into module_workflow_stages
    (workflow_id, stage_type, display_name, short_name, sort_order, target_month)
  values
    -- April per Libertas Annual Rhythm: Preliminary Budget.
    (v_workflow_id, 'preliminary', 'Preliminary Budget', 'Prelim. Budget', 1, 4),
    -- October per Libertas Annual Rhythm: Final Budget.
    (v_workflow_id, 'final',       'Final Budget',       'Final Budget',   2, 10);
end $$;

-- ---- 7. GRANTs (defensive — Migration 006 already covers via DEFAULT) ----

grant select, insert, update, delete on module_workflows       to authenticated;
grant select, insert, update, delete on module_workflow_stages to authenticated;
grant select                         on stage_type_definitions to authenticated;

-- ============================================================================
-- END OF MIGRATION 010
-- ============================================================================
