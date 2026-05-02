// Tuition module — seed defaults for new scenarios.
//
// Centralized so the empty-state path and the "Start fresh" path in
// TuitionNewScenarioModal produce identical seeds. Per architecture
// §7.3, Stage 1 configuration is the contractual surface (families
// sign tuition agreements at these rates), so the seed values are
// deliberately zeroed — the user must explicitly fill them.
//
// Tier shape: four rows (1 / 2 / 3 / 4+ students per family) is the
// Libertas convention; the schema's tier_count stores 4 by default.
// `applies_when_n_students` is a forward-compat field for future
// generalization (e.g., a school that wants tier 3 to apply to
// 3-or-more rather than exactly 3); for B1 it equals tier_size.

export function defaultTierRates() {
  return [
    { tier_size: 1, per_student_rate: 0, applies_when_n_students: 1 },
    { tier_size: 2, per_student_rate: 0, applies_when_n_students: 2 },
    { tier_size: 3, per_student_rate: 0, applies_when_n_students: 3 },
    { tier_size: 4, per_student_rate: 0, applies_when_n_students: 4 },
  ]
}

export function defaultFamilyDistribution() {
  return [
    { tier_size: 1, family_count: 0 },
    { tier_size: 2, family_count: 0 },
    { tier_size: 3, family_count: 0 },
    { tier_size: 4, family_count: 0 },
  ]
}
