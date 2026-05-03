import { useEffect, useRef, useState } from 'react'

// Projected Discounts section — three of the four discount mechanisms
// in the layered taxonomy (architecture §7.3). The multi-student tier
// discount is implicit in the tier rates (handled by TierRatesSection);
// these three are the explicit projected $ amounts:
//
//   Faculty Discount   — projected total dollar value of faculty
//                        children's discounts. Estimate based on
//                        current staff plus expected new hires;
//                        actuals reconcile in Tuition Audit (Stage 2).
//   Other Discounts    — board-granted budget for ad-hoc tuition
//                        awards. Per-family allocation in Stage 2.
//   Financial Aid      — committee-managed budget for FA awards.
//                        Per-family allocation in Stage 2.
//
// v3.8.2 (B1.1): the Faculty row is a $ input only (not %). The
// existing faculty_discount_pct column persists in schema (needed
// for Stage 2 per-family allocation math) but does NOT render in the
// Stage 1 UI. Help text on the Faculty row clarifies the distinction.
//
// File renamed from DiscountEnvelopesSection.jsx in v3.8.2; sub-row
// labels updated ("Other discount envelope" → "Other Discounts";
// "Financial Aid envelope" → "Financial Aid"). Field maps:
//   projected_faculty_discount_amount  (new column from Migration 027)
//   projected_other_discount           (renamed from other_discount_envelope)
//   projected_financial_aid            (renamed from financial_aid_envelope)
//
// Visual hierarchy: Tier 1 section header (Cinzel 17px navy with gold
// border-bottom). Three rows below as Tier 4-equivalent leaf rows.
//
// Props:
//   projectedFacultyDiscountAmount         numeric
//   projectedOtherDiscount                 numeric
//   projectedFinancialAid                  numeric
//   onChangeProjectedFacultyDiscountAmount (next) => void
//   onChangeProjectedOtherDiscount         (next) => void
//   onChangeProjectedFinancialAid          (next) => void
//   readOnly                               boolean

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function fmtUsd(n) {
  return usd0.format(Number(n) || 0)
}

function parseCurrency(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return 0
  const cleaned = s.replace(/[$,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('Amount must be a non-negative number')
  }
  return n
}

function ValueEditor({ initial, onSave, onCancel, ariaLabel }) {
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
      onSave(parseCurrency(draft))
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

function DiscountRow({ label, hint, value, fieldKey, editingKey, setEditing, onSave, readOnly }) {
  const editing = editingKey === fieldKey
  const display = fmtUsd(value)
  return (
    <div className="flex items-center gap-3 pr-3 py-2 border-b-[0.5px] border-card-border hover:bg-cream-highlight/40">
      <div className="flex-1 min-w-0">
        <p className="font-body text-[13px] text-navy/85">{label}</p>
        {hint && (
          <p className="font-body italic text-muted text-[11px] mt-0.5">{hint}</p>
        )}
      </div>
      {readOnly ? (
        <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
          {display}
        </span>
      ) : editing ? (
        <ValueEditor
          initial={Number(value) || 0}
          onSave={(v) => { onSave(v); setEditing(null) }}
          onCancel={() => setEditing(null)}
          ariaLabel={label}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(fieldKey)}
          className="text-right tabular-nums px-2 py-1 rounded font-body text-[13px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy/85"
          aria-label={`Edit ${label}`}
          title="Click to edit"
        >
          {display}
        </button>
      )}
    </div>
  )
}

function ProjectedDiscountsSection({
  projectedFacultyDiscountAmount,
  projectedOtherDiscount,
  projectedFinancialAid,
  onChangeProjectedFacultyDiscountAmount,
  onChangeProjectedOtherDiscount,
  onChangeProjectedFinancialAid,
  readOnly = false,
}) {
  const [editing, setEditing] = useState(null)

  return (
    <section className="mb-8">
      <div className="flex items-center gap-3 px-2 py-3 border-b-2 border-gold/60 mb-2">
        <span className="font-display text-navy text-[17px] tracking-[0.08em] uppercase flex-1">
          Projected discounts
        </span>
      </div>

      <p className="font-body italic text-muted text-[12px] mb-3 px-2">
        Three of the four discount mechanisms in the layered taxonomy. The
        multi-student tier discount is configured implicitly through the tier
        rates above. Per-family allocation of Faculty / Other / Financial Aid
        awards happens in Stage 2 (Tuition Audit).
      </p>

      <div className="px-2">
        <DiscountRow
          label="Faculty Discount"
          hint="Projected total dollar value of faculty children's discounts. Estimate based on current staff plus expected new hires; actuals reconcile in Tuition Audit (Stage 2)."
          value={projectedFacultyDiscountAmount}
          fieldKey="faculty_amount"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeProjectedFacultyDiscountAmount}
          readOnly={readOnly}
        />
        <DiscountRow
          label="Other Discounts"
          hint="Board-granted budget for ad-hoc tuition awards. Per-family allocation happens in Tuition Audit (Stage 2)."
          value={projectedOtherDiscount}
          fieldKey="other"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeProjectedOtherDiscount}
          readOnly={readOnly}
        />
        <DiscountRow
          label="Financial Aid"
          hint="Committee-managed budget for Financial Aid awards. Per-family allocation happens in Tuition Audit (Stage 2)."
          value={projectedFinancialAid}
          fieldKey="financial_aid"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeProjectedFinancialAid}
          readOnly={readOnly}
        />
      </div>
    </section>
  )
}

export default ProjectedDiscountsSection
