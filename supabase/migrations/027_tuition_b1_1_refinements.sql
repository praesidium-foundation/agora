-- ============================================================================
-- Migration 027: Tuition B1.1 schema refinements
--
-- Real-data design discovery during Tuition-B1 walkthrough surfaced six
-- refinements that touch schema. v3.8.2 (Tuition-B1.1) lands them.
--
-- Scope:
--   1. New columns on tuition_worksheet_scenarios:
--        total_students                       int (Stage 1 enrollment projection)
--        top_tier_avg_students_per_family     numeric(4,2) (refines top-tier
--                                              "X+ students" bucket projection)
--        projected_faculty_discount_amount    numeric(12,2) NOT NULL DEFAULT 0
--                                              (Stage 1 $ projection; the
--                                              existing faculty_discount_pct
--                                              column STAYS — needed for
--                                              Stage 2 per-family math)
--        total_families                       int (derived from total_students
--                                              ÷ weighted_avg, but stored so
--                                              user overrides persist)
--
--   2. Reshape estimated_family_distribution jsonb on scenarios:
--        old: [{tier_size, family_count}]
--        new: [{tier_size, breakdown_pct, family_count}]
--      family_count is no longer user-entered through the table; it is
--      computed application-side from total_families × breakdown_pct/100
--      and written to the jsonb so downstream reads (snapshots, future
--      KPIs) work without recomputation.
--
--   3. Renames on scenarios + snapshots:
--        other_discount_envelope  → projected_other_discount
--        financial_aid_envelope   → projected_financial_aid
--
--   4. Mirror all of the above on tuition_worksheet_snapshots (no
--      production rows — this is mechanical; new columns added with
--      sensible defaults so existing INSERT paths in the lock RPC do
--      not fail).
--
--   5. Validator triggers on scenarios:
--        - When total_students IS NOT NULL AND breakdown_pct sum > 0,
--          breakdown_pct values sum to 100 ± 0.01.
--          (Relaxed from spec's strict "when total_students is set"
--          to "when both total_students and breakdowns are non-trivial"
--          so on-blur saves do not fight users mid-data-entry. The UI
--          surfaces "Breakdown sum: X% (must total 100%)" while the
--          user fills in the breakdown; the DB enforces strict equality
--          once both sides exist. Application validator (Tuition-D)
--          will tighten to spec's strict semantics if needed.)
--        - When top_tier_avg_students_per_family IS NOT NULL, it must
--          be ≥ the maximum tier_size in tier_rates.
--
--   6. Update three SECURITY DEFINER functions to reference renamed
--      columns and new fields:
--        - compute_tuition_scenario_kpis (Migration 024) — Stage 1
--          branch reads total_students from column instead of walking
--          family_count; faculty discount projection reads
--          projected_faculty_discount_amount column directly (instead
--          of computing pct × gross).
--        - lock_tuition_scenario (Migration 024) — INSERT into
--          snapshots references new column names.
--        - create_tuition_scenario_from_snapshot (Migration 026) —
--          SELECT from snapshot references new column names; INSERT
--          into scenarios writes new column names.
--
--   7. Backfill: existing B1-walkthrough scenarios populate
--      total_families and total_students from current jsonb;
--      breakdown_pct values written from family_count ratios.
--      Snapshots have no production rows — backfill noop there.
--
-- Architecture references: §7.3 (rewritten in v3.8.2), §10.4 (in-app
-- four-tier hierarchy — visual treatment of the new Discount column).
-- ============================================================================


-- ---- 1. Add new columns to scenarios -------------------------------------
--
-- All four columns added in one ALTER TABLE so the table-level lock is
-- held briefly. projected_faculty_discount_amount is NOT NULL with a 0
-- default so existing rows backfill cleanly without per-row UPDATE.

alter table tuition_worksheet_scenarios
  add column total_students                    int,
  add column top_tier_avg_students_per_family  numeric(4,2),
  add column projected_faculty_discount_amount numeric(12,2) not null default 0,
  add column total_families                    int;


-- ---- 2. Rename columns on scenarios --------------------------------------
--
-- ALTER TABLE RENAME COLUMN is metadata-only (instant). No FKs, indexes,
-- or constraints reference these columns by name from outside the table
-- (the immutability trigger only references columns by NEW.<name> via
-- field-by-field IS DISTINCT FROM checks; tier_rates / faculty_discount_pct
-- / etc. — none of those involve the two renamed columns).

alter table tuition_worksheet_scenarios
  rename column other_discount_envelope to projected_other_discount;
alter table tuition_worksheet_scenarios
  rename column financial_aid_envelope to projected_financial_aid;


-- ---- 3. Backfill scenarios -----------------------------------------------
--
-- Per-row reshape:
--   - Read existing estimated_family_distribution rows (each having
--     {tier_size, family_count}).
--   - Compute total_families = Σ family_count.
--   - Compute total_students = Σ (tier_size × family_count). Top-tier
--     "4+" treated as exactly 4 (one-time migration drift acceptable
--     per spec — no production data).
--   - For each existing row: write breakdown_pct = round(family_count
--     / total_families × 100, 2); preserve family_count.
--   - When total_families = 0 (fresh-state scenario from B1 empty-state
--     path: every family_count is 0), write breakdown_pct = 0 for all
--     rows; leave total_families and total_students NULL so the new
--     UI's "fresh scenario" semantics carry through.
--
-- Runs before the validator triggers are installed so it cannot trip
-- on partial states.

do $$
declare
  r record;
  v_total_families int;
  v_total_students int;
  v_new_dist jsonb;
  v_dist_item jsonb;
  v_pct numeric;
  v_tier_size int;
  v_family_count int;
begin
  for r in select id, estimated_family_distribution from tuition_worksheet_scenarios loop
    v_total_families := 0;
    v_total_students := 0;
    v_new_dist := '[]'::jsonb;

    if r.estimated_family_distribution is not null
       and jsonb_typeof(r.estimated_family_distribution) = 'array'
       and jsonb_array_length(r.estimated_family_distribution) > 0 then
      -- Pass 1: compute totals
      for v_dist_item in select value from jsonb_array_elements(r.estimated_family_distribution) loop
        v_tier_size    := coalesce((v_dist_item->>'tier_size')::int, 0);
        v_family_count := coalesce((v_dist_item->>'family_count')::int, 0);
        v_total_families := v_total_families + v_family_count;
        v_total_students := v_total_students + (v_tier_size * v_family_count);
      end loop;

      -- Pass 2: build reshaped jsonb
      for v_dist_item in select value from jsonb_array_elements(r.estimated_family_distribution) loop
        v_tier_size    := coalesce((v_dist_item->>'tier_size')::int, 0);
        v_family_count := coalesce((v_dist_item->>'family_count')::int, 0);
        if v_total_families > 0 then
          v_pct := round((v_family_count::numeric / v_total_families::numeric) * 100, 2);
        else
          v_pct := 0;
        end if;
        v_new_dist := v_new_dist || jsonb_build_array(jsonb_build_object(
          'tier_size',     v_tier_size,
          'breakdown_pct', v_pct,
          'family_count',  v_family_count
        ));
      end loop;
    end if;

    -- "Fresh" scenarios: leave totals NULL so the UI knows the user
    -- has not yet entered a projection. "Real data" scenarios with
    -- non-zero counts: store the totals.
    update tuition_worksheet_scenarios
       set estimated_family_distribution = v_new_dist,
           total_families = case when v_total_families > 0 then v_total_families else null end,
           total_students = case when v_total_students > 0 then v_total_students else null end
     where id = r.id;
  end loop;
end $$;


-- ---- 4. Mirror changes on snapshots --------------------------------------
--
-- No production snapshot rows exist (B1 did not ship the lock workflow
-- yet — Tuition-D adds the snapshot capture path). Schema-only.

alter table tuition_worksheet_snapshots
  add column total_students                    int,
  add column top_tier_avg_students_per_family  numeric(4,2),
  add column projected_faculty_discount_amount numeric(12,2) not null default 0,
  add column total_families                    int;

alter table tuition_worksheet_snapshots
  rename column other_discount_envelope to projected_other_discount;
alter table tuition_worksheet_snapshots
  rename column financial_aid_envelope to projected_financial_aid;


-- ---- 5. Validator trigger ------------------------------------------------

create or replace function tg_validate_tuition_scenario()
returns trigger language plpgsql as $$
declare
  v_breakdown_sum numeric := 0;
  v_top_tier_size int;
  v_item jsonb;
begin
  -- Validator 1: breakdown_pct values sum to 100 ± 0.01 when both
  -- total_students AND breakdown sum are non-trivial. Relaxed from
  -- "when total_students is set" so on-blur edits do not block
  -- mid-entry states (user enters total_students before breakdowns,
  -- or vice versa). The UI's "Breakdown sum: X%" indicator drives
  -- visible feedback; the DB enforces strict equality once both
  -- sides exist. Application validator (Tuition-D) tightens further
  -- when the lock workflow needs strict-at-submit semantics.
  if NEW.total_students is not null
     and NEW.estimated_family_distribution is not null
     and jsonb_typeof(NEW.estimated_family_distribution) = 'array' then
    for v_item in select value from jsonb_array_elements(NEW.estimated_family_distribution) loop
      v_breakdown_sum := v_breakdown_sum + coalesce((v_item->>'breakdown_pct')::numeric, 0);
    end loop;
    if v_breakdown_sum > 0 and abs(v_breakdown_sum - 100.0) > 0.01 then
      raise exception
        'Breakdown percentages must sum to 100 (got %); adjust per-tier breakdown values to total 100%%.',
        v_breakdown_sum;
    end if;
  end if;

  -- Validator 2: top_tier_avg_students_per_family ≥ max tier_size in
  -- tier_rates when set. The "X+" framing of the top tier means a
  -- "4+" tier may include families with 4, 5, or more students; the
  -- average cannot be less than the bucket's lower bound.
  if NEW.top_tier_avg_students_per_family is not null
     and NEW.tier_rates is not null
     and jsonb_typeof(NEW.tier_rates) = 'array' then
    select max((value->>'tier_size')::int)
      into v_top_tier_size
      from jsonb_array_elements(NEW.tier_rates);
    if v_top_tier_size is not null
       and NEW.top_tier_avg_students_per_family < v_top_tier_size then
      raise exception
        'top_tier_avg_students_per_family (%) must be at least the top tier size (%).',
        NEW.top_tier_avg_students_per_family, v_top_tier_size;
    end if;
  end if;

  return NEW;
end;
$$;

create trigger tuition_worksheet_scenarios_validate
  before insert or update on tuition_worksheet_scenarios
  for each row execute function tg_validate_tuition_scenario();


-- ---- 6. compute_tuition_scenario_kpis — refresh for B1.1 ----------------
--
-- Stage 1 branch now reads total_students from the column directly
-- (rather than walking family_count × tier_size); faculty discount
-- projection reads projected_faculty_discount_amount column directly
-- (rather than computing pct × gross). Stage 2 branch unchanged in
-- shape — it walks family_details rows. Both branches reference the
-- renamed projected_other_discount / projected_financial_aid.
--
-- Return shape unchanged → CREATE OR REPLACE works.

create or replace function compute_tuition_scenario_kpis(p_scenario_id uuid)
returns table (
  gross_tuition_revenue          numeric,
  multi_student_discount_total   numeric,
  faculty_discount_total         numeric,
  other_discount_total           numeric,
  financial_aid_total            numeric,
  curriculum_fee_revenue         numeric,
  enrollment_fee_revenue         numeric,
  before_after_school_revenue    numeric,
  net_education_program_revenue  numeric
)
language plpgsql stable
set search_path = public
as $$
declare
  v_scenario        record;
  v_stage_type      text;
  v_tier_1_rate     numeric := 0;
  v_total_students  int := 0;
  v_total_families  int := 0;
  v_gross           numeric := 0;
  v_multi_disc      numeric := 0;
  v_faculty_disc    numeric := 0;
  v_other_disc      numeric := 0;
  v_fa_total        numeric := 0;
  v_curr_fee        numeric := 0;
  v_enroll_fee      numeric := 0;
  v_ba_revenue      numeric := 0;
  v_dist_item       jsonb;
  v_tier_size       int;
  v_family_count    int;
  v_per_student     numeric;
begin
  select * into v_scenario from tuition_worksheet_scenarios where id = p_scenario_id;
  if v_scenario is null then
    raise exception 'Scenario % not found for KPI computation', p_scenario_id;
  end if;

  select stage_type into v_stage_type
    from module_workflow_stages where id = v_scenario.stage_id;

  -- Tier 1 rate.
  select coalesce(
    (select (item->>'per_student_rate')::numeric
       from jsonb_array_elements(v_scenario.tier_rates) item
      where (item->>'tier_size')::int = 1
      limit 1),
    0
  ) into v_tier_1_rate;

  if v_stage_type = 'final' then
    -- ----- Stage 2: walk family_details rows --------------------------------
    select
      coalesce(sum(fd.students_enrolled * v_tier_1_rate), 0),
      coalesce(sum((v_tier_1_rate - fd.applied_tier_rate) * fd.students_enrolled), 0),
      coalesce(sum(fd.students_enrolled), 0),
      coalesce(sum(coalesce(fd.faculty_discount_amount, 0)), 0),
      coalesce(sum(coalesce(fd.other_discount_amount, 0)), 0),
      coalesce(sum(coalesce(fd.financial_aid_amount, 0)), 0)
      into v_gross, v_multi_disc, v_total_students,
           v_faculty_disc, v_other_disc, v_fa_total
      from tuition_worksheet_family_details fd
     where fd.scenario_id = p_scenario_id;

    v_curr_fee   := v_total_students * v_scenario.curriculum_fee_per_student;
    v_enroll_fee := v_total_students * v_scenario.enrollment_fee_per_student;
    v_ba_revenue := coalesce(v_scenario.actual_before_after_school_hours, 0)
                    * v_scenario.before_after_school_hourly_rate;

  else
    -- ----- Stage 1: read total_students from column ------------------------
    --
    -- Gross is the total-students-at-Tier-1-rate computation. Direct
    -- column read avoids drift between total_students and the
    -- family-distribution walk that B1 used.
    v_total_students := coalesce(v_scenario.total_students, 0);
    v_total_families := coalesce(v_scenario.total_families, 0);
    v_gross := v_total_students * v_tier_1_rate;

    -- Multi-student discount: walk the distribution to compute the
    -- difference per tier. family_count is stored in the jsonb (kept
    -- in sync application-side) so no recomputation needed here.
    if v_scenario.estimated_family_distribution is not null
       and jsonb_typeof(v_scenario.estimated_family_distribution) = 'array' then
      for v_dist_item in select value from jsonb_array_elements(v_scenario.estimated_family_distribution) loop
        v_tier_size    := coalesce((v_dist_item->>'tier_size')::int, 0);
        v_family_count := coalesce((v_dist_item->>'family_count')::int, 0);
        select coalesce(
          (select (item->>'per_student_rate')::numeric
             from jsonb_array_elements(v_scenario.tier_rates) item
            where (item->>'tier_size')::int = v_tier_size
            limit 1),
          v_tier_1_rate
        ) into v_per_student;
        v_multi_disc := v_multi_disc
                        + ((v_tier_1_rate - v_per_student) * v_tier_size * v_family_count);
      end loop;
    end if;

    -- B1.1: Stage 1 projections read from explicit $ columns. The
    -- old "pct × gross" approximation is gone — projected_faculty_
    -- discount_amount is the user's deliberate $ projection.
    v_faculty_disc := v_scenario.projected_faculty_discount_amount;
    v_other_disc   := v_scenario.projected_other_discount;
    v_fa_total     := v_scenario.projected_financial_aid;

    v_curr_fee   := v_total_students * v_scenario.curriculum_fee_per_student;
    v_enroll_fee := v_total_students * v_scenario.enrollment_fee_per_student;
    -- Stage 1 has no actual hours; B&A revenue not projected here.
    v_ba_revenue := 0;
  end if;

  return query select
    v_gross,
    v_multi_disc,
    v_faculty_disc,
    v_other_disc,
    v_fa_total,
    v_curr_fee,
    v_enroll_fee,
    v_ba_revenue,
    (v_gross - v_multi_disc - v_faculty_disc - v_other_disc - v_fa_total)
      + v_curr_fee + v_enroll_fee + v_ba_revenue;
end;
$$;

grant execute on function compute_tuition_scenario_kpis(uuid) to authenticated;


-- ---- 7. lock_tuition_scenario — refresh for B1.1 ------------------------
--
-- Snapshot INSERT must reference renamed columns + new fields. Return
-- type unchanged → CREATE OR REPLACE works.

create or replace function lock_tuition_scenario(
  p_scenario_id            uuid,
  p_locked_via             text default 'cascade',
  p_override_justification text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scenario     record;
  v_stage        record;
  v_aye          record;
  v_kpis         record;
  v_locker_name  text;
  v_snapshot_id  uuid;
  v_caller       uuid := auth.uid();
begin
  if not current_user_has_module_perm('tuition', 'approve_lock') then
    raise exception 'Approve-and-lock requires approve_lock permission on tuition.';
  end if;

  select * into v_scenario
    from tuition_worksheet_scenarios
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
  if p_locked_via not in ('cascade', 'override') then
    raise exception 'locked_via must be ''cascade'' or ''override''; got %', p_locked_via;
  end if;
  if p_locked_via = 'override' and (p_override_justification is null or length(trim(p_override_justification)) = 0) then
    raise exception 'Override requires a non-empty justification';
  end if;

  select s.display_name, s.short_name, s.stage_type
    into v_stage
    from module_workflow_stages s
   where s.id = v_scenario.stage_id;
  if v_stage is null then
    raise exception 'Stage % referenced by scenario % not found', v_scenario.stage_id, p_scenario_id;
  end if;

  select label into v_aye
    from academic_years where id = v_scenario.aye_id;
  if v_aye is null then
    raise exception 'AYE % referenced by scenario % not found', v_scenario.aye_id, p_scenario_id;
  end if;

  select coalesce(full_name, '')
    into v_locker_name
    from user_profiles where id = v_caller;
  if v_locker_name is null or length(v_locker_name) = 0 then
    v_locker_name := 'Unknown user';
  end if;

  select * into v_kpis from compute_tuition_scenario_kpis(p_scenario_id);

  insert into tuition_worksheet_snapshots (
    scenario_id, aye_id, aye_label_at_lock,
    stage_id, stage_display_name_at_lock, stage_short_name_at_lock, stage_type_at_lock,
    scenario_label_at_lock, scenario_description_at_lock,
    tier_count, tier_rates,
    faculty_discount_pct,
    projected_faculty_discount_amount,
    projected_other_discount, projected_financial_aid,
    curriculum_fee_per_student, enrollment_fee_per_student, before_after_school_hourly_rate,
    estimated_family_distribution,
    total_students, total_families, top_tier_avg_students_per_family,
    actual_before_after_school_hours,
    kpi_gross_tuition_revenue, kpi_multi_student_discount_total,
    kpi_faculty_discount_total, kpi_other_discount_total, kpi_financial_aid_total,
    kpi_curriculum_fee_revenue, kpi_enrollment_fee_revenue, kpi_before_after_school_revenue,
    kpi_net_education_program_revenue,
    locked_at, locked_by, locked_by_name_at_lock,
    locked_via, override_justification,
    approved_by, approved_by_name_at_lock, approved_at
  ) values (
    p_scenario_id, v_scenario.aye_id, v_aye.label,
    v_scenario.stage_id, v_stage.display_name, v_stage.short_name, v_stage.stage_type,
    v_scenario.scenario_label, v_scenario.description,
    v_scenario.tier_count, v_scenario.tier_rates,
    v_scenario.faculty_discount_pct,
    v_scenario.projected_faculty_discount_amount,
    v_scenario.projected_other_discount, v_scenario.projected_financial_aid,
    v_scenario.curriculum_fee_per_student, v_scenario.enrollment_fee_per_student, v_scenario.before_after_school_hourly_rate,
    v_scenario.estimated_family_distribution,
    v_scenario.total_students, v_scenario.total_families, v_scenario.top_tier_avg_students_per_family,
    v_scenario.actual_before_after_school_hours,
    v_kpis.gross_tuition_revenue, v_kpis.multi_student_discount_total,
    v_kpis.faculty_discount_total, v_kpis.other_discount_total, v_kpis.financial_aid_total,
    v_kpis.curriculum_fee_revenue, v_kpis.enrollment_fee_revenue, v_kpis.before_after_school_revenue,
    v_kpis.net_education_program_revenue,
    now(), v_caller, v_locker_name,
    p_locked_via,
    case when p_locked_via = 'override' then trim(p_override_justification) else null end,
    v_caller, v_locker_name, now()
  )
  returning id into v_snapshot_id;

  if v_stage.stage_type = 'final' then
    insert into tuition_worksheet_snapshot_family_details (
      snapshot_id, family_label, students_enrolled,
      applied_tier_size, applied_tier_rate,
      faculty_discount_amount, other_discount_amount, financial_aid_amount,
      notes, sort_order
    )
    select v_snapshot_id, fd.family_label, fd.students_enrolled,
           fd.applied_tier_size, fd.applied_tier_rate,
           fd.faculty_discount_amount, fd.other_discount_amount, fd.financial_aid_amount,
           fd.notes,
           row_number() over (order by fd.family_label, fd.id)
      from tuition_worksheet_family_details fd
     where fd.scenario_id = p_scenario_id;
  end if;

  update tuition_worksheet_scenarios
     set state                  = 'locked',
         locked_at              = now(),
         locked_by              = v_caller,
         locked_via             = p_locked_via,
         override_justification = case when p_locked_via = 'override' then trim(p_override_justification) else null end,
         updated_by             = v_caller
   where id = p_scenario_id;

  return v_snapshot_id;
end;
$$;

grant execute on function lock_tuition_scenario(uuid, text, text) to authenticated;


-- ---- 8. create_tuition_scenario_from_snapshot — refresh for B1.1 --------
--
-- Reads renamed snapshot columns and writes renamed scenario columns.
-- Also carries forward the new B1.1 fields (total_students,
-- total_families, top_tier_avg_students_per_family,
-- projected_faculty_discount_amount) — Stage 2 audit inherits the
-- Stage 1 projection as a starting reference before the user
-- overwrites with audit actuals.

create or replace function create_tuition_scenario_from_snapshot(
  p_target_stage_id    uuid,
  p_source_snapshot_id uuid,
  p_scenario_label     text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller       uuid := auth.uid();
  v_target_stage record;
  v_snapshot     record;
  v_source_stage record;
  v_new_scenario uuid;
begin
  if not current_user_has_module_perm('tuition', 'edit') then
    raise exception 'Creating a tuition scenario from a locked predecessor requires edit permission on tuition.';
  end if;

  if p_scenario_label is null or length(trim(p_scenario_label)) = 0 then
    raise exception 'Scenario label is required.';
  end if;

  select id, workflow_id, sort_order, stage_type
    into v_target_stage
    from module_workflow_stages
   where id = p_target_stage_id;
  if v_target_stage is null then
    raise exception 'Target stage % not found.', p_target_stage_id;
  end if;
  if v_target_stage.stage_type <> 'final' then
    raise exception
      'create_tuition_scenario_from_snapshot seeds Stage 2 (Tuition Audit) from Stage 1 (Tuition Planning). The target stage must have stage_type = ''final''; got %.',
      v_target_stage.stage_type;
  end if;

  select id, aye_id, stage_id, scenario_id, stage_type_at_lock,
         tier_count, tier_rates, faculty_discount_pct,
         projected_faculty_discount_amount,
         projected_other_discount, projected_financial_aid,
         curriculum_fee_per_student, enrollment_fee_per_student,
         before_after_school_hourly_rate,
         estimated_family_distribution,
         total_students, total_families, top_tier_avg_students_per_family
    into v_snapshot
    from tuition_worksheet_snapshots
   where id = p_source_snapshot_id;
  if v_snapshot is null then
    raise exception 'Source tuition snapshot % not found.', p_source_snapshot_id;
  end if;
  if v_snapshot.stage_type_at_lock <> 'preliminary' then
    raise exception
      'Source snapshot must be from a Stage 1 (Tuition Planning) lock; got stage_type_at_lock = %.',
      v_snapshot.stage_type_at_lock;
  end if;

  select id, workflow_id, sort_order
    into v_source_stage
    from module_workflow_stages
   where id = v_snapshot.stage_id;
  if v_source_stage is null then
    raise exception 'Source snapshot stage % no longer exists in any workflow.', v_snapshot.stage_id;
  end if;
  if v_source_stage.workflow_id <> v_target_stage.workflow_id then
    raise exception 'Source and target stages must belong to the same workflow.';
  end if;
  if v_source_stage.sort_order >= v_target_stage.sort_order then
    raise exception
      'Source stage (sort_order %) is not a predecessor of target stage (sort_order %).',
      v_source_stage.sort_order, v_target_stage.sort_order;
  end if;

  perform set_config(
    'app.change_reason',
    'created_from_snapshot: ' || p_source_snapshot_id::text,
    true
  );

  insert into tuition_worksheet_scenarios (
    aye_id, stage_id,
    scenario_label, description,
    is_recommended, state,
    tier_count, tier_rates,
    faculty_discount_pct,
    projected_faculty_discount_amount,
    curriculum_fee_per_student, enrollment_fee_per_student,
    before_after_school_hourly_rate,
    projected_other_discount, projected_financial_aid,
    estimated_family_distribution,
    total_students, total_families, top_tier_avg_students_per_family,
    created_by, updated_by
  )
  values (
    v_snapshot.aye_id,
    p_target_stage_id,
    trim(p_scenario_label),
    null,
    false,
    'drafting',
    v_snapshot.tier_count, v_snapshot.tier_rates,
    v_snapshot.faculty_discount_pct,
    v_snapshot.projected_faculty_discount_amount,
    v_snapshot.curriculum_fee_per_student, v_snapshot.enrollment_fee_per_student,
    v_snapshot.before_after_school_hourly_rate,
    v_snapshot.projected_other_discount, v_snapshot.projected_financial_aid,
    v_snapshot.estimated_family_distribution,
    v_snapshot.total_students, v_snapshot.total_families, v_snapshot.top_tier_avg_students_per_family,
    v_caller, v_caller
  )
  returning id into v_new_scenario;

  return v_new_scenario;
end;
$$;

grant execute on function create_tuition_scenario_from_snapshot(uuid, uuid, text) to authenticated;


-- ---- 9. PostgREST schema cache reload ------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 027
-- ============================================================================
