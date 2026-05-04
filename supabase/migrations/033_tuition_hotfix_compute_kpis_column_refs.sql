-- ============================================================================
-- Migration 033: Tuition compute_tuition_scenario_kpis hotfix (v3.8.11)
--
-- Lock workflow on Tuition Stage 1 fails at Approve-and-lock with:
--   ERROR:  record "v_scenario" has no field "other_discount_envelope"
--
-- Root cause: Migration 032 (Tuition-D, v3.8.10) extended compute_tuition_
-- scenario_kpis to compute the two new decision KPIs (breakeven_enrollment,
-- net_education_program_ratio) and corrected the Stage 1 B&A revenue
-- projection. The rewritten body was based on Migration 024's pre-B1.1
-- definition rather than Migration 027's current definition — so three
-- Migration 027 Stage 1 changes were inadvertently reverted:
--
--   1. Column renames (the explicit runtime failure):
--        other_discount_envelope  → projected_other_discount
--        financial_aid_envelope   → projected_financial_aid
--      PL/pgSQL doesn't validate field references against record-typed
--      row variables until runtime, so the function compiled fine but
--      raised the error above the first time lock_tuition_scenario
--      invoked it against a real scenario.
--
--   2. Stage 1 total_students should read from the column directly
--      (`v_scenario.total_students`) per Migration 027. Migration 032
--      regressed to walking the jsonb to sum (tier_size × family_count).
--      The two are equivalent when the application save path keeps the
--      jsonb's family_count values in sync with total_students ×
--      breakdown_pct (which it does in production), but the column read
--      is the canonical Migration 027 design and avoids any drift risk.
--
--   3. Stage 1 faculty discount should read projected_faculty_discount_
--      amount directly per Migration 027 — a deliberate user $ projection
--      set on the scenario row. Migration 032 regressed to computing
--      `faculty_discount_pct / 100 × gross`, which produces a wildly
--      different number from what the sidebar (tuitionMath.js) shows.
--      That divergence would defeat the snapshot-matches-sidebar
--      acceptance criterion that v3.8.10's lock workflow was designed
--      to satisfy.
--
-- Scope expansion note: the user's hotfix prompt called out items (1)
-- as the explicit fix and gave permission to clean up "any other
-- Migration 027 renames that may have been carried forward stale."
-- Items (2) and (3) are technically logic regressions from Migration
-- 027, not pure column renames — but they MUST be restored to make
-- the snapshot KPIs match the client-side sidebar within rounding
-- tolerance (one of v3.8.10's stated acceptance criteria, finally
-- exercisable post-fix). They are documented here as part of the
-- hotfix scope rather than deferred to a follow-up.
--
-- Preserved from Migration 032 (NOT reverted):
--   - The Stage 1 B&A revenue projection using
--     `projected_b_a_hours × hourly_rate` — Migration 032's intentional
--     improvement matching the client-side computation. Migration 027
--     hardcoded `v_ba_revenue := 0` for Stage 1 because Migration 028
--     hadn't yet introduced the projected_b_a_hours column; that's no
--     longer the right behavior. Server-side B&A revenue should match
--     what the sidebar shows.
--   - The net_education_program_ratio + breakeven_enrollment
--     computations introduced by Migration 032 — they are the new
--     decision KPIs, not affected by the regression.
--   - The OUT parameter list (11 columns; same as Migration 032). No
--     DROP FUNCTION needed — CREATE OR REPLACE works because the
--     return shape is unchanged from the immediately-prior version.
--
-- This is a bug fix. No schema changes, no new RPCs, no version bump
-- of the snapshot table. Single CREATE OR REPLACE FUNCTION.
-- ============================================================================

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
  net_education_program_revenue  numeric,
  net_education_program_ratio    numeric,
  breakeven_enrollment           int
)
language plpgsql stable
set search_path = public
as $$
declare
  v_scenario        record;
  v_stage_type      text;
  v_tier_1_rate     numeric := 0;
  v_total_students  int := 0;
  -- Aggregates
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
  v_net_revenue     numeric;
  -- v3.8.10 (Tuition-D) decision KPIs
  v_comparator      numeric;
  v_blended_avg     numeric;
  v_per_stu_fees    numeric;
  v_ba_per_student  numeric;
  v_fixed_envelopes numeric;
  v_denom           numeric;
  v_ratio           numeric;
  v_breakeven       int;
