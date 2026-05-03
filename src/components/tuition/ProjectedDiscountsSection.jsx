import { useEffect, useRef, useState } from 'react'
import {
  computeProjectedMultiStudentDiscount,
  sumTotalProjectedDiscounts,
} from '../../lib/tuitionMath'
import { formatCurrency } from '../../lib/format'

// Projected Discounts section — all four discount mechanisms in the
// layered taxonomy (architecture §7.3 "Stage 1 revenue vocabulary").
//
//   Multi-Student Discount — Stage 1: computed from tier math
//                            (Projected Gross Tuition − tier-blended
//                            tuition). Stage 2 audit captures the
//                            actual realized discount per family.
//                            Read-only at Stage 1.
//   Faculty Discount        — projected total dollar value of faculty
//                            children's discounts. User-entered.
//   Other Discounts         — board-granted budget for ad-hoc tuition
//                            awards. User-entered.
//   Financial Aid           — committee-managed budget for FA awards.
//                            User-entered.
//
// v3.8.4 (B1.3) restructure consolidates all four discount streams
// here. Multi-Student moved from the foot of TierRatesSection (its
// brief B1.2 placement) to be the first row of this section, restoring
// the architectural intent that all four streams render together.
// Section foot adds a "Total Projected Discounts" subtotal row
// matching the sidebar stat of the same name.
//
// Accounting parentheses convention (§10.4 v3.8.4 addendum): every
// discount value, the section subtotal, and any negative currency
// value renders as ($X,XXX). Editable input fields show parens in
// display state; on focus the input reverts to a plain numeric
// editable string.
//
// Visual hierarchy: Tier 1 section header (Cinzel 17px navy with gold
// border-bottom). Four discount rows + subtotal row below.
//
// Props:
//   scenario                                — full scenario object (used
//                                              for Multi-Student and
//                                              Total subtotal computation;
//                                              individual editable values
//                                              are still passed via the
//                                              named props below for
//                                              parity with the existing
//                                              edit handlers)
//   projectedFacultyDiscountAmount          numeric
//   projectedOtherDiscount                  numeric
//   projectedFinancialAid                   numeric
//   onChangeProjectedFacultyDiscountAmount  (next) => void
//   onChangeProjectedOtherDiscount          (next) => void
//   onChangeProjectedFinancialAid           (next) => void
//   readOnly                                boolean

function parseCurrency(raw) {
  // Tolerant parsing: accepts $/comma/space/parens, returns positive
  // number. Parens around input (e.g., "(1000)") are stripped
  // silently — the user may copy-paste from spreadsheets that use
  // parens for display.
  const s = String(raw ?? '').trim()
  if (s === '') return 0
  const cleaned = s.replace(/[$,()\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('Amount must be a non-negative number')
  }
  return n
}

function ValueEditor({ initial, onSave, onCancel, ariaLabel }) {
  // Editor shows raw numeric value (no $, no commas, no parens) on
  // focus per the universal direct-edit-with-undo pattern. On blur
  // or Enter, the parent re-renders the display button with the
  // formatted (parenthesized) value.
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

// Editable discount row — Faculty / Other / FA. Display value renders
// in parens regardless of sign (subtractive: true) per §10.4.
function EditableDiscountRow({ label, hint, value, fieldKey, editingKey, setEditing, onSave, readOnly }) {
  const editing = editingKey === fieldKey
  const display = formatCurrency(value, { subtractive: true })
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

// Read-only Multi-Student row. No input chrome; standard row
// typography matching the editable rows so the four discount streams
// read as peers.
function MultiStudentRow({ value }) {
  const display = formatCurrency(value, { subtractive: true })
  return (
    <div className="flex items-center gap-3 pr-3 py-2 border-b-[0.5px] border-card-border hover:bg-cream-highlight/40">
      <div className="flex-1 min-w-0">
        <p className="font-body text-[13px] text-navy/85">
          Projected Multi-Student Discount
        </p>
        <p className="font-body italic text-muted text-[11px] mt-0.5">
          Computed from tier math. Stage 2 audit captures the actual
          realized discount per family.
        </p>
      </div>
      <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
        {display}
      </span>
    </div>
  )
}

function ProjectedDiscountsSection({
  scenario,
  projectedFacultyDiscountAmount,
  projectedOtherDiscount,
  projectedFinancialAid,
  onChangeProjectedFacultyDiscountAmount,
  onChangeProjectedOtherDiscount,
  onChangeProjectedFinancialAid,
  readOnly = false,
}) {
  const [editing, setEditing] = useState(null)

  const multiStudent = scenario ? computeProjectedMultiStudentDiscount(scenario) : null
  const total = scenario ? sumTotalProjectedDiscounts(scenario) : null

  return (
    <section className="mb-8">
      <div className="flex items-center gap-3 px-2 py-3 border-b-2 border-gold/60 mb-2">
        <span className="font-display text-navy text-[17px] tracking-[0.08em] uppercase flex-1">
          Projected discounts
        </span>
      </div>

      <p className="font-body italic text-muted text-[12px] mb-3 px-2 leading-relaxed">
        All four discount mechanisms in the layered taxonomy. Multi-Student
        is computed from tier math; the other three are user-entered envelope
        estimates. Per-family allocation of Faculty / Other / Financial Aid
        awards happens in Stage 2 (Tuition Audit).
      </p>

      <div className="px-2">
        <MultiStudentRow value={multiStudent} />

        <EditableDiscountRow
          label="Faculty Discount"
          hint="Projected total dollar value of faculty children's discounts. Estimate based on current staff plus expected new hires; actuals reconcile in Tuition Audit (Stage 2)."
          value={projectedFacultyDiscountAmount}
          fieldKey="faculty_amount"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeProjectedFacultyDiscountAmount}
          readOnly={readOnly}
        />
        <EditableDiscountRow
          label="Other Discounts"
          hint="Board-granted budget for ad-hoc tuition awards. Per-family allocation happens in Tuition Audit (Stage 2)."
          value={projectedOtherDiscount}
          fieldKey="other"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeProjectedOtherDiscount}
          readOnly={readOnly}
        />
        <EditableDiscountRow
          label="Financial Aid"
          hint="Committee-managed budget for Financial Aid awards. Per-family allocation happens in Tuition Audit (Stage 2)."
          value={projectedFinancialAid}
          fieldKey="financial_aid"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeProjectedFinancialAid}
          readOnly={readOnly}
        />

        {/* Section subtotal — bold, navy@25 thin top rule, parens display.
            Mirrors the sidebar's Total Projected Discounts stat. */}
        <div className="mt-3 pt-3 border-t-[0.5px] border-navy/25">
          <div className="flex items-center gap-3 pr-3 py-2">
            <span className="font-body font-semibold text-navy text-[13.5px] flex-1 min-w-0">
              Total Projected Discounts
            </span>
            <span className="text-right tabular-nums font-body font-semibold text-[13.5px] w-32 flex-shrink-0 text-navy">
              {formatCurrency(total, { subtractive: true })}
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}

export default ProjectedDiscountsSection
