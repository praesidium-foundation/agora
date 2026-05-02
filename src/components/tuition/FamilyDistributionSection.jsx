import { useEffect, useRef, useState } from 'react'

// Projected Family Distribution section — Stage 1 projection input.
// Drives break-even enrollment math (Tuition-C) and the projected-
// gross stat in B1.
//
// Per architecture §7.3, the tier shape is owned by Tier Rates; this
// section's rows are derived 1:1 from `tierRates`. Adding or removing
// a tier is done in TierRatesSection — that component keeps the two
// arrays in sync. This section renders one row per tier_size and the
// row labels match the tier_rates view ("X+ students" for the highest
// tier).
//
// Computed totals:
//   Total families = Σ family_count
//   Total students = Σ (tier_size × family_count)  (highest "X+" tier
//                     treated as exactly X for B1; refined in
//                     Tuition-C if break-even math needs it).
//
// Props:
//   familyDistribution     — array of { tier_size, family_count }
//   tierRates              — array of { tier_size, ... }; used to
//                             derive the highest tier_size for the
//                             "X+" label rendering. Source of truth
//                             for tier shape.
//   onChange                (next) => void
//   readOnly               boolean

const int0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
function fmtInt(n) { return int0.format(Number(n) || 0) }

function parseCount(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return 0
  const cleaned = s.replace(/[,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error('Family count must be a non-negative whole number')
  }
  return n
}

function tierLabel(tierSize, isHighest) {
  if (isHighest && tierSize > 1) return `${tierSize}+ students per family`
  if (tierSize === 1) return '1 student per family'
  return `${tierSize} students per family`
}

function CountEditor({ initial, onSave, onCancel }) {
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
      onSave(parseCount(draft))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
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
        className="w-28 text-right border-[0.5px] border-navy/40 px-2 py-1 rounded text-sm tabular-nums focus:outline-none focus:border-navy bg-white"
        aria-label="Family count"
      />
      {error && (
        <span className="text-status-red text-[11px] italic mt-0.5">
          {error}
        </span>
      )}
    </span>
  )
}

function FamilyDistributionSection({
  familyDistribution = [],
  tierRates = [],
  onChange,
  readOnly = false,
}) {
  const [editingTierSize, setEditingTierSize] = useState(null)

  // Derive max tier_size from tier_rates (the source of truth for
  // tier shape). When tier_rates is added/removed, family_distribution
  // is kept in sync by TierRatesSection.
  const maxTierSize = tierRates.length > 0
    ? Math.max(...tierRates.map((t) => Number(t.tier_size) || 0))
    : 0

  // Sort by tier_size for predictable rendering.
  const rows = [...familyDistribution].sort(
    (a, b) => Number(a.tier_size) - Number(b.tier_size)
  )

  const totalFamilies = rows.reduce(
    (sum, r) => sum + (Number(r.family_count) || 0),
    0
  )
  const totalStudents = rows.reduce(
    (sum, r) => sum + (Number(r.tier_size) || 0) * (Number(r.family_count) || 0),
    0
  )

  function handleSaveCount(tierSize, newCount) {
    const next = familyDistribution.map((r) =>
      Number(r.tier_size) === Number(tierSize)
        ? { ...r, family_count: newCount }
        : r
    )
    onChange(next)
    setEditingTierSize(null)
  }

  return (
    <section className="mb-8">
      {/* Tier 1 section header */}
      <div className="flex items-center gap-3 px-2 py-3 border-b-2 border-gold/60 mb-2">
        <span className="font-display text-navy text-[17px] tracking-[0.08em] uppercase flex-1">
          Projected family distribution
        </span>
      </div>

      <p className="font-body italic text-muted text-[12px] mb-3 px-2">
        Estimated number of families at each tier size. Drives projected gross
        revenue, projected discount totals, and the break-even enrollment KPI
        (when computed in Tuition-C).
      </p>

      <div className="px-2">
        {/* Column headers */}
        <div className="flex items-center gap-3 pr-3 py-1.5 border-b-[0.5px] border-card-border/60">
          <span className="font-body font-medium text-navy text-[12px] tracking-wider uppercase flex-1 min-w-0">
            Tier size
          </span>
          <span className="font-body font-medium text-navy text-[12px] tracking-wider uppercase w-32 flex-shrink-0 text-right">
            Estimated families
          </span>
        </div>

        {rows.length === 0 && (
          <p className="font-body italic text-muted text-sm py-3">
            No tiers defined yet. Add tiers in the Tier rates section above.
          </p>
        )}

        {rows.map((row) => {
          const tierSize = Number(row.tier_size)
          const count = Number(row.family_count) || 0
          const isHighest = tierSize === maxTierSize
          const editing = editingTierSize === tierSize

          return (
            <div
              key={row.tier_size}
              className="flex items-center gap-3 pr-3 py-1.5 border-b-[0.5px] border-card-border hover:bg-cream-highlight/40"
            >
              <span className="font-body text-[13px] text-navy/85 flex-1 min-w-0 truncate">
                {tierLabel(tierSize, isHighest)}
              </span>

              {readOnly ? (
                <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
                  {fmtInt(count)}
                </span>
              ) : editing ? (
                <CountEditor
                  initial={count}
                  onSave={(v) => handleSaveCount(tierSize, v)}
                  onCancel={() => setEditingTierSize(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingTierSize(tierSize)}
                  className="text-right tabular-nums px-2 py-1 rounded font-body text-[13px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy/85"
                  aria-label={`Edit family count for ${tierLabel(tierSize, isHighest)}`}
                  title="Click to edit"
                >
                  {fmtInt(count)}
                </button>
              )}
            </div>
          )
        })}

        {/* Totals — Tier 2 weight (medium navy 13.5px), thin navy
            border-bottom for the running total. Read-only by definition;
            no input chrome. */}
        <div className="flex items-center gap-3 pr-3 py-2 pt-3 border-b-[0.5px] border-navy/25 bg-cream-highlight/30">
          <span className="font-body font-semibold text-navy text-[13.5px] flex-1 min-w-0">
            Total families
          </span>
          <span className="text-right tabular-nums font-body font-semibold text-[13.5px] w-32 flex-shrink-0 text-navy">
            {fmtInt(totalFamilies)}
          </span>
        </div>
        <div className="flex items-center gap-3 pr-3 py-2 border-b-[0.5px] border-navy/25 bg-cream-highlight/30">
          <span className="font-body font-semibold text-navy text-[13.5px] flex-1 min-w-0">
            Total students
          </span>
          <span className="text-right tabular-nums font-body font-semibold text-[13.5px] w-32 flex-shrink-0 text-navy">
            {fmtInt(totalStudents)}
          </span>
        </div>
      </div>
    </section>
  )
}

export default FamilyDistributionSection
