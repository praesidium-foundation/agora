// Tuition module — projection math helpers.
//
// Two responsibilities:
//   1. Derive total_families from total_students + breakdown_pcts +
//      top_tier_avg_students_per_family (when total_families is not
//      overridden).
//   2. Derive per-tier family_count from total_families × breakdown_pct
//      / 100 (rounded). This is what gets stored in the jsonb on save
//      so downstream reads have it without recomputation.
//
// All inputs may be null (fresh scenario). Helpers return null when
// inputs are insufficient to compute, so callers can render em-dashes
// uniformly.
//
// Architecture §7.3 (rewritten in v3.8.2) is the canonical spec for
// these formulas.

// Top tier_size among the breakdown rows. Returns null if the
// distribution is empty.
export function topTierSize(distribution) {
  if (!Array.isArray(distribution) || distribution.length === 0) return null
  return Math.max(...distribution.map((r) => Number(r.tier_size) || 0))
}

// Sum of breakdown_pct across all rows. Returns 0 for empty arrays
// so callers can compare directly against 100.
export function breakdownSum(distribution) {
  if (!Array.isArray(distribution)) return 0
  return distribution.reduce(
    (sum, r) => sum + (Number(r.breakdown_pct) || 0),
    0
  )
}

// Weighted-average students per family across the distribution. The
// top tier uses topTierAvgStudents (when set) instead of its tier_size.
//
// Formula:
//   Σ ( (breakdown_pct[i] / 100) × students_per_family_in_tier[i] )
// where:
//   students_per_family_in_tier[i] = tier_size                   for non-top tiers
//                                   topTierAvgStudents ?? tier_size for the top tier
//
// Returns null when distribution is empty or breakdown sum is zero
// (no projection yet).
export function weightedAvgStudentsPerFamily(distribution, topTierAvgStudents) {
  if (!Array.isArray(distribution) || distribution.length === 0) return null
  const top = topTierSize(distribution)
  let total = 0
  let pctSum = 0
  for (const row of distribution) {
    const tierSize = Number(row.tier_size) || 0
    const pct = Number(row.breakdown_pct) || 0
    const studentsPerFamily =
      tierSize === top && topTierAvgStudents != null && Number.isFinite(Number(topTierAvgStudents))
        ? Number(topTierAvgStudents)
        : tierSize
    total += (pct / 100) * studentsPerFamily
    pctSum += pct
  }
  if (pctSum === 0) return null
  return total
}

// Computed total_families from total_students ÷ weighted_avg. Returns
// null when total_students is null/zero or weighted_avg cannot be
// computed (no breakdown yet). Result is rounded to nearest integer.
export function computeTotalFamilies({ totalStudents, distribution, topTierAvgStudents }) {
  if (totalStudents == null || !Number.isFinite(Number(totalStudents)) || Number(totalStudents) <= 0) {
    return null
  }
  const avg = weightedAvgStudentsPerFamily(distribution, topTierAvgStudents)
  if (avg == null || avg <= 0) return null
  return Math.round(Number(totalStudents) / avg)
}

// Implied total_students when total_families is overridden — the
// reverse of computeTotalFamilies. Used to render the "Implied
// students: X (entered: Y)" reconciliation. Returns null when
// total_families is null or weighted_avg is unavailable.
export function impliedTotalStudents({ totalFamilies, distribution, topTierAvgStudents }) {
  if (totalFamilies == null || !Number.isFinite(Number(totalFamilies)) || Number(totalFamilies) <= 0) {
    return null
  }
  const avg = weightedAvgStudentsPerFamily(distribution, topTierAvgStudents)
  if (avg == null || avg <= 0) return null
  return Math.round(Number(totalFamilies) * avg)
}

// Derive family_count for a single tier row from total_families and
// breakdown_pct. Returns 0 when inputs are missing — that becomes the
// stored value in the jsonb so downstream reads see consistent zeros
// rather than null/undefined.
export function deriveFamilyCount(totalFamilies, breakdownPct) {
  if (totalFamilies == null || !Number.isFinite(Number(totalFamilies))) return 0
  if (breakdownPct == null || !Number.isFinite(Number(breakdownPct))) return 0
  return Math.round((Number(totalFamilies) * Number(breakdownPct)) / 100)
}

// Apply derived family_count back into a distribution array. Pure;
// returns a new array. Used on every save path that touches
// total_families or breakdown_pct so the stored jsonb stays
// self-consistent.
export function applyDerivedFamilyCounts(distribution, totalFamilies) {
  if (!Array.isArray(distribution)) return distribution
  return distribution.map((row) => ({
    ...row,
    family_count: deriveFamilyCount(totalFamilies, row.breakdown_pct),
  }))
}

// Discount % from base for a tier — the new "DISCOUNT" column in the
// Tier Rates section. Tier 1 is the base; returns null for it (UI
// renders empty cell). Other tiers return ((tier1 - thisTier) /
// tier1) × 100.
export function tierDiscountPct(tierRate, tier1Rate) {
  const t1 = Number(tier1Rate) || 0
  const tr = Number(tierRate) || 0
  if (t1 <= 0) return null
  return ((t1 - tr) / t1) * 100
}
