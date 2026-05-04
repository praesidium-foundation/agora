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
//
// v3.8.9 (Tuition-B1.6) note: the editability flip makes
// discount_pct an explicit stored field on each tier_rates row.
// The new computePerStudentRateFromDiscount helper below is the
// inverse — used by the save path cascade. tierDiscountPct stays
// for any consumer that wants to recompute from rates (e.g.,
// downstream code that does not yet read the stored discount_pct
// field).
export function tierDiscountPct(tierRate, tier1Rate) {
  const t1 = Number(tier1Rate) || 0
  const tr = Number(tierRate) || 0
  if (t1 <= 0) return null
  return ((t1 - tr) / t1) * 100
}

// v3.8.9 (Tuition-B1.6): inverse of tierDiscountPct — compute the
// per-student rate from a base rate and a discount percentage.
// Used by the Tier Rates section save-path cascade:
//   - Editing tier 1 per_student_rate → for each tier 2+, compute
//     new per_student_rate from new base × stored discount_pct.
//   - Editing a tier 2+ discount_pct → compute new per_student_rate
//     for that tier from base × new discount_pct.
//
// Math: Math.round(baseRate × (1 − discountPct/100)). Rounded to
// whole dollars to match the user's mental model (per-student
// rates are always quoted in whole dollars at Libertas) and to
// keep the stored value identical to what the user sees rendered.
//
// Returns null when either input is null / non-finite — strict
// null propagation per the v3.8.x convention.
export function computePerStudentRateFromDiscount(baseRate, discountPct) {
  if (baseRate == null || !Number.isFinite(Number(baseRate))) return null
  if (discountPct == null || !Number.isFinite(Number(discountPct))) return null
  return Math.round(Number(baseRate) * (1 - Number(discountPct) / 100))
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

// ============================================================================
// v3.8.14 (Tuition-B2a) — Stage 2 per-family row computation helpers.
//
// Used by the per-family editor (TuitionFamilyDetailsTable) for the
// five computed columns (Base Tuition, Multi-Student Discount, Net
// Tuition Rate, Subtotal Tuition for Year, NET Tuition for YEAR) and
// by the override-detection logic that drives the gold-dot indicator.
//
// Faculty discount rule (architecture §7.3 + Appendix C v3.8.14):
//   The standard rule is that faculty discount REPLACES multi-student
//   tier discount. Faculty families are charged base_rate × students ×
//   (1 - faculty_discount_pct/100); the multi-student tier discount
//   does NOT apply. Implementation:
//     - applied_tier_size resolves to 1 for faculty families
//     - applied_tier_rate resolves to base_rate for faculty families
//     - Multi-Student Discount renders $0 for faculty families
//     - faculty_discount_amount auto-populates from base × students × pct
//
//   Manual overrides (faculty_discount_amount, applied_tier_rate)
//   stored on the family row take precedence over the auto-computed
//   values. The isFamily*Overridden helpers compare stored vs.
//   auto-computed to drive the gold-dot indicator.
// ============================================================================

// Resolve a per-tier rate from the scenario's tier_rates jsonb. Walks
// the rows looking for tier_size === target; returns base rate (tier 1)
// if no match.
function getTierRateForSize(scenario, tierSize) {
  const rates = Array.isArray(scenario?.tier_rates) ? scenario.tier_rates : []
  const t1 = rates.find((r) => Number(r.tier_size) === 1)
  const baseRate = t1 ? Number(t1.per_student_rate) || 0 : 0
  if (tierSize === 1) return baseRate
  const match = rates.find((r) => Number(r.tier_size) === Number(tierSize))
  return match ? Number(match.per_student_rate) || 0 : baseRate
}

// Natural per-student rate for a family — what the rate WOULD be
// based on is_faculty_family and students_enrolled, before any manual
// override. Faculty families: base rate. Non-faculty: tier rate at
// students_enrolled (or top-tier rate if students_enrolled exceeds
// the highest configured tier).
function naturalPerStudentRate(family, scenario) {
  const baseRate = getTierRateForSize(scenario, 1)
  if (family?.is_faculty_family) return baseRate
  const students = Number(family?.students_enrolled) || 0
  if (students <= 0) return null
  // Resolve the tier_size that applies. Top-tier rate covers
  // students_enrolled at or above the top tier_size in the config.
  const rates = Array.isArray(scenario?.tier_rates) ? scenario.tier_rates : []
  if (rates.length === 0) return baseRate
  const sortedSizes = rates
    .map((r) => Number(r.tier_size))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
  if (sortedSizes.length === 0) return baseRate
  const topSize = sortedSizes[sortedSizes.length - 1]
  const targetSize = students >= topSize ? topSize : students
  return getTierRateForSize(scenario, targetSize)
}

// Family's applied tier rate — the rate actually used for billing.
// Returns the manual override (stored applied_tier_rate) if set;
// otherwise returns the natural rate.
//
// Returns null if students_enrolled is null / 0 (insufficient input
// to compute) — the editor renders em-dash in that case.
export function computeFamilyAppliedTierRate(family, scenario) {
  if (family?.applied_tier_rate != null) {
    return Number(family.applied_tier_rate)
  }
  return naturalPerStudentRate(family, scenario)
}

// Multi-Student Discount for a family. Faculty families: 0 (the
// rule does not apply). Non-faculty families: (base_rate -
// applied_tier_rate) × students_enrolled.
//
// Returns null if applied_tier_rate or students_enrolled are
// insufficient.
export function computeFamilyMultiStudentDiscount(family, scenario) {
  if (family?.is_faculty_family) return 0
  const students = Number(family?.students_enrolled) || 0
  if (students <= 0) return null
  const applied = computeFamilyAppliedTierRate(family, scenario)
  if (applied == null) return null
  const baseRate = getTierRateForSize(scenario, 1)
  return (baseRate - applied) * students
}

// Auto-computed faculty discount amount — what the value WOULD be
// based on is_faculty_family / students_enrolled / base_rate /
// faculty_discount_pct, before any manual override.
//
// Returns null when is_faculty_family is false (the field doesn't
// apply) OR when inputs are insufficient.
export function computeFamilyFacultyDiscountAuto(family, scenario) {
  if (!family?.is_faculty_family) return null
  const students = Number(family?.students_enrolled) || 0
  if (students <= 0) return null
  const baseRate = getTierRateForSize(scenario, 1)
  if (baseRate <= 0) return null
  const pct = Number(scenario?.faculty_discount_pct)
  if (!Number.isFinite(pct)) return null
  return baseRate * students * (pct / 100)
}

// NET Tuition for the YEAR — the bottom-right number for each family.
// Subtotal − faculty − other − financial aid, treating null
// discount fields as zero (they have not been allocated).
//
// Returns null if the subtotal cannot be computed.
export function computeFamilyNetTuition(family, scenario) {
  const students = Number(family?.students_enrolled) || 0
  if (students <= 0) return null
  const applied = computeFamilyAppliedTierRate(family, scenario)
  if (applied == null) return null
  const subtotal = applied * students
  const faculty = Number(family?.faculty_discount_amount) || 0
  const other = Number(family?.other_discount_amount) || 0
  const fa = Number(family?.financial_aid_amount) || 0
  return subtotal - faculty - other - fa
}

// Override detection — is the stored faculty_discount_amount different
// from the auto-computed value? Drives the gold-dot indicator on the
// Faculty Discount cell.
//
// Returns false when the field doesn't apply (non-faculty family) OR
// when the stored and auto values match within rounding tolerance.
//
// "Within rounding tolerance" = strictly equal as numbers; the auto
// computation is deterministic and the editor stores the auto value
// directly when toggling, so any divergence is an explicit operator
// override.
export function isFamilyFacultyDiscountOverridden(family, scenario) {
  if (!family?.is_faculty_family) return false
  if (family?.faculty_discount_amount == null) return false
  const auto = computeFamilyFacultyDiscountAuto(family, scenario)
  if (auto == null) return false
  return Number(family.faculty_discount_amount) !== Number(auto)
}

// Override detection for applied_tier_rate. Returns true when the
// stored applied_tier_rate diverges from the natural rate for the
// family's current is_faculty_family / students_enrolled.
//
// Returns false when there is no stored applied_tier_rate (the
// editor would compute and display the natural rate; no override).
export function isFamilyTierRateOverridden(family, scenario) {
  if (family?.applied_tier_rate == null) return false
  const natural = naturalPerStudentRate(family, scenario)
  if (natural == null) return false
  return Number(family.applied_tier_rate) !== Number(natural)
}

// Resolve the natural applied_tier_size for a family — used by the
// save-path cascade when toggling is_faculty_family or changing
// students_enrolled. Faculty families: 1. Non-faculty: capped at the
// top configured tier_size.
export function naturalAppliedTierSize(family, scenario) {
  if (family?.is_faculty_family) return 1
  const students = Number(family?.students_enrolled) || 1
  const rates = Array.isArray(scenario?.tier_rates) ? scenario.tier_rates : []
  if (rates.length === 0) return Math.max(1, students)
  const sortedSizes = rates
    .map((r) => Number(r.tier_size))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
  if (sortedSizes.length === 0) return Math.max(1, students)
  const topSize = sortedSizes[sortedSizes.length - 1]
  return students >= topSize ? topSize : Math.max(1, students)
}

// Public — exported for the save-path cascade in TuitionAuditPage.
// Same math as naturalPerStudentRate but exported so the page can
// recompute when applying tier changes.
export function naturalAppliedTierRate(family, scenario) {
  return naturalPerStudentRate(family, scenario)
}

// ============================================================================
// v3.8.16 (Tuition-B2-final) — Stage 2 audit-page header zone aggregates.
//
// Three groups of helpers feeding the redesigned Tuition Audit page's
// reference header zone (3-card grid):
//   - Discount Envelopes card → computeEnvelopesUsed(families, scenario)
//   - Enrolled Families card  → computeFamilyDistribution(families)
//   - Net Tuition for Year    → computeNetTuitionForYear(families, scenario)
//
// All helpers operate on the live family_details array (loaded by
// TuitionAuditPage) and the active Stage 2 scenario row (which carries
// the Stage 1 envelope budgets via its `projected_*` columns —
// inherited at scenario seed time per Migration 029).
// ============================================================================

// Sum of per-family multi-student discount across all families.
// Faculty families contribute 0 per the faculty-discount-replaces-
// multi-student-tier-discount rule (Appendix C v3.8.14).
export function sumMultiStudentDiscountUsed(families, scenario) {
  if (!Array.isArray(families)) return 0
  let total = 0
  for (const f of families) {
    const v = computeFamilyMultiStudentDiscount(f, scenario)
    if (v != null) total += Number(v) || 0
  }
  return total
}

// Sum of stored faculty_discount_amount across all families.
// Operator-overridden values take precedence over auto-computed (the
// stored value IS the truth at the row level; aggregate just sums).
export function sumFacultyDiscountUsed(families) {
  if (!Array.isArray(families)) return 0
  let total = 0
  for (const f of families) {
    const v = Number(f?.faculty_discount_amount)
    if (Number.isFinite(v)) total += v
  }
  return total
}

export function sumOtherDiscountUsed(families) {
  if (!Array.isArray(families)) return 0
  let total = 0
  for (const f of families) {
    const v = Number(f?.other_discount_amount)
    if (Number.isFinite(v)) total += v
  }
  return total
}

export function sumFinancialAidUsed(families) {
  if (!Array.isArray(families)) return 0
  let total = 0
  for (const f of families) {
    const v = Number(f?.financial_aid_amount)
    if (Number.isFinite(v)) total += v
  }
  return total
}

// Build the four-row envelope tracker shape for the Discount Envelopes
// card. Each row: { key, label, budget, used, remaining }.
//
// budget values come from the scenario's projected_* columns (Stage 1
// envelope budgets seeded into Stage 2 at create_tuition_scenario_
// from_snapshot time). Multi-Student "budget" is the projected
// multi_student_discount stored on the scenario by tuitionMath's
// projection on every save (Migration 028).
//
// remaining = budget - used. Negative means over-budget (rendered as
// parens in red by the UI per §10.12).
export function computeEnvelopesUsed(families, scenario) {
  const multiStudent = sumMultiStudentDiscountUsed(families, scenario)
  const faculty = sumFacultyDiscountUsed(families)
  const other = sumOtherDiscountUsed(families)
  const fa = sumFinancialAidUsed(families)

  const multiStudentBudget = Number(scenario?.projected_multi_student_discount) || 0
  const facultyBudget = Number(scenario?.projected_faculty_discount_amount) || 0
  const otherBudget = Number(scenario?.projected_other_discount) || 0
  const faBudget = Number(scenario?.projected_financial_aid) || 0

  const rows = [
    {
      key: 'multi_student',
      label: 'Multi-Student',
      budget: multiStudentBudget,
      used: multiStudent,
      remaining: multiStudentBudget - multiStudent,
    },
    {
      key: 'faculty',
      label: 'Faculty',
      budget: facultyBudget,
      used: faculty,
      remaining: facultyBudget - faculty,
    },
    {
      key: 'other',
      label: 'Other',
      budget: otherBudget,
      used: other,
      remaining: otherBudget - other,
    },
    {
      key: 'financial_aid',
      label: 'Financial Aid',
      budget: faBudget,
      used: fa,
      remaining: faBudget - fa,
    },
  ]

  const total = {
    key: 'total',
    label: 'Total',
    budget: rows.reduce((s, r) => s + r.budget, 0),
    used: rows.reduce((s, r) => s + r.used, 0),
    remaining: rows.reduce((s, r) => s + r.remaining, 0),
  }

  return { rows, total }
}

// Family distribution — counts and percentages by tier. Used by the
// Enrolled Families card.
//
// Returns:
//   {
//     tiers: [{ tier_size: 1, count, pct }, ..., { tier_size: '4+', count, pct }],
//     totalFamilies, totalStudents
//   }
//
// Tier 4+ collapses families with students_enrolled >= 4 into one
// row. Withdrawn families (date_withdrawn set) are still counted —
// they occupied seats during their enrolled period and the audit
// records that fact.
export function computeFamilyDistribution(families) {
  if (!Array.isArray(families)) {
    return { tiers: [], totalFamilies: 0, totalStudents: 0 }
  }
  const counts = { 1: 0, 2: 0, 3: 0, '4+': 0 }
  let totalStudents = 0
  for (const f of families) {
    const n = Number(f?.students_enrolled) || 0
    if (n >= 4) counts['4+']++
    else if (n === 3) counts[3]++
    else if (n === 2) counts[2]++
    else if (n === 1) counts[1]++
    totalStudents += n
  }
  const totalFamilies = (counts[1] + counts[2] + counts[3] + counts['4+']) || 0
  const pct = (n) => (totalFamilies > 0 ? Math.round((n / totalFamilies) * 100) : 0)
  return {
    tiers: [
      { tier_size: 1,    count: counts[1],     pct: pct(counts[1]) },
      { tier_size: 2,    count: counts[2],     pct: pct(counts[2]) },
      { tier_size: 3,    count: counts[3],     pct: pct(counts[3]) },
      { tier_size: '4+', count: counts['4+'],  pct: pct(counts['4+']) },
    ],
    totalFamilies,
    totalStudents,
  }
}

// Aggregate NET tuition for the year across all families. Used by
// the Enrolled Families card's footer line.
export function computeNetTuitionForYear(families, scenario) {
  if (!Array.isArray(families)) return 0
  let total = 0
  for (const f of families) {
    const v = computeFamilyNetTuition(f, scenario)
    if (v != null) total += Number(v) || 0
  }
  return total
}
