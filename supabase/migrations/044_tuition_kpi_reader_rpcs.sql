-- ============================================================================
-- Migration 044: Tuition KPI reader RPCs (v3.8.20)
--
-- Two read-only SECURITY DEFINER functions that Final Budget and
-- Preliminary Budget call to populate their cross-module KPIs.
-- Mirrors the Migration 030 pattern (`get_latest_locked_budget`)
-- for the consumer side of the cross-module data flow.
--
--   get_latest_locked_tuition_planning(p_aye_id)
--     Returns the locked Stage 1 (Tuition Planning) snapshot's
--     relevant fields for a given AYE. Read by both Preliminary and
--     Final Budget for "what we charge" data: base rate, total
--     students projection, breakeven enrollment, faculty %, fees.
--
--   get_tuition_audit_final_budget_reference_summary(p_aye_id)
--     Returns the operator-promoted Audit snapshot's aggregates for
--     a given AYE (the snapshot flagged is_final_budget_reference
--     per Migration 043). Read by Final Budget only for "what we
--     actually realized" data: actual enrollment, actual NET
--     tuition for year. Aggregates are computed from
--     tuition_worksheet_snapshot_family_details — the captured-
--     by-value source of truth per §5.1.
--
-- Both functions: SECURITY DEFINER, search_path = public, GRANT
-- EXECUTE TO authenticated. Both validate `tuition.view` before
-- returning data.
--
-- Both return zero rows when their precondition isn't met (no Stage
-- 1 lock for the AYE / no promoted reference snapshot). Consumers
-- handle empty as "Pending [upstream]" KPI subtitles in the
-- KpiSidebar.
-- ============================================================================


-- ---- 1. get_latest_locked_tuition_planning -------------------------------
--
-- Returns the most-recent locked Stage 1 snapshot for an AYE. There
-- should be at most one (Stage 1 lock workflow allows only one
-- locked snapshot per (AYE, stage) per Migration 022's partial
-- unique index), but the ORDER BY captured_at DESC is defensive
-- against any future schema variations.
--
-- The returned row includes:
--   snapshot_id              — the snapshot's primary key
--   base_rate                — Tier 1 (single-student) rate
--   total_students           — Stage 1 projected enrollment
--   total_families           — Stage 1 projected family count
--   breakeven_enrollment     — pre-computed at lock (Migration 032 KPI)
--   net_education_program_ratio — pre-computed at lock (M032 KPI)
--   faculty_discount_pct     — the rule percentage
--   curriculum_fee           — per-student curriculum fee
--   ba_hourly_rate           — before/after-school hourly rate
--   captured_at              — when the snapshot was taken (= locked_at)
--   scenario_label           — operator-facing label for the scenario
--   stage_display_name       — e.g. "Tuition Planning"

create or replace function get_latest_locked_tuition_planning(
  p_aye_id uuid
)
returns table (
  snapshot_id                  uuid,
  base_rate                    numeric,
  total_students               int,
  total_families               int,
  breakeven_enrollment         int,
  net_education_program_ratio  numeric,
  faculty_discount_pct         numeric,
  curriculum_fee               numeric,
  ba_hourly_rate               numeric,
  captured_at                  timestamptz,
  scenario_label               text,
  stage_display_name           text
)
language plpgsql stable
security definer
set search_path = public
as $$
begin
  if not current_user_has_module_perm('tuition', 'view') then
    raise exception 'Reading tuition data requires view permission on tuition.';
  end if;

  return query
    select
      s.id,
      coalesce(
        (select (item->>'per_student_rate')::numeric
           from jsonb_array_elements(s.tier_rates) item
          where (item->>'tier_size')::int = 1
          limit 1),
        0
      ),
      s.total_students,
      s.total_families,
      s.kpi_breakeven_enrollment,
      s.kpi_net_education_program_ratio,
      s.faculty_discount_pct,
      s.curriculum_fee_per_student,
      s.before_after_school_hourly_rate,
      coalesce(s.captured_at, s.locked_at),
      s.scenario_label_at_lock,
      s.stage_display_name_at_lock
      from tuition_worksheet_snapshots s
     where s.aye_id = p_aye_id
       and s.stage_type_at_lock = 'preliminary'
       and s.locked_at is not null
     order by coalesce(s.captured_at, s.locked_at) desc
     limit 1;
end;
$$;

grant execute on function get_latest_locked_tuition_planning(uuid) to authenticated;


-- ---- 2. get_tuition_audit_final_budget_reference_summary ----------------
--
-- Returns the operator-promoted Audit snapshot's aggregates. The
-- "Final Budget reference" — selected via mark_snapshot_as_final_
-- budget_reference (Migration 043) — anchors Final Budget's
-- enrollment-dependent KPIs (cost per student, breakeven, etc.).
-- Live Audit edits do NOT shift Final Budget KPIs; only re-promoting
-- a different snapshot does.
--
-- Aggregates:
--   total_students        — SUM(students_enrolled) across snapshot family rows
--   total_families        — COUNT(*) across snapshot family rows
--   net_tuition_for_year  — SUM of per-family NET tuition for the year:
--                            applied_tier_rate × students_enrolled
--                            − coalesce(faculty_discount_amount, 0)
--                            − coalesce(other_discount_amount,   0)
--                            − coalesce(financial_aid_amount,    0)
--
-- The math mirrors src/lib/tuitionMath.js's computeFamilyNetTuition
-- per the v3.8.10 round-trip equivalence pattern: client and server
-- compute the same number, and the snapshot is the source of truth
-- when both agree.
--
-- Returns zero rows when:
--   - No Stage 2 scenario exists for the AYE
--   - No snapshot has is_final_budget_reference = true for that scenario

create or replace function get_tuition_audit_final_budget_reference_summary(
  p_aye_id uuid
)
returns table (
  snapshot_id           uuid,
  snapshot_label        text,
  captured_at           timestamptz,
  total_students        int,
  total_families        int,
  net_tuition_for_year  numeric
)
language plpgsql stable
security definer
set search_path = public
as $$
begin
  if not current_user_has_module_perm('tuition', 'view') then
    raise exception 'Reading tuition data requires view permission on tuition.';
  end if;

  return query
    select
      s.id,
      s.snapshot_label,
      coalesce(s.captured_at, s.locked_at),
      coalesce(sum(fd.students_enrolled)::int, 0) as total_students,
      coalesce(count(fd.id)::int, 0)              as total_families,
      coalesce(sum(
        (fd.applied_tier_rate * fd.students_enrolled)
          - coalesce(fd.faculty_discount_amount, 0)
          - coalesce(fd.other_discount_amount,   0)
          - coalesce(fd.financial_aid_amount,    0)
      ), 0)::numeric                              as net_tuition_for_year
      from tuition_worksheet_snapshots s
      left join tuition_worksheet_snapshot_family_details fd
             on fd.snapshot_id = s.id
     where s.aye_id = p_aye_id
       and s.stage_type_at_lock = 'final'
       and s.is_final_budget_reference = true
     group by s.id, s.snapshot_label, s.captured_at, s.locked_at
     order by coalesce(s.captured_at, s.locked_at) desc
     limit 1;
end;
$$;

grant execute on function get_tuition_audit_final_budget_reference_summary(uuid) to authenticated;


-- ---- 3. PostgREST schema cache reload -----------------------------------

notify pgrst, 'reload schema';

-- ============================================================================
-- END OF MIGRATION 044
-- ============================================================================
