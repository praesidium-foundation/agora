import TierRatesSection from './TierRatesSection'
import FeesSection from './FeesSection'
import DiscountEnvelopesSection from './DiscountEnvelopesSection'
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
// section: input chrome disappears; values render as plain text; the
// "+ Add tier" / "× remove" affordances vanish.
//
// Field saves flow up via per-field onChange callbacks. The parent
// page (TuitionWorksheet.jsx) owns the Supabase write + toast on
// failure. This zone is presentational; it holds no data state of
// its own (the section components hold per-row inline-edit drafts;
// committed values live in the parent's scenario object).
//
// Props:
//   scenario              — the active scenario row (full object). When
//                            null, this component is not rendered (the
//                            page renders TuitionEmptyState instead).
//   onUpdateField(field, value)
//                          — called when any direct field changes
//                            (faculty_discount_pct, three fees, three
//                            envelope rows). Field name matches the
//                            DB column.
//   onUpdateTierRates(rows)
//                          — called when tier_rates jsonb changes
//                            (add/remove/edit rate). Add and remove
//                            also trigger onUpdateFamilyDistribution
//                            atomically so the two arrays stay in
//                            sync (handled in TierRatesSection).
//   onUpdateFamilyDistribution(rows)
//                          — called when estimated_family_distribution
//                            jsonb changes (per-row count edit OR a
//                            tier shape change initiated from
//                            TierRatesSection).
//   readOnly              — boolean

function TuitionConfigurationZone({
  scenario,
  onUpdateField,
  onUpdateTierRates,
  onUpdateFamilyDistribution,
  readOnly = false,
}) {
  if (!scenario) return null

  const tierRates = Array.isArray(scenario.tier_rates) ? scenario.tier_rates : []
  const familyDistribution = Array.isArray(scenario.estimated_family_distribution)
    ? scenario.estimated_family_distribution
    : []

  return (
    <div className="px-2 py-2">
      <TierRatesSection
        tierRates={tierRates}
        familyDistribution={familyDistribution}
        onChangeTierRates={onUpdateTierRates}
        onChangeFamilyDistribution={onUpdateFamilyDistribution}
        readOnly={readOnly}
      />

      <FeesSection
        curriculumFee={scenario.curriculum_fee_per_student}
        enrollmentFee={scenario.enrollment_fee_per_student}
        beforeAfterSchoolHourlyRate={scenario.before_after_school_hourly_rate}
        onChangeCurriculumFee={(v) => onUpdateField('curriculum_fee_per_student', v)}
        onChangeEnrollmentFee={(v) => onUpdateField('enrollment_fee_per_student', v)}
        onChangeBeforeAfterSchoolHourlyRate={(v) => onUpdateField('before_after_school_hourly_rate', v)}
        readOnly={readOnly}
      />

      <DiscountEnvelopesSection
        facultyDiscountPct={scenario.faculty_discount_pct}
        otherDiscountEnvelope={scenario.other_discount_envelope}
        financialAidEnvelope={scenario.financial_aid_envelope}
        onChangeFacultyDiscountPct={(v) => onUpdateField('faculty_discount_pct', v)}
        onChangeOtherDiscountEnvelope={(v) => onUpdateField('other_discount_envelope', v)}
        onChangeFinancialAidEnvelope={(v) => onUpdateField('financial_aid_envelope', v)}
        readOnly={readOnly}
      />

      <FamilyDistributionSection
        familyDistribution={familyDistribution}
        tierRates={tierRates}
        onChange={onUpdateFamilyDistribution}
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
