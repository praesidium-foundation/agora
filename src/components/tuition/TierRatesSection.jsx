import { useEffect, useRef, useState } from 'react'
import { tierDiscountPct, computeProjectedMultiStudentDiscount } from '../../lib/tuitionMath'

// Tier Rates section — the spine of the layered discount taxonomy
// (architecture §7.3). Multi-student tiers are the primary discount
// mechanism: per-student rate decreases as family enrollment increases.
//
// UI rule: tier_count is COMPUTED from tier_rates.length; never
// directly editable. Add and remove operations modify tier_rates AND
// the parent's estimated_family_distribution atomically — both arrays
// must stay in sync (§7.3 — the projection table reads its tier rows
// from tier_rates).
//
// Tier 1 is permanent (always present; cannot be removed) and renders
// with a "BASE" badge in the tier-number column rather than the
// numeric "1" — Tier 1 is the reference rate against which all
// per-tier discounts are computed (v3.8.2, B1.1). The highest-tier
// row's family-size label uses "X+" framing ("4+ students"); when a
// new tier is added, the previous "X+" row reverts to plain "X" and
// the new top tier becomes "(X+1)+".
//
// v3.8.2 (B1.1) adds a DISCOUNT column showing each tier's percentage
// off the Tier 1 rate. Empty for Tier 1 (the base); muted italic for
// Tiers 2+. Read-only by definition (computed).
//
// v3.8.3 (B1.2) adds a Projected Multi-Student Discount subtotal row
// at the table foot. Computed from tier math — Projected Gross Tuition
// (base × headcount) minus tier-blended tuition revenue (Σ tier_rate ×
// family_count × students_per_family). Read-only; renders in all
// states. Surfaces the load-bearing first stream of the four-stream
// discount taxonomy (architecture §7.3 "Stage 1 revenue vocabulary").
// Stage 2 audit captures the actual realized multi-student discount
// per family — the Stage 1 projection and Stage 2 actual are not
// expected to agree (architecture §7.3 "Stage 1 projection vs.
// Stage 2 actual").
//
// Editing model mirrors Budget's direct-edit-with-undo (architecture
// §8.3). Click an amount → inline numeric input. Enter or blur saves;
// Escape cancels. Save flows up via onChangeTierRates; the parent
// page persists to Supabase.
//
// Props:
//   tierRates              — array of { tier_size, per_student_rate, applies_when_n_students }
//   familyDistribution     — array of { tier_size, breakdown_pct, family_count }
//                             (B1.1 jsonb shape); needed so add/remove
//                             tier operations keep both arrays in sync
//   scenario               — full scenario object (v3.8.3); used by the
//                             Multi-Student Discount subtotal computation
//                             which needs total_students,
//                             total_families, top_tier_avg_*, plus the
//                             two arrays above
//   onChangeTierRates       (next) => void
//   onChangeFamilyDistribution (next) => void
//   readOnly               — true when scenario state != 'drafting' or user lacks edit perm

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function fmtUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '$0'
  return usd0.format(Number(n))
}

