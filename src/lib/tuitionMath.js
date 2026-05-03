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

// Discount % from base for a tier — the "DISCOUNT" column in the
// Tier Rates section. Tier 1 is the base; returns null for it (UI
// renders empty cell). Other tiers return ((tier1 - thisTier) /
// tier1) × 100.
export function tierDiscountPct(tierRate, tier1Rate) {
  const t1 = Number(tier1Rate) || 0
  const tr = Number(tierRate) || 0
  if (t1 <= 0) return null
  return ((t1 - tr) / t1) * 100
}

// ============================================================================
// v3.8.3 (B1.2) — Stage 1 revenue and discount math.
//
// All seven functions take the full scenario object and return null when
// inputs are insufficient. Null propagation is deliberate: a fresh
// scenario surfaces "not yet entered" honestly rather than rendering a
// misleading zero.
//
// Vocabulary (architecture §7.3, "Stage 1 revenue vocabulary"):
//   Projected Gross Tuition         = tier_1_rate × total_students
//                                      (base × headcount, no tier blending)
//   Tier-blended tuition revenue    = Σ tier_rate × family_count × students_per_family_in_tier
//                                      (top tier honors top_tier_avg_students_per_family
//                                       or falls back to top tier_size)
//   Projected Multi-Student Discount = Projected Gross Tuition − tier-blended tuition
//   Projected B&A Revenue            = hourly_rate × projected_hours
//   Projected Fee Revenue            = (curriculum_fee + enrollment_fee) × total_students
//   Projected Ed Program Revenue     = Gross Tuition + Fee Revenue + B&A Revenue
//   Total Projected Discounts        = Multi-Student + Faculty + Other + Financial Aid
//   Net Projected Ed Program Revenue = Ed Program Revenue − Total Projected Discounts
//
// Architectural note: these compute client-side for instant feedback
// during Stage 1 iteration. Server-side hoist into compute_tuition_
// scenario_kpis is queued for Tuition-C when the RPC starts returning
// a real KPI bundle (break-even, net-ed-program-ratio vs locked Budget,
// YoY). The persisted projected_multi_student_discount column is
// written from the client-computed value on save for snapshot fidelity.
// ============================================================================

// Tier 1 rate from the tier_rates jsonb. Returns 0 when missing —
// callers that need null propagation should handle that case before
// calling this (most callers will, since gross-tuition computation
// requires tier_1 to exist for a meaningful value).
function getTier1Rate(scenario) {
  const rates = Array.isArray(scenario?.tier_rates) ? scenario.tier_rates : []
  const tier1 = rates.find((r) => Number(r.tier_size) === 1)
  return tier1 ? Number(tier1.per_student_rate) || 0 : 0
}

// Projected Gross Tuition: tier_1_rate × total_students (base ×
// headcount). Returns null when total_students is null or
// non-finite — the absence is meaningful and the UI renders em-dash.
export function computeProjectedGrossAtTier1(scenario) {
  const totalStudents = scenario?.total_students
  if (totalStudents == null || !Number.isFinite(Number(totalStudents))) return null
  const tier1Rate = getTier1Rate(scenario)
  return tier1Rate * Number(totalStudents)
}

// Tier-blended tuition revenue. Sums per-tier (tier_rate ×
// family_count × students_per_family_in_tier) where the top tier
// honors top_tier_avg_students_per_family or falls back to top
// tier_size. Returns null when tier_rates or estimated_family_
// distribution is missing/empty, or when family_counts are not yet
// derived.
//
// "Not yet derived" is detected by total_families being null — when
// the user has not entered total_students/breakdowns the family_counts
// in the jsonb are still zero from the seed, and the tier-blended
// computation would return zero (which is incorrect — we want null
// to surface the absence).
export function computeTierBlendedTuition(scenario) {
  const rates = Array.isArray(scenario?.tier_rates) ? scenario.tier_rates : []
  const dist = Array.isArray(scenario?.estimated_family_distribution)
    ? scenario.estimated_family_distribution
    : []
  if (rates.length === 0 || dist.length === 0) return null

  const totalFamilies = scenario?.total_families
  if (totalFamilies == null || !Number.isFinite(Number(totalFamilies))) return null

  const top = topTierSize(dist)
  const topAvg = scenario?.top_tier_avg_students_per_family
  const topAvgEffective =
    topAvg != null && Number.isFinite(Number(topAvg)) ? Number(topAvg) : top

  let total = 0
  for (const distRow of dist) {
    const tierSize = Number(distRow.tier_size)
    const familyCount = Number(distRow.family_count) || 0
    const studentsPerFamily =
      tierSize === top ? topAvgEffective : tierSize
    const rateRow = rates.find((r) => Number(r.tier_size) === tierSize)
    const tierRate = rateRow ? Number(rateRow.per_student_rate) || 0 : 0
    total += tierRate * familyCount * studentsPerFamily
  }
  return total
}

