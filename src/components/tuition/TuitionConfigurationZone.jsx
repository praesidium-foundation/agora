import TierRatesSection from './TierRatesSection'
import FeesSection from './FeesSection'
import ProjectedDiscountsSection from './ProjectedDiscountsSection'
import FamilyDistributionSection from './FamilyDistributionSection'

// Configuration zone — the four Stage 1 (Tuition Planning) sections in
// fixed order. Mirrors BudgetDetailZone's role as the primary content
// area in the three-zone layout (architecture §8.1).
//
// All four sections render with Tier 1 headers (Cinzel 17px navy with
// gold border-bottom) per the four-tier hierarchy (architecture §10.4,
// in-app extension v3.6). Sub-content uses Tier 2 / Tier 3 weights as
// semantically appropriate.
//
// Read-only mode (parent passes readOnly = true when scenario state is
// not 'drafting' OR user lacks edit permission) cascades to every
// section.
//
// v3.8.2 (B1.1): four section refinements landed.
//   1. Tier Rates gained a Discount column + BASE badge.
//   2. "Per-student fees" → "Tuition fees" (the B&A Care line is hourly,
//      not per-student).
//   3. "Discount Envelopes" → "Projected Discounts" (component renamed
//      to ProjectedDiscountsSection.jsx); Faculty Discount row is now
//      a $ input (the configured % column persists in schema for
//      Stage 2 per-family math but does not render in Stage 1 UI).
//   4. Family Distribution full reframe — total_students + total_families
//      pair at top, breakdown_pct column, top-tier-avg-students input
//      below the table.
//
// Field saves flow up via per-field onChange callbacks. The parent
// page (TuitionWorksheet.jsx) owns the Supabase write + toast on
// failure. This zone is presentational; it holds no data state of
// its own.
//
// Props:
//   scenario              — the active scenario row (full object)
//   onUpdateField(field, value)
//                          — called for direct scalar field changes
//                            (curriculum/enrollment fees, B&A rate,
//                            three projected-discount $s, total_students,
//                            top_tier_avg_students_per_family). Field
//                            name matches the DB column.
//   onUpdateTierRates(rows)
//                          — tier_rates jsonb (also recomputes tier_count
//                            in the page handler).
//   onUpdateFamilyDistribution(rows, opts)
//                          — estimated_family_distribution jsonb. opts
//                            may include { recompute: true } to trigger
//                            re-derivation of family_count from current
//                            total_families.
//   onUpdateTotalFamilies(value, isOverride)
//                          — explicit override semantics.
//                            isOverride=true: store as user override.
//                            isOverride=false: clear override; persist
//                            the derived value (which may be null).
//   readOnly              — boolean

function TuitionConfigurationZone({
  scenario,
  onUpdateField,
  onUpdateTierRates,
  onUpdateFamilyDistribution,
  onUpdateTotalFamilies,
  readOnly = false,
}) {
  if (!scenario) return null

  const tierRates = Array.isArray(scenario.tier_rates) ? scenario.tier_rates : []
  const distribution = Array.isArray(scenario.estimated_family_distribution)
    ? scenario.estimated_family_distribution
    : []

  return (
    <div className="px-2 py-2">
      <TierRatesSection
        tierRates={tierRates}
        familyDistribution={distribution}
        onChangeTierRates={onUpdateTierRates}
        onChangeFamilyDistribution={onUpdateFamilyDistribution}
        readOnly={readOnly}
      />

      <FeesSection
        scenario={scenario}
        curriculumFee={scenario.curriculum_fee_per_student}
        enrollmentFee={scenario.enrollment_fee_per_student}
        beforeAfterSchoolHourlyRate={scenario.before_after_school_hourly_rate}
        projectedBAHours={scenario.projected_b_a_hours}
        onChangeCurriculumFee={(v) => onUpdateField('curriculum_fee_per_student', v)}
        onChangeEnrollmentFee={(v) => onUpdateField('enrollment_fee_per_student', v)}
        onChangeBeforeAfterSchoolHourlyRate={(v) => onUpdateField('before_after_school_hourly_rate', v)}
        onChangeProjectedBAHours={(v) => onUpdateField('projected_b_a_hours', v)}
        readOnly={readOnly}
      />

      <ProjectedDiscountsSection
        scenario={scenario}
        projectedFacultyDiscountAmount={scenario.projected_faculty_discount_amount}
        projectedOtherDiscount={scenario.projected_other_discount}
        projectedFinancialAid={scenario.projected_financial_aid}
        onChangeProjectedFacultyDiscountAmount={(v) => onUpdateField('projected_faculty_discount_amount', v)}
        onChangeProjectedOtherDiscount={(v) => onUpdateField('projected_other_discount', v)}
        onChangeProjectedFinancialAid={(v) => onUpdateField('projected_financial_aid', v)}
        readOnly={readOnly}
      />

      <FamilyDistributionSection
        distribution={distribution}
        tierRates={tierRates}
        totalStudents={scenario.total_students}
        totalFamilies={scenario.total_families}
        topTierAvgStudentsPerFamily={scenario.top_tier_avg_students_per_family}
        onChangeTotalStudents={(v) => onUpdateField('total_students', v)}
        onChangeTotalFamilies={onUpdateTotalFamilies}
        onChangeDistribution={onUpdateFamilyDistribution}
        onChangeTopTierAvgStudentsPerFamily={(v) => onUpdateField('top_tier_avg_students_per_family', v)}
        readOnly={readOnly}
      />

      {readOnly && scenario.state === 'locked' && (
        <div className="mt-4 px-4 py-3 bg-status-amber-bg border-[0.5px] border-status-amber/30 rounded text-status-amber text-sm">
          This scenario is locked. To edit, request unlock from the
          Treasurer.
        </div>
      )}
      {readOnly && scenario.state === 'pending_lock_review' && (
        <div className="mt-4 px-4 py-3 bg-status-blue-bg border-[0.5px] border-status-blue/25 rounded text-status-blue text-sm">
          This scenario is pending lock review. The configuration is
          read-only until approval or rejection.
        </div>
      )}
    </div>
  )
}

export default TuitionConfigurationZone