function parseAmountInput(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return 0
  const cleaned = s.replace(/[$,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('Tier rates must be a non-negative number')
  }
  return n
}

function tierLabel(tierSize, isHighest) {
  if (isHighest && tierSize > 1) return `${tierSize}+ students in family`
  if (tierSize === 1) return '1 student in family'
  return `${tierSize} students in family`
}

function fmtDiscountPct(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return ''
  // Render with one decimal when needed; integer when whole.
  const n = Number(pct)
  if (n === 0) return '0%'
  if (Math.abs(n - Math.round(n)) < 0.05) return `${Math.round(n)}%`
  return `${n.toFixed(1)}%`
}

// Single inline editor for the per-student rate cell.
function RateEditor({ initial, onSave, onCancel }) {
  const [draft, setDraft] = useState(
    Number.isFinite(Number(initial)) ? String(Number(initial)) : ''
  )
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function commit() {
    try {
      const value = parseAmountInput(draft)
      onSave(value)
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          if (error) setError(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        className="w-32 text-right border-[0.5px] border-navy/40 px-2 py-1 rounded text-sm tabular-nums focus:outline-none focus:border-navy bg-white"
        aria-label="Per-student rate"
      />
      {error && (
        <span className="text-status-red text-[11px] italic mt-0.5">
          {error}
        </span>
      )}
    </span>
  )
}

function TierRatesSection({
  tierRates = [],
  familyDistribution = [],
  scenario,
  onChangeTierRates,
  onChangeFamilyDistribution,
  readOnly = false,
}) {
  const [editingTierSize, setEditingTierSize] = useState(null)

  const maxTierSize = tierRates.length > 0
    ? Math.max(...tierRates.map((t) => Number(t.tier_size) || 0))
    : 0

  const tier1Rate = (() => {
    const tier1 = tierRates.find((t) => Number(t.tier_size) === 1)
    return tier1 ? Number(tier1.per_student_rate) || 0 : 0
  })()

  function handleSaveRate(tierSize, newRate) {
    const next = tierRates.map((t) =>
      Number(t.tier_size) === Number(tierSize)
        ? { ...t, per_student_rate: newRate }
        : t
    )
    onChangeTierRates(next)
    setEditingTierSize(null)
  }

  function handleAddTier() {
    if (readOnly) return
    const nextSize = maxTierSize + 1
    const lastRate = tierRates.length > 0
      ? Number(tierRates[tierRates.length - 1].per_student_rate) || 0
      : 0
    onChangeTierRates([
      ...tierRates,
      {
        tier_size: nextSize,
        per_student_rate: lastRate,
        applies_when_n_students: nextSize,
      },
    ])
    onChangeFamilyDistribution([
      ...familyDistribution,
      { tier_size: nextSize, breakdown_pct: 0, family_count: 0 },
    ])
  }

  function handleRemoveTier(tierSize) {
    if (readOnly) return
    if (Number(tierSize) === 1) return

    const tierRow = tierRates.find((t) => Number(t.tier_size) === Number(tierSize))
    const distRow = familyDistribution.find((d) => Number(d.tier_size) === Number(tierSize))
    const hasNonZeroRate = tierRow && Number(tierRow.per_student_rate) !== 0
    const hasNonZeroBreakdown = distRow && (
      Number(distRow.breakdown_pct) !== 0 || Number(distRow.family_count) !== 0
    )

    if (hasNonZeroRate || hasNonZeroBreakdown) {
      const ok = window.confirm(
        `Remove the ${tierSize}-student tier? It currently has ` +
        `${hasNonZeroRate ? `a rate of ${fmtUsd(tierRow.per_student_rate)}` : 'no rate'} and ` +
        `${hasNonZeroBreakdown ? `a non-zero projected breakdown` : 'no projected breakdown'}. ` +
        'This cannot be undone (you can re-add the tier and re-enter values).'
      )
      if (!ok) return
    }

    onChangeTierRates(tierRates.filter((t) => Number(t.tier_size) !== Number(tierSize)))
    onChangeFamilyDistribution(
      familyDistribution.filter((d) => Number(d.tier_size) !== Number(tierSize))
    )
  }

  return (
    <section className="mb-8">
      <div className="flex items-center gap-3 px-2 py-3 border-b-2 border-gold/60 mb-2">
        <span className="font-display text-navy text-[17px] tracking-[0.08em] uppercase flex-1">
          Tier rates
        </span>
      </div>

      <p className="font-body italic text-muted text-[12px] mb-3 px-2">
        Per-student rates by family size. Larger families pay less per student.
      </p>

      <div className="px-2">
        {/* Column headers — Tier 1 row uses BASE badge, others numeric. */}
        <div className="flex items-center gap-3 pr-3 py-1.5 border-b-[0.5px] border-card-border/60">
          <span className="font-body font-medium text-navy text-[12px] tracking-wider uppercase w-12 flex-shrink-0">
            Tier
          </span>
          <span className="font-body font-medium text-navy text-[12px] tracking-wider uppercase flex-1 min-w-0">
            Family size
          </span>
          <span className="font-body font-medium text-navy text-[12px] tracking-wider uppercase w-20 flex-shrink-0 text-right">
            Discount
          </span>
          <span className="font-body font-medium text-navy text-[12px] tracking-wider uppercase w-32 flex-shrink-0 text-right">
            Per-student rate
          </span>
          <span className="w-8 flex-shrink-0" aria-hidden="true" />
        </div>

        {tierRates.length === 0 && (
          <p className="font-body italic text-muted text-sm py-3">
            No tier rows. Add at least one tier.
          </p>
        )}

        {tierRates.map((tier, idx) => {
          const tierSize = Number(tier.tier_size)
          const rate = Number(tier.per_student_rate) || 0
          const isHighest = tierSize === maxTierSize
          const isTier1 = tierSize === 1
          const editing = editingTierSize === tierSize
          const discountPct = isTier1 ? null : tierDiscountPct(rate, tier1Rate)

          return (
            <div
              key={tier.tier_size}
              className="flex items-center gap-3 pr-3 py-1.5 border-b-[0.5px] border-card-border hover:bg-cream-highlight/40"
            >
              {/* Tier column. Tier 1 → BASE badge; others → numeric. */}
              <span className="w-12 flex-shrink-0 flex items-center">
                {isTier1 ? (
                  <span
                    className="inline-block bg-gold/15 text-gold-darker font-display text-[10px] tracking-[0.12em] uppercase px-1.5 py-0.5 rounded"
                    style={{ color: '#8C5410' }}
                    aria-label="Base tier"
                    title="Base tier — the reference rate for computing per-tier discounts."
                  >
                    Base
                  </span>
                ) : (
                  <span className="font-body tabular-nums text-[12px] text-muted">
                    {idx + 1}
                  </span>
                )}
              </span>

              <span className="font-body text-[13px] text-navy/85 flex-1 min-w-0 truncate">
                {tierLabel(tierSize, isHighest)}
              </span>

              {/* Discount column — muted italic, computed read-only. */}
              <span className="font-body italic text-muted text-[12px] tabular-nums w-20 flex-shrink-0 text-right">
                {isTier1 ? '' : fmtDiscountPct(discountPct)}
              </span>

              {/* Per-student rate cell. Click to edit (parallel to
                  BudgetDetailZone's input chrome treatment). */}
              {readOnly ? (
                <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
                  {fmtUsd(rate)}
                </span>
              ) : editing ? (
                <RateEditor
                  initial={rate}
                  onSave={(v) => handleSaveRate(tierSize, v)}
                  onCancel={() => setEditingTierSize(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingTierSize(tierSize)}
                  className="text-right tabular-nums px-2 py-1 rounded font-body text-[13px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy/85"
                  aria-label={`Edit per-student rate for ${tierLabel(tierSize, isHighest)}`}
                  title="Click to edit"
                >
                  {fmtUsd(rate)}
                </button>
              )}

              <span className="w-8 flex-shrink-0 flex items-center justify-end">
                {!readOnly && !isTier1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveTier(tierSize)}
                    aria-label={`Remove ${tierLabel(tierSize, isHighest)}`}
                    title="Remove this tier"
                    className="text-muted hover:text-status-red text-[14px] leading-none px-1.5 py-1 rounded hover:bg-cream-highlight transition-colors"
                  >
                    ×
                  </button>
                )}
              </span>
            </div>
          )
        })}

        {!readOnly && (
          <button
            type="button"
            onClick={handleAddTier}
            className="mt-2 px-3 py-1.5 font-body text-[13px] text-status-blue hover:underline"
          >
            + Add tier
          </button>
        )}

        {/* v3.8.3 (B1.2): Projected Multi-Student Discount subtotal row.
            Read-only by definition (computed from tier rates ×
            family-distribution math). Renders in all states; em-dash
            when inputs are insufficient (no total_students, no
            family_counts derived, etc.). Visual separation from the
            tier rows: thin navy@25 rule above the row reads as a
            totaling rule rather than a section break. The row label
            uses Tier 2 weight (medium navy) to distinguish it from the
            tier-row leaves while staying inside the section's gold-
            border-top frame. */}
        <ProjectedMultiStudentDiscountRow scenario={scenario} />
      </div>
    </section>
  )
}

const usd0Subtotal = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function ProjectedMultiStudentDiscountRow({ scenario }) {
  const value = scenario ? computeProjectedMultiStudentDiscount(scenario) : null
  const display = value === null || value === undefined || !Number.isFinite(Number(value))
    ? '—'
    : usd0Subtotal.format(Number(value))
  return (
    <div className="mt-4 pt-3 border-t-[0.5px] border-navy/25">
      <div className="flex items-center gap-3 pr-3 py-2">
        <div className="flex-1 min-w-0">
          <p className="font-body font-semibold text-navy text-[13.5px]">
            Projected Multi-Student Discount
          </p>
          <p className="font-body italic text-muted text-[11px] mt-0.5 leading-relaxed">
            Computed from tier math. Stage 2 audit captures the actual
            realized discount per family.
          </p>
        </div>
        <span
          className={`text-right tabular-nums font-body font-semibold text-[13.5px] w-32 flex-shrink-0 ${
            value !== null && value !== undefined && Number(value) > 0
              ? 'text-navy'
              : 'text-navy/85'
          }`}
        >
          {display}
        </span>
      </div>
    </div>
  )
}

export default TierRatesSection
