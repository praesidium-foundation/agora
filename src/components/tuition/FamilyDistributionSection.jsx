import { useEffect, useMemo, useRef, useState } from 'react'
import {
  applyDerivedFamilyCounts,
  breakdownSum,
  computeTotalFamilies,
  deriveFamilyCount,
  impliedTotalStudents,
  topTierSize,
} from '../../lib/tuitionMath'

// Projected Family Distribution section — Stage 1 projection model
// (architecture §7.3, rewritten in v3.8.2 / B1.1).
//
// Reframe from B1: instead of "input family counts directly," the
// user enters total_students plus per-tier breakdown percentages, and
// total_families derives live from total_students ÷ weighted-avg-
// students-per-family. The user can override total_families if their
// projection is more specific than the derived value; an "↻" revert
// button next to total_families clears the override.
//
// Top-tier "X+" handling: a "4+" tier may include families with 4, 5,
// or more students. Below the breakdown table, a single
// "Average students per top-tier family" input refines the projection.
// Defaults to top tier_size when null in DB; minimum value is the top
// tier_size (DB validator enforces).
//
// All breakdown-pct edits buffer locally and only save when the
// resulting sum equals 100 ± 0.01. Until then, the indicator at the
// bottom shows "Breakdown sum: X% (must total 100%)" in alert color
// and the Estimated Families column reflects the in-flight breakdown
// against the current total_families. This buffering reconciles the
// strict DB validator with the on-blur-save editing model.
//
// Props:
//   distribution                       — array of { tier_size, breakdown_pct, family_count }
//   tierRates                          — array of { tier_size, ... }; source of truth for tier shape
//                                        (used for top-tier detection in the avg-students input)
//   totalStudents                      — number | null
//   totalFamilies                      — number | null  (stored override OR derived snapshot)
//   topTierAvgStudentsPerFamily        — number | null
//   onChangeTotalStudents               (next) => void
//   onChangeTotalFamilies               (next, isOverride: boolean) => void
//                                        — isOverride=false means "derived; clear any override"
//                                        — isOverride=true means "explicit override"
//                                        Page handler decides whether to persist or revert.
//   onChangeDistribution                (nextDistribution, opts?) => void
//                                        — opts.recompute = true to recompute family_count
//                                          from current total_families. Page handler
//                                          orchestrates the family_count derivation;
//                                          this section is presentational.
//   onChangeTopTierAvgStudentsPerFamily (next | null) => void
//                                        — null clears the override
//   readOnly                           — boolean

const int0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
function fmtInt(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  return int0.format(Number(n))
}