// Projected Multi-Student Discount: Projected Gross Tuition − tier-
// blended tuition. Returns null if either input is null.
//
// At Stage 1 this is computed (as here). At Stage 2 (Tuition Audit)
// the multi-student discount becomes per-family realized actual data
// — see architecture §7.3 "Stage 1 projection vs. Stage 2 actual"
// for the full vocabulary and the deliberate variance-as-calibration-
// signal model.
export function computeProjectedMultiStudentDiscount(scenario) {
  const gross = computeProjectedGrossAtTier1(scenario)
  const blended = computeTierBlendedTuition(scenario)
  if (gross == null || blended == null) return null
  return gross - blended
}

// Projected B&A Revenue: hourly_rate × projected_hours. Returns null
// if either input is null. The hourly rate may legitimately be zero
// (some schools do not charge a per-hour B&A fee), in which case the
// computation returns zero — that is meaningful and distinct from
// "not yet entered."
export function computeProjectedBARevenue(scenario) {
  const hours = scenario?.projected_b_a_hours
  const rate = scenario?.before_after_school_hourly_rate
  if (hours == null || !Number.isFinite(Number(hours))) return null
  if (rate == null || !Number.isFinite(Number(rate))) return null
  return Number(rate) * Number(hours)
}

// Projected Fee Revenue: (curriculum_fee + enrollment_fee) ×
// total_students. Returns null if total_students is null. Fee values
// default to 0 when null (B1.1 sets them to 0 explicitly via the
// empty-state seed; this is defensive for forward compat).
export function computeProjectedFeeRevenue(scenario) {
  const totalStudents = scenario?.total_students
  if (totalStudents == null || !Number.isFinite(Number(totalStudents))) return null
  const curriculum = Number(scenario?.curriculum_fee_per_student) || 0
  const enrollment = Number(scenario?.enrollment_fee_per_student) || 0
  return (curriculum + enrollment) * Number(totalStudents)
}

// Projected Ed Program Revenue (gross): Projected Gross Tuition +
// Projected Fee Revenue + Projected B&A Revenue.
//
// Strict null propagation on the gross-tuition and fee-revenue
// components (both depend on total_students; if it is null the gross
// concept is incomplete). B&A revenue treated as 0 when null (a
// school may legitimately project zero B&A hours; that should not
// poison the rest of the gross computation).
export function computeProjectedEdProgramRevenue(scenario) {
  const grossTuition = computeProjectedGrossAtTier1(scenario)
  const feeRevenue = computeProjectedFeeRevenue(scenario)
  if (grossTuition == null || feeRevenue == null) return null
  const baRevenue = computeProjectedBARevenue(scenario) ?? 0
  return grossTuition + feeRevenue + baRevenue
}

// Total Projected Discounts: Multi-Student + Faculty + Other +
// Financial Aid. Faculty / Other / FA default to 0 when null (B1.1
// makes them NOT NULL DEFAULT 0 at the schema level, but defensive
// coalesce here keeps the function robust). Multi-Student propagates
// null — without it the four-stream concept is incomplete.
export function sumTotalProjectedDiscounts(scenario) {
  const multiStudent = computeProjectedMultiStudentDiscount(scenario)
  if (multiStudent == null) return null
  const faculty = Number(scenario?.projected_faculty_discount_amount) || 0
  const other = Number(scenario?.projected_other_discount) || 0
  const fa = Number(scenario?.projected_financial_aid) || 0
  return multiStudent + faculty + other + fa
}

// Net Projected Ed Program Revenue: Projected Ed Program Revenue −
// Total Projected Discounts. The load-bearing operational KPI: this
// is the "are we at 102% of expenses?" number that drives Stage 1
// tuition-rate decisions.
//
// Returns null if either input is null.
export function computeNetProjectedEdProgramRevenue(scenario) {
  const gross = computeProjectedEdProgramRevenue(scenario)
  const discounts = sumTotalProjectedDiscounts(scenario)
  if (gross == null || discounts == null) return null
  return gross - discounts
}

// ============================================================================
// v3.8.4 (B1.3) — Tuition Fees grand subtotal.
// ============================================================================

// Tuition Fees Subtotal: Per-Student Fees Subtotal + B&A Revenue
// Subtotal. Renders bold at the foot of the Tuition Fees section
// alongside its two italic-muted component subtotals.
//
// Null-handling rule (v3.8.4 spec):
//   - Both null → null (em-dash; section is "not yet projected")
//   - One null, other has value → present value carries through
//     (the section is partially populated, not unprojected; treating
//     the missing component as zero is more honest than emitting null
//     and losing the visible signal)
//   - Both present → straight sum
export function computeTuitionFeesSubtotal(scenario) {
  const fees = computeProjectedFeeRevenue(scenario)
  const ba = computeProjectedBARevenue(scenario)
  if (fees == null && ba == null) return null
  return (fees ?? 0) + (ba ?? 0)
}

