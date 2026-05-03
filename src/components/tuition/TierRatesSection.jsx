import { useEffect, useRef, useState } from 'react'
import { computePerStudentRateFromDiscount } from '../../lib/tuitionMath'

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
// v3.8.2 (B1.1) introduced the DISCOUNT column showing each tier's
// percentage off the Tier 1 rate. v3.8.9 (B1.6) flips the editability
// model: real-data walkthrough surfaced that the prior "all
// per-student rates editable" model required users to manually
// compute tier rates with a calculator. The new model:
//
//   - Tier 1 (BASE): per_student_rate stays editable as the base
//     input. DISCOUNT column renders empty (the BASE badge already
//     conveys the meaning).
//   - Tiers 2+: per_student_rate becomes read-only, computed as
//     Math.round(base_rate × (1 - discount_pct/100)). DISCOUNT column
//     becomes the editable input.
//   - Cascade: editing the base rate recomputes all tier 2+
//     per_student_rate values atomically from stored discount_pct.
//   - New tiers seed at discount_pct = 0% (per_student_rate equals
//     base_rate until the user enters a real discount).
//
// Editing model mirrors Budget's direct-edit-with-undo (architecture
// §8.3). Click an amount → inline numeric input. Enter or blur saves;
// Escape cancels. Save flows up via onChangeTierRates; the parent
// page persists to Supabase. The cascade IS user-visible — the user
// types a new base rate, tabs away, and sees all tier 2+ per_student_
// rate cells update simultaneously.
//
// Props:
//   tierRates              — array of { tier_size, per_student_rate, discount_pct, applies_when_n_students }
//                             (v3.8.9 jsonb shape — discount_pct field added)
//   familyDistribution     — array of { tier_size, breakdown_pct, family_count }
//                             (B1.1 jsonb shape); needed so add/remove
//                             tier operations keep both arrays in sync
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

// v3.8.9 (B1.6): discount % parser. Strips "%", parses numeric,
// validates 0 ≤ pct < 100, clamps to 2-decimal precision. Empty
// input returns 0 (treated as "no discount"). The cascade rounds
// the resulting per_student_rate to whole dollars; the discount %
// itself preserves its 2-decimal form so round-trip math against
// the source spreadsheet stays exact.
function parseDiscountInput(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return 0
  const cleaned = s.replace(/[%\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0 || n >= 100) {
    throw new Error('Discount must be between 0 and less than 100')
  }
  return Math.round(n * 100) / 100  // clamp to 2 decimals
}

function tierLabel(tierSize, isHighest) {
  if (isHighest && tierSize > 1) return `${tierSize}+ students in family`
  if (tierSize === 1) return '1 student in family'
  return `${tierSize} students in family`
}

// v3.8.9: always 2-decimal display per spec ("matches the precision
// of school-side budgeting spreadsheets and round-trips dollar
// values cleanly"). "0.00%" reads slightly heavy but is consistent
// across all tier rows.
function fmtDiscountPct(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(Number(pct))) return ''
  return `${Number(pct).toFixed(2)}%`
}

// Inline editor for the per-student rate cell (only used by Tier 1
// in the v3.8.9 editability model).
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

