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
//
// v3.8.2 (B1.1) reshapes estimated_family_distribution to include
// breakdown_pct alongside family_count. Fresh-state default: every
// row at zero. The user enters total_students + breakdown_pct values
// from there; family_count is derived application-side and written
// back to the jsonb on save so downstream reads (snapshots, KPIs)
// have it without recomputation.

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
    { tier_size: 1, breakdown_pct: 0, family_count: 0 },
    { tier_size: 2, breakdown_pct: 0, family_count: 0 },
    { tier_size: 3, breakdown_pct: 0, family_count: 0 },
    { tier_size: 4, breakdown_pct: 0, family_count: 0 },
  ]
}