// ============================================================================
// v3.8.7 (Tuition-C) — Stage 1 decision-support KPIs.
//
// Two KPIs the Tuition Committee uses to evaluate a scenario before
// recommending it to the Board:
//   - Net Education Program Ratio: Net Projected Ed Program Revenue
//     divided by an expense comparator (latest locked Budget total
//     expenses, OR a manual estimate). The 102%-of-expenses target
//     lives here.
//   - Breakeven Enrollment: given current tier rates, fees, B&A
//     projections, and discount envelopes, the enrollment count
//     required to match the expense comparator.
//
// Both depend on the per-scenario `expense_comparator_amount` column
// (Migration 029). Both return null when the comparator is null,
// when total_students is null/0, or when any required tier/fee data
// is missing — consistent with B1.x null-propagation discipline.
//
// Architectural decision (carried over from v3.8.3 / B1.2): these
// compute client-side via tuitionMath.js for instant feedback during
// Stage 1 iteration. Server-side hoist into compute_tuition_scenario_
// kpis is queued for Tuition-C+ when the RPC starts returning a
// richer KPI bundle (cross-module dashboards, etc.) and the round-
// trip cost amortizes across multiple KPIs.
// ============================================================================

// Per-student tier-blended rate. Pure helper pulled out so the
// breakeven formula reads cleanly — the ratio of tier-blended tuition
// to total students is the average per-student revenue net of the
// multi-student discount, assuming the breakdown_pct distribution
// holds as enrollment scales.
//
// Returns null when total_students is null/0 or tier-blended tuition
// is null (no tier rates / no derived family counts).
export function computeBlendedAvgPerStudentRate(scenario) {
  const totalStudents = scenario?.total_students
  if (totalStudents == null || !Number.isFinite(Number(totalStudents))) return null
  const n = Number(totalStudents)
  if (n <= 0) return null
  const blended = computeTierBlendedTuition(scenario)
  if (blended == null) return null
  return blended / n
}

// Net Education Program Ratio: Net Projected Ed Program Revenue
// divided by the expense comparator. Returns a decimal (e.g., 1.021
// for 102.1%); the rendering layer formats as a percentage via
// formatPercent.
//
// Returns null if Net Ed Program Revenue is null OR the comparator
// is null OR the comparator is 0 (division by zero would be
// meaningless and we want em-dash to surface "not yet measurable").
export function computeNetEdProgramRatio(scenario, expenseComparator) {
  const net = computeNetProjectedEdProgramRevenue(scenario)
  if (net == null) return null
  if (expenseComparator == null || !Number.isFinite(Number(expenseComparator))) return null
  const denom = Number(expenseComparator)
  if (denom === 0) return null
  return net / denom
}

// Breakeven Enrollment forward solve, assuming the current
// breakdown_pct distribution holds as enrollment scales.
//
// Math derivation (the formula's pieces all scale linearly in N
// except the fixed-dollar discount envelopes):
//
//   gross_at_N         = base_rate × N                    (linear)
//   tier_blended_at_N  = blended_avg_per_student × N      (linear)
//   multi_student_at_N = N × (base_rate − blended_avg_per_student)
//   fees_at_N          = (curriculum + enrollment) × N    (linear)
//   ba_revenue_at_N    = (current_ba_revenue / total_students) × N    (linear)
//   faculty + other + FA discounts                        (fixed envelopes; do not scale)
//
// Solving for N where revenue = expense_comparator + fixed_envelopes:
//
//   N × (blended_avg_per_student + per_student_fees + ba_per_student)
//     = expense_comparator + fixed_envelopes
//
//   N = (expense_comparator + fixed_envelopes) /
//       (blended_avg_per_student + per_student_fees + ba_per_student)
//
// Round up via Math.ceil — fractional students do not exist; the
// floor would understate the requirement.
//
// Returns null when:
//   - expense_comparator is null
//   - total_students is null/0 (cannot compute per-student rates)
//   - blended_avg_per_student is null (tier-blended math incomplete)
//   - the per-student denominator is 0 (would divide by zero)
export function computeBreakevenEnrollment(scenario, expenseComparator) {
  if (expenseComparator == null || !Number.isFinite(Number(expenseComparator))) return null
  const totalStudents = scenario?.total_students
  if (totalStudents == null || !Number.isFinite(Number(totalStudents))) return null
  const n = Number(totalStudents)
  if (n <= 0) return null

  const blendedPerStudent = computeBlendedAvgPerStudentRate(scenario)
  if (blendedPerStudent == null) return null

  const curriculum = Number(scenario?.curriculum_fee_per_student) || 0
  const enrollment = Number(scenario?.enrollment_fee_per_student) || 0
  const perStudentFees = curriculum + enrollment

  // B&A per student: scale current B&A revenue by enrollment ratio.
  // If projected_b_a_hours or hourly rate are null, B&A revenue is
  // null; treat as 0 contribution (a school may legitimately project
  // zero B&A — we should not poison the breakeven formula).
  const baRevenue = computeProjectedBARevenue(scenario) ?? 0
  const baPerStudent = baRevenue / n

  const denom = blendedPerStudent + perStudentFees + baPerStudent
  if (denom <= 0) return null

  // Fixed dollar envelopes — do not scale with enrollment.
  const faculty = Number(scenario?.projected_faculty_discount_amount) || 0
  const other = Number(scenario?.projected_other_discount) || 0
  const fa = Number(scenario?.projected_financial_aid) || 0
  const fixedEnvelopes = faculty + other + fa

  const numer = Number(expenseComparator) + fixedEnvelopes
  return Math.ceil(numer / denom)
}