begin
  select * into v_scenario from tuition_worksheet_scenarios where id = p_scenario_id;
  if v_scenario is null then
    raise exception 'Scenario % not found for KPI computation', p_scenario_id;
  end if;

  select stage_type into v_stage_type
    from module_workflow_stages where id = v_scenario.stage_id;

  -- Tier 1 (single-student) rate from tier_rates jsonb.
  select coalesce(
    (select (item->>'per_student_rate')::numeric
       from jsonb_array_elements(v_scenario.tier_rates) item
      where (item->>'tier_size')::int = 1
      limit 1),
    0
  ) into v_tier_1_rate;

  if v_stage_type = 'final' then
    -- ----- Stage 2: walk family_details rows (unchanged from M027/M032) ----
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
    -- ----- Stage 1: read total_students from column (restored M027) -------
    --
    -- Direct column read — matches src/lib/tuitionMath.js's
    -- computeProjectedGrossAtTier1 which reads scenario.total_students.
    -- The application save path keeps the jsonb's family_count values
    -- in sync with this column; the multi-student discount loop below
    -- still walks the jsonb to compute per-tier rate differences.
    v_total_students := coalesce(v_scenario.total_students, 0);
    v_gross := v_total_students * v_tier_1_rate;

    -- Multi-student discount: walk the distribution to compute the
    -- difference per tier. Mirrors tuitionMath.computeTierBlendedTuition's
    -- per-tier walk; the discount is gross − tier-blended-tuition.
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

    -- Stage 1 discount projections — read from explicit $ columns
    -- (restored M027). The Migration 027 architectural decision: faculty
    -- is no longer an approximation (pct × gross); the user's
    -- projected_faculty_discount_amount is their deliberate $ estimate.
    -- Other and FA always read from explicit columns.
    v_faculty_disc := coalesce(v_scenario.projected_faculty_discount_amount, 0);
    v_other_disc   := coalesce(v_scenario.projected_other_discount, 0);
    v_fa_total     := coalesce(v_scenario.projected_financial_aid, 0);

    v_curr_fee   := v_total_students * v_scenario.curriculum_fee_per_student;
    v_enroll_fee := v_total_students * v_scenario.enrollment_fee_per_student;

    -- Stage 1 B&A revenue projection (preserved from Migration 032):
    -- projected_b_a_hours × hourly_rate. Migration 027 hardcoded 0 here
    -- because projected_b_a_hours had not yet been added (Migration 028);
    -- v3.8.10 corrected this so server-side matches what the sidebar
    -- shows via tuitionMath.computeProjectedBARevenue.
    v_ba_revenue := coalesce(v_scenario.projected_b_a_hours, 0)
                    * v_scenario.before_after_school_hourly_rate;
  end if;

  -- Net Education Program Revenue — same shape across both stages.
  v_net_revenue := (v_gross - v_multi_disc - v_faculty_disc - v_other_disc - v_fa_total)
                   + v_curr_fee + v_enroll_fee + v_ba_revenue;

  -- ----- v3.8.10 (Tuition-D) decision KPIs ---------------------------------
  --
  -- Both depend on expense_comparator_amount on the scenario row. NULL
  -- comparator → both KPIs NULL (Stage 1 may legitimately be locked
  -- without a comparator selected; the snapshot honestly records the
  -- absence rather than fabricating a value).
  v_comparator := v_scenario.expense_comparator_amount;

  if v_comparator is null or v_comparator <= 0 then
    v_ratio := null;
    v_breakeven := null;
  else
    v_ratio := v_net_revenue / v_comparator;

    if v_total_students is null or v_total_students <= 0 then
      v_breakeven := null;
    else
      -- Blended average per-student rate = tier-blended tuition / N.
      -- Equivalent to (gross − multi_student_discount) / N.
      v_blended_avg := (v_gross - v_multi_disc) / v_total_students;

      v_per_stu_fees := coalesce(v_scenario.curriculum_fee_per_student, 0)
                        + coalesce(v_scenario.enrollment_fee_per_student, 0);

      v_ba_per_student := v_ba_revenue / v_total_students;

      v_denom := v_blended_avg + v_per_stu_fees + v_ba_per_student;

      if v_denom <= 0 then
        v_breakeven := null;
      else
        v_fixed_envelopes := coalesce(v_faculty_disc, 0)
                             + coalesce(v_other_disc, 0)
                             + coalesce(v_fa_total, 0);
        v_breakeven := ceil((v_comparator + v_fixed_envelopes) / v_denom)::int;
      end if;
    end if;
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
    v_net_revenue,
    v_ratio,
    v_breakeven;
end;
$$;

grant execute on function compute_tuition_scenario_kpis(uuid) to authenticated;


-- ---- PostgREST schema cache reload ---------------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 033
-- ============================================================================