function parseInt0(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return null
  const cleaned = s.replace(/[,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error('Must be a non-negative whole number')
  }
  return n
}

function parsePct(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return 0
  const cleaned = s.replace(/[%\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error('Percentage must be between 0 and 100')
  }
  return n
}

function parseFloat0(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return null
  const cleaned = s.replace(/[,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('Must be a non-negative number')
  }
  return n
}

function tierLabel(tierSize, isHighest) {
  if (isHighest && tierSize > 1) return `${tierSize}+ students per family`
  if (tierSize === 1) return '1 student per family'
  return `${tierSize} students per family`
}

// Generic inline editor used by Total students, Total families, and
// the top-tier-avg input.
function ScalarEditor({ initial, parser, onSave, onCancel, ariaLabel, width = 'w-28' }) {
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
      onSave(parser(draft))
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
        className={`${width} text-right border-[0.5px] border-navy/40 px-2 py-1 rounded text-sm tabular-nums focus:outline-none focus:border-navy bg-white`}
        aria-label={ariaLabel}
      />
      {error && (
        <span className="text-status-red text-[11px] italic mt-0.5">
          {error}
        </span>
      )}
    </span>
  )
}

// Dedicated breakdown_pct editor — buffers locally; doesn't commit
// until the parent save handler is invoked (which only fires when sum
// = 100 ± 0.01 — see the local buffer logic in the section component).
function PctEditor({ initial, onSave, onCancel }) {
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
      onSave(parsePct(draft))
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
        aria-label="Breakdown percentage"
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
  distribution = [],
  tierRates = [],
  totalStudents,
  totalFamilies,
  topTierAvgStudentsPerFamily,
  onChangeTotalStudents,
  onChangeTotalFamilies,
  onChangeDistribution,
  onChangeTopTierAvgStudentsPerFamily,
  readOnly = false,
}) {
  const [editingField, setEditingField] = useState(null)        // 'total_students' | 'total_families' | 'top_tier_avg' | null
  const [editingTierPct, setEditingTierPct] = useState(null)    // tier_size of currently-edited row | null

  // Local buffer for breakdown_pct edits. Mirrors `distribution`
  // initially; user edits update this. When the sum is valid (100 ±
  // 0.01), the section pushes the buffer up via onChangeDistribution.
  // While invalid, the buffer stays local; the indicator below the
  // table reports the invalid sum.
  const [bufferedDist, setBufferedDist] = useState(distribution)

  // Reset buffer when the prop distribution changes from outside (e.g.,
  // a new scenario is selected). We compare references; if upstream
  // re-emits an identical object the buffer stays put.
  useEffect(() => {
    setBufferedDist(distribution)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distribution])

  // Sort by tier_size for predictable rendering. Apply local buffer on
  // top so display reflects in-flight edits.
  const rows = useMemo(
    () => [...bufferedDist].sort(
      (a, b) => Number(a.tier_size) - Number(b.tier_size)
    ),
    [bufferedDist]
  )

  const top = topTierSize(rows)
  const sumPct = breakdownSum(rows)
  const sumValid = Math.abs(sumPct - 100) <= 0.01 || sumPct === 0

  // Derived total_families when no override is active. Compared
  // against the prop value to detect override state — if the prop
  // differs from the computed value (and computed is non-null), the
  // user has overridden.
  const derivedFamilies = useMemo(
    () => computeTotalFamilies({
      totalStudents,
      distribution: rows,
      topTierAvgStudents: topTierAvgStudentsPerFamily,
    }),
    [totalStudents, rows, topTierAvgStudentsPerFamily]
  )

  const isOverride =
    totalFamilies != null
    && derivedFamilies != null
    && Number(totalFamilies) !== Number(derivedFamilies)

  // Implied total_students when total_families is overridden — round-
  // trip math for the reconciliation hint.
  const implied = useMemo(
    () => impliedTotalStudents({
      totalFamilies,
      distribution: rows,
      topTierAvgStudents: topTierAvgStudentsPerFamily,
    }),
    [totalFamilies, rows, topTierAvgStudentsPerFamily]
  )

  // Show implied-students reconciliation only when override active AND
  // implied differs from total_students.
  const showImpliedHint =
    isOverride
    && implied != null
    && totalStudents != null
    && Number(implied) !== Number(totalStudents)

  // Top-tier-average input visibility: render only when a top tier
  // exists AND its tier_size > 1 (the "X+" framing only applies for
  // tier 2+; a single-tier scenario has no "X+" row).
  const showTopTierAvg = top != null && top > 1

  // Effective top-tier-avg: prop value, OR fall back to top tier_size
  // for display purposes (the input shows the actual stored value or
  // empty; the help text and minimum reference top_tier_size).
  const topTierAvgEffective =
    topTierAvgStudentsPerFamily != null && Number.isFinite(Number(topTierAvgStudentsPerFamily))
      ? Number(topTierAvgStudentsPerFamily)
      : (top || 0)

  // ---- handlers -------------------------------------------------------

  function handleSaveTotalStudents(value) {
    setEditingField(null)
    onChangeTotalStudents(value)
  }

  function handleSaveTotalFamiliesOverride(value) {
    setEditingField(null)
    if (value == null) {
      // Empty input → revert to derived (clear override).
      onChangeTotalFamilies(derivedFamilies, false)
      return
    }
    // Explicit override.
    onChangeTotalFamilies(value, true)
  }

  function handleRevertTotalFamilies() {
    onChangeTotalFamilies(derivedFamilies, false)
  }

  function handleSaveTopTierAvg(value) {
    setEditingField(null)
    onChangeTopTierAvgStudentsPerFamily(value)
  }

  function handleSaveBreakdown(tierSize, newPct) {
    setEditingTierPct(null)
    const nextBuffer = bufferedDist.map((r) =>
      Number(r.tier_size) === Number(tierSize)
        ? { ...r, breakdown_pct: newPct }
        : r
    )
    setBufferedDist(nextBuffer)
    // Push up only when the sum is valid (100 ± 0.01) OR the user has
    // cleared everything to zero (sum = 0 — the "fresh" state). Buffer
    // stays local for invalid mid-entry sums; indicator shows the
    // problem to the user.
    const newSum = breakdownSum(nextBuffer)
    if (Math.abs(newSum - 100) <= 0.01 || newSum === 0) {
      onChangeDistribution(nextBuffer, { recompute: true })
    }
  }

  return (
    <section className="mb-8">
      <div className="flex items-center gap-3 px-2 py-3 border-b-2 border-gold/60 mb-2">
        <span className="font-display text-navy text-[17px] tracking-[0.08em] uppercase flex-1">
          Projected family distribution
        </span>
      </div>

      <p className="font-body italic text-muted text-[12px] mb-4 px-2 leading-relaxed">
        Project total enrollment for the academic year, then distribute across
        family sizes. Family counts derive from the breakdown; override Total
        families if you have a more specific projection.
      </p>

      <div className="px-2">
        {/* ---- Top inputs ---- */}
        <div className="space-y-2 mb-4 pb-4 border-b-[0.5px] border-card-border/60">
          {/* Total students */}
          <div className="flex items-center gap-3 pr-3 py-1.5">
            <span className="font-body text-[13px] text-navy/85 flex-1 min-w-0">
              Total students
            </span>
            {readOnly ? (
              <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
                {fmtInt(totalStudents)}
              </span>
            ) : editingField === 'total_students' ? (
              <ScalarEditor
                initial={totalStudents}
                parser={parseInt0}
                onSave={handleSaveTotalStudents}
                onCancel={() => setEditingField(null)}
                ariaLabel="Total students"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingField('total_students')}
                className="text-right tabular-nums px-2 py-1 rounded font-body text-[13px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy/85"
                aria-label="Edit total students"
                title="Click to edit"
              >
                {fmtInt(totalStudents)}
              </button>
            )}
          </div>

          {/* Total families — derived OR overridden */}
          <div className="flex items-center gap-3 pr-3 py-1.5">
            <div className="flex-1 min-w-0">
              <p className="font-body text-[13px] text-navy/85">
                Total families
                {isOverride && (
                  <span className="ml-2 font-body italic text-muted text-[11px]">
                    (overridden)
                  </span>
                )}
              </p>
              {!isOverride && derivedFamilies != null && (
                <p className="font-body italic text-muted text-[11px] mt-0.5">
                  Derived from Total students ÷ weighted-avg students per family.
                </p>
              )}
            </div>

            {/* Revert button — visible only when override is active and
                there is a derived value to revert to. */}
            {!readOnly && isOverride && derivedFamilies != null && (
              <button
                type="button"
                onClick={handleRevertTotalFamilies}
                aria-label="Revert to derived value"
                title={`Revert to derived value (${fmtInt(derivedFamilies)})`}
                className="text-muted hover:text-navy text-[13px] leading-none px-2 py-1 rounded hover:bg-cream-highlight transition-colors"
              >
                ↻
              </button>
            )}

            {readOnly ? (
              <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
                {fmtInt(totalFamilies ?? derivedFamilies)}
              </span>
            ) : editingField === 'total_families' ? (
              <ScalarEditor
                initial={totalFamilies ?? derivedFamilies}
                parser={parseInt0}
                onSave={handleSaveTotalFamiliesOverride}
                onCancel={() => setEditingField(null)}
                ariaLabel="Total families"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingField('total_families')}
                className="text-right tabular-nums px-2 py-1 rounded font-body text-[13px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy/85"
                aria-label="Edit total families"
                title={isOverride ? 'Edit override value' : 'Override the derived value'}
              >
                {fmtInt(totalFamilies ?? derivedFamilies)}
              </button>
            )}
          </div>

          {showImpliedHint && (
            <p className="font-body italic text-muted text-[11px] pr-3 text-right">
              Implied students: {fmtInt(implied)} (entered: {fmtInt(totalStudents)})
            </p>
          )}
        </div>

        {/* ---- Breakdown table ---- */}
        <div className="flex items-center gap-3 pr-3 py-1.5 border-b-[0.5px] border-card-border/60">
          <span className="font-body font-medium text-navy text-[12px] tracking-wider uppercase flex-1 min-w-0">
            Tier size
          </span>
          <span className="font-body font-medium text-navy text-[12px] tracking-wider uppercase w-20 flex-shrink-0 text-right">
            Breakdown
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
          const pct = Number(row.breakdown_pct) || 0
          const isHighest = tierSize === top
          const editing = editingTierPct === tierSize
          // Compute family count for display from the buffered breakdown
          // and the (possibly-overridden) total_families. When
          // total_families is null, render em-dash.
          const families = totalFamilies != null
            ? deriveFamilyCount(totalFamilies, pct)
            : null

          return (
            <div
              key={row.tier_size}
              className="flex items-center gap-3 pr-3 py-1.5 border-b-[0.5px] border-card-border hover:bg-cream-highlight/40"
            >
              <span className="font-body text-[13px] text-navy/85 flex-1 min-w-0 truncate">
                {tierLabel(tierSize, isHighest)}
              </span>

              {/* Breakdown column — % input. */}
              {readOnly ? (
                <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-20 flex-shrink-0 text-navy/85">
                  {pct.toFixed(2)}%
                </span>
              ) : editing ? (
                <PctEditor
                  initial={pct}
                  onSave={(v) => handleSaveBreakdown(tierSize, v)}
                  onCancel={() => setEditingTierPct(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingTierPct(tierSize)}
                  className="text-right tabular-nums px-2 py-1 rounded font-body text-[13px] w-20 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy/85"
                  aria-label={`Edit breakdown for ${tierLabel(tierSize, isHighest)}`}
                  title="Click to edit"
                >
                  {pct.toFixed(2)}%
                </button>
              )}

              {/* Estimated Families — read-only computed cell. */}
              <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
                {fmtInt(families)}
              </span>
            </div>
          )
        })}

        {/* Breakdown sum indicator — alert color when sum != 100 (and
            non-zero); muted when valid (100) or fresh (0). */}
        {rows.length > 0 && (
          <p
            className={`font-body italic text-[11px] mt-2 pr-3 text-right ${
              sumValid ? 'text-muted' : 'text-status-amber'
            }`}
          >
            {sumPct === 0
              ? 'Breakdown sum: —'
              : sumValid
                ? `Breakdown sum: ${sumPct.toFixed(2)}%`
                : `Breakdown sum: ${sumPct.toFixed(2)}% (must total 100%)`}
          </p>
        )}

        {/* ---- Top-tier average input ---- */}
        {showTopTierAvg && (
          <div className="mt-5 pt-4 border-t-[0.5px] border-card-border/60">
            <div className="flex items-center gap-3 pr-3 py-1.5">
              <div className="flex-1 min-w-0">
                <p className="font-body text-[13px] text-navy/85">
                  Average students per top-tier family
                </p>
                <p className="font-body italic text-muted text-[11px] mt-0.5 leading-relaxed">
                  When the top tier represents &ldquo;{top}+ students,&rdquo; some families
                  may have {top + 1} or more students. Set the average to refine
                  the projection. Stage 2 audit captures exact counts. Defaults
                  to {top} when blank.
                </p>
              </div>
              {readOnly ? (
                <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
                  {topTierAvgStudentsPerFamily != null
                    ? Number(topTierAvgStudentsPerFamily).toFixed(2)
                    : '—'}
                </span>
              ) : editingField === 'top_tier_avg' ? (
                <ScalarEditor
                  initial={topTierAvgStudentsPerFamily}
                  parser={parseFloat0}
                  onSave={handleSaveTopTierAvg}
                  onCancel={() => setEditingField(null)}
                  ariaLabel="Average students per top-tier family"
                  width="w-32"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingField('top_tier_avg')}
                  className="text-right tabular-nums px-2 py-1 rounded font-body text-[13px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy/85"
                  aria-label="Edit average students per top-tier family"
                  title={`Click to edit. Minimum is ${top}.`}
                >
                  {topTierAvgStudentsPerFamily != null
                    ? Number(topTierAvgStudentsPerFamily).toFixed(2)
                    : `${top} (default)`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default FamilyDistributionSection
