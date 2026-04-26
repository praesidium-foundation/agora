-- ============================================================================
-- Migration 003: Fix tuition target ratio (1.02, not 1.20)
--
-- The original tg_compute_tuition_scenario_totals() trigger calculated
-- gap_to_target using a 1:1.20 target ratio. Per the business rule, the
-- target is 1:1.02 (Ed Program $ should be 102% of projected expenses —
-- just 2% above breakeven, NOT 120%). The 1.20 in 001 was a typo.
--
-- This migration:
--   1. Replaces the trigger function with the corrected formula.
--   2. Forces a recompute on every existing tuition_scenarios row so
--      gap_to_target values reflect the new rule. (A no-op UPDATE still
--      fires the BEFORE UPDATE trigger.)
-- ============================================================================

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

  -- 1:1.02 target ratio (Ed Program $ should be 102% of expenses —
  -- 2% above breakeven, NOT 120%).
  new.gap_to_target       := (new.projected_expenses * 1.02) - v_ed_dollars;
  new.fundraising_needed  := greatest(0, new.projected_expenses - v_ed_dollars);

  new.updated_at := now();
  return new;
end;
$$;

-- Recompute existing rows so their gap_to_target matches the new rule.
-- The BEFORE UPDATE trigger fires regardless of whether values change.
update tuition_scenarios set proposed_rate = proposed_rate;