// v3.8.9 (B1.6): inline editor for the discount % cell. On focus,
// shows raw numeric (e.g., "1.56"); on blur, parses + saves; the
// row re-renders the formatted "1.56%" display.
function DiscountEditor({ initial, onSave, onCancel }) {
  const [draft, setDraft] = useState(
    initial === null || initial === undefined ? '' : String(initial)
  )
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function commit() {
    try {
      const value = parseDiscountInput(draft)
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
        className="w-20 text-right border-[0.5px] border-navy/40 px-2 py-1 rounded text-sm tabular-nums focus:outline-none focus:border-navy bg-white"
        aria-label="Discount percentage"
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
  onChangeTierRates,
  onChangeFamilyDistribution,
  readOnly = false,
}) {
  // v3.8.9: two separate edit-state vars since each tier 2+ row has
  // two cells but only one is editable per row (discount %), and
  // tier 1 has the per-student rate input.
  const [editingBaseRate, setEditingBaseRate] = useState(false)
  const [editingTierDiscount, setEditingTierDiscount] = useState(null)  // tier_size of currently-editing tier 2+

  const maxTierSize = tierRates.length > 0
    ? Math.max(...tierRates.map((t) => Number(t.tier_size) || 0))
    : 0

  const minTierSize = tierRates.length > 0
    ? Math.min(...tierRates.map((t) => Number(t.tier_size) || 0))
    : 1

  // Base rate = the lowest-tier-size row's per_student_rate (typically
  // tier_size = 1). Defensive against schemas where the base might
  // sit at a different tier_size.
  const baseRate = (() => {
    const baseTier = tierRates.find((t) => Number(t.tier_size) === minTierSize)
    return baseTier ? Number(baseTier.per_student_rate) || 0 : 0
  })()

  // ---- save handlers ----------------------------------------------------

  // Edit Tier 1 (BASE) per_student_rate → cascade to all tier 2+ rows
  // by recomputing per_student_rate from stored discount_pct.
  function handleSaveBaseRate(newRate) {
    setEditingBaseRate(false)
    const next = tierRates.map((t) => {
      const tierSize = Number(t.tier_size)
      if (tierSize === minTierSize) {
        // Tier 1: the user's edit. discount_pct stays 0 unconditionally.
        return { ...t, per_student_rate: newRate, discount_pct: 0 }
      }
      // Tier 2+: cascade. Stored discount_pct is unchanged; per_student_
      // rate recomputes against the new base.
      const discount = Number(t.discount_pct) || 0
      const computed = computePerStudentRateFromDiscount(newRate, discount) ?? 0
      return { ...t, per_student_rate: computed }
    })
    onChangeTierRates(next)
  }

  // Edit a tier 2+ discount_pct → recompute that tier's per_student_
  // rate from base × (1 − new discount/100). Other tiers unaffected.
  function handleSaveDiscount(tierSize, newDiscountPct) {
    setEditingTierDiscount(null)
    const next = tierRates.map((t) => {
      if (Number(t.tier_size) !== Number(tierSize)) return t
      const computed = computePerStudentRateFromDiscount(baseRate, newDiscountPct) ?? 0
      return { ...t, discount_pct: newDiscountPct, per_student_rate: computed }
    })
    onChangeTierRates(next)
  }

  function handleAddTier() {
    if (readOnly) return
    const nextSize = maxTierSize + 1
    onChangeTierRates([
      ...tierRates,
      {
        tier_size: nextSize,
        per_student_rate: baseRate,  // initially equals base since discount_pct = 0
        discount_pct: 0,
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
    if (Number(tierSize) === minTierSize) return  // Tier 1 (base) not removable

    const tierRow = tierRates.find((t) => Number(t.tier_size) === Number(tierSize))
    const distRow = familyDistribution.find((d) => Number(d.tier_size) === Number(tierSize))
    const hasNonZeroDiscount = tierRow && Number(tierRow.discount_pct) !== 0
    const hasNonZeroBreakdown = distRow && (
      Number(distRow.breakdown_pct) !== 0 || Number(distRow.family_count) !== 0
    )

    if (hasNonZeroDiscount || hasNonZeroBreakdown) {
      const ok = window.confirm(
        `Remove the ${tierSize}-student tier? It currently has ` +
        `${hasNonZeroDiscount ? `a discount of ${fmtDiscountPct(tierRow.discount_pct)}` : 'no discount'} and ` +
        `${hasNonZeroBreakdown ? 'a non-zero projected breakdown' : 'no projected breakdown'}. ` +
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
        Set the base per-student rate and the discount percentage for each
        higher tier. Per-student rates for tiers 2+ compute from the base rate
        and the tier discount. Editing the base rate cascades to all tier
        rates simultaneously.
      </p>

      <div className="px-2">
        {/* Column headers */}
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
          const discount = Number(tier.discount_pct) || 0
          const isHighest = tierSize === maxTierSize
          const isBase = tierSize === minTierSize

          // v3.8.9: editability flip. Base = rate editable, discount empty.
          //         Others = discount editable, rate read-only.
          const editingThisRate = isBase && editingBaseRate
          const editingThisDiscount = !isBase && editingTierDiscount === tierSize

          return (
            <div
              key={tier.tier_size}
              className="flex items-center gap-3 pr-3 py-1.5 border-b-[0.5px] border-card-border hover:bg-cream-highlight/40"
            >
              {/* Tier column. Tier 1 → BASE badge; others → numeric. */}
              <span className="w-12 flex-shrink-0 flex items-center">
                {isBase ? (
                  <span
                    className="inline-block bg-gold/15 font-display text-[10px] tracking-[0.12em] uppercase px-1.5 py-0.5 rounded"
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

              {/* Discount column.
                  - Base: empty cell (BASE badge in Tier column conveys meaning).
                  - Tiers 2+: editable input (or read-only display in non-drafting state). */}
              {isBase ? (
                <span className="font-body italic text-muted text-[12px] tabular-nums w-20 flex-shrink-0 text-right" />
              ) : readOnly ? (
                <span className="font-body italic text-muted text-[12px] tabular-nums w-20 flex-shrink-0 text-right">
                  {fmtDiscountPct(discount)}
                </span>
              ) : editingThisDiscount ? (
                <DiscountEditor
                  initial={discount}
                  onSave={(v) => handleSaveDiscount(tierSize, v)}
                  onCancel={() => setEditingTierDiscount(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingTierDiscount(tierSize)}
                  className="text-right tabular-nums px-2 py-1 rounded font-body text-[12px] w-20 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy/85"
                  aria-label={`Edit discount for ${tierLabel(tierSize, isHighest)}`}
                  title="Click to edit. Per-student rate recomputes from base × (1 − discount/100)."
                >
                  {fmtDiscountPct(discount)}
                </button>
              )}

              {/* Per-student rate column.
                  - Base: editable input (or read-only in non-drafting).
                  - Tiers 2+: read-only computed value (no input chrome). */}
              {isBase ? (
                readOnly ? (
                  <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
                    {fmtUsd(rate)}
                  </span>
                ) : editingThisRate ? (
                  <RateEditor
                    initial={rate}
                    onSave={handleSaveBaseRate}
                    onCancel={() => setEditingBaseRate(false)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditingBaseRate(true)}
                    className="text-right tabular-nums px-2 py-1 rounded font-body text-[13px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy/85"
                    aria-label={`Edit base per-student rate`}
                    title="Click to edit. Editing the base rate cascades to all tier 2+ rates."
                  >
                    {fmtUsd(rate)}
                  </button>
                )
              ) : (
                <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
                  {fmtUsd(rate)}
                </span>
              )}

              <span className="w-8 flex-shrink-0 flex items-center justify-end">
                {!readOnly && !isBase && (
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
      </div>
    </section>
  )
}

export default TierRatesSection
