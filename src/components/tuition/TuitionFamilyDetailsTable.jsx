import { useEffect, useState } from 'react'
import {
  computeFamilyAppliedTierRate,
  computeFamilyFacultyDiscountAuto,
  computeFamilyMultiStudentDiscount,
  computeFamilyNetTuition,
  isFamilyFacultyDiscountOverridden,
  isFamilyTierRateOverridden,
  naturalAppliedTierRate,
  naturalAppliedTierSize,
} from '../../lib/tuitionMath'
import { formatCurrency, formatInteger } from '../../lib/format'
import TuitionFamilyHistoryModal from './TuitionFamilyHistoryModal'

// Per-family editor table for Tuition Stage 2 (Tuition Audit).
//
// v3.8.16 (Tuition-B2-final) redesign — column ordering, sticky
// header, vertical group dividers, inline-adjacent gold-dot override
// indicator, # row-number column, # Enrolled without spinner arrows.
// The 15-column layout matches Libertas's legacy audit Google Sheet
// for continuity with the operator's existing mental model.
//
// Column order (matches the v3 mockup):
//
//   1. #                          (row number, computed from sort position)
//   2. Family Name                (text input)
//   3. Faculty                    (checkbox toggle)
//   4. # Enr.                     (integer input, no spinner)
//                                 ─── Identity group divider ───
//   5. Base Tuition               (computed)
//   6. Multiple Student Disc.     (computed; $0 for faculty)
//   7. Net Tuition Rate           (computed; gold-dot if overridden)
//   8. Subtotal for Year          (computed)
//                                 ─── Computed group divider ───
//   9. Faculty Discount           (editable; gold-dot if overridden;
//                                  faculty families only)
//  10. Other Discount             (editable currency)
//  11. Financial Aid Amount       (editable currency)
//                                 ─── Discount allocations divider ───
//  12. NET Tuition for YEAR       (computed; emphasized)
//                                 ─── Result divider ───
//  13. Date Enrolled              (date input)
//  14. Notes                      (textarea, flex)
//  15. Date Withdrawn             (date input; null shows em-dash)
//
//  + row-actions (history clock + delete; no header label)
//
// Sort is controlled by the parent (TuitionAuditPage) via the Sort By
// dropdown. The table receives `families` already in display order
// and renders them as-is. New rows from + Add Family append to the
// END of the current order until the user explicitly re-sorts; the
// table does not re-sort on data entry.
//
// Faculty discount rule (architecture §7.3 + Appendix C v3.8.14):
// Faculty discount REPLACES multi-student tier discount. Toggling
// is_faculty_family true cascades applied_tier_size = 1, applied_
// tier_rate = base_rate, and faculty_discount_amount auto-populates
// from base × students × pct. Manual overrides persist with a small
// gold dot rendered INLINE-ADJACENT to the cell value (not corner-
// absolute) — format: "● ($X,XXX)" with the dot in brand gold and
// the value in the cell's normal color. Hover tooltip shows the
// auto-computed value.
//
// Read-only state (scenario.state !== 'drafting'): all editable cells
// render as plain text without input chrome. Notes textarea becomes
// wrapped plain text. is_faculty_family toggle becomes a small
// "Faculty" badge when true. Add Family affordance hidden by parent.
// Clock icons for per-row history hide. Gold dots remain visible.
//
// Props:
//   families     — array of tuition_worksheet_family_details rows in
//                  display order (parent applies the sort)
//   scenario     — active Stage 2 scenario row
//   readOnly     — bool; when true, no input chrome anywhere
//   onUpdateRow  — (familyId, patchObj) => Promise<boolean>
//   onDeleteRow  — (familyId) => Promise<void>

export default function TuitionFamilyDetailsTable({
  families,
  scenario,
  readOnly,
  onUpdateRow,
  onDeleteRow,
}) {
  const [historyFor, setHistoryFor] = useState(null)

  // Save cascades — invoked by row controls. Each computes the patch
  // object and forwards to onUpdateRow.

  async function handleToggleFaculty(family, nextValue) {
    if (readOnly) return
    const patch = { is_faculty_family: nextValue }
    if (nextValue) {
      patch.applied_tier_size = 1
      patch.applied_tier_rate = baseRateOf(scenario)
      patch.faculty_discount_amount = computeFamilyFacultyDiscountAuto(
        { ...family, is_faculty_family: true },
        scenario,
      )
    } else {
      patch.applied_tier_size = naturalAppliedTierSize(
        { ...family, is_faculty_family: false },
        scenario,
      )
      patch.applied_tier_rate = naturalAppliedTierRate(
        { ...family, is_faculty_family: false },
        scenario,
      )
      patch.faculty_discount_amount = null
    }
    await onUpdateRow(family.id, patch)
  }

  async function handleEnrolledChange(family, nextValue) {
    if (readOnly) return
    const patch = { students_enrolled: nextValue }
    const next = { ...family, students_enrolled: nextValue }
    if (family.is_faculty_family) {
      const overridden = isFamilyFacultyDiscountOverridden(family, scenario)
      if (!overridden) {
        patch.faculty_discount_amount = computeFamilyFacultyDiscountAuto(next, scenario)
      }
    } else {
      const overridden = isFamilyTierRateOverridden(family, scenario)
      if (!overridden) {
        patch.applied_tier_size = naturalAppliedTierSize(next, scenario)
        patch.applied_tier_rate = naturalAppliedTierRate(next, scenario)
      }
    }
    await onUpdateRow(family.id, patch)
  }

  async function handleFieldSave(familyId, field, value) {
    if (readOnly) return
    await onUpdateRow(familyId, { [field]: value })
  }

  return (
    <div className="w-full">
      <div className="overflow-x-auto overflow-y-auto bg-white border-[0.5px] border-card-border rounded-[6px] max-h-[calc(100vh-22rem)] tuition-audit-table-wrapper">
        <table className="w-full text-[12px] font-body border-collapse">
          <thead className="sticky top-0 z-10 bg-cream-highlight/80 backdrop-blur">
            <tr className="border-b-[0.5px] border-card-border">
              {/* All headers center-aligned (Th component centers by
                  default in v3.8.17). Font weight uniform across all
                  columns — the bottom-line emphasis for NET Tuition
                  for YEAR lives on the body cell, not the header. */}
              <Th className="w-[32px]">#</Th>
              <Th className="min-w-[130px]">Family<br />Name</Th>
              <Th className="w-[60px]">Faculty</Th>
              <Th className="w-[50px] groupEnd"># Enr.</Th>
              <Th className="w-[92px]">Base<br />Tuition</Th>
              <Th className="w-[100px]">Multiple<br />Student Disc.</Th>
              <Th className="w-[100px]">Net<br />Tuition Rate</Th>
              <Th className="w-[105px] groupEnd">Subtotal<br />for Year</Th>
              <Th className="w-[105px]">Faculty<br />Discount</Th>
              <Th className="w-[100px]">Other<br />Discount</Th>
              <Th className="w-[105px] groupEnd">Financial<br />Aid Amount</Th>
              <Th className="w-[115px] groupEnd">NET Tuition<br />for YEAR</Th>
              <Th className="w-[88px]">Date<br />Enrolled</Th>
              <Th className="min-w-[180px]">Notes</Th>
              <Th className="w-[88px]">Date<br />Withdrawn</Th>
              <Th className="w-[28px]" aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {(!Array.isArray(families) || families.length === 0) ? (
              <tr>
                <td colSpan={16} className="px-3 py-6 text-muted italic text-center">
                  No families recorded yet. Use “+ Add Family” below to begin.
                </td>
              </tr>
            ) : (
              families.map((family, idx) => (
                <FamilyRow
                  key={family.id}
                  rowNumber={idx + 1}
                  family={family}
                  scenario={scenario}
                  readOnly={readOnly}
                  zebra={idx % 2 === 1}
                  onToggleFaculty={handleToggleFaculty}
                  onEnrolledChange={handleEnrolledChange}
                  onFieldSave={handleFieldSave}
                  onOpenHistory={() =>
                    setHistoryFor({
                      familyId: family.id,
                      familyLabel: family.family_label || '(unnamed family)',
                    })
                  }
                  onDelete={() => onDeleteRow?.(family.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {historyFor && (
        <TuitionFamilyHistoryModal
          familyId={historyFor.familyId}
          familyLabel={historyFor.familyLabel}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </div>
  )
}

// ----- Row component ---------------------------------------------------

function FamilyRow({
  rowNumber, family, scenario, readOnly, zebra,
  onToggleFaculty, onEnrolledChange, onFieldSave,
  onOpenHistory, onDelete,
}) {
  const baseRate = baseRateOf(scenario)
  const students = Number(family.students_enrolled) || 0

  const baseTuition = baseRate > 0 && students > 0 ? baseRate * students : null
  const multiStudent = computeFamilyMultiStudentDiscount(family, scenario)
  const netRate = computeFamilyAppliedTierRate(family, scenario)
  const subtotal = netRate != null && students > 0 ? netRate * students : null
  const netForYear = computeFamilyNetTuition(family, scenario)
  const facultyAuto = computeFamilyFacultyDiscountAuto(family, scenario)
  const facultyOverridden = isFamilyFacultyDiscountOverridden(family, scenario)
  const tierOverridden = isFamilyTierRateOverridden(family, scenario)

  const rowBg = zebra ? 'bg-cream-highlight/15' : 'bg-white'

  return (
    <tr className={`border-b-[0.5px] border-card-border/40 ${rowBg} hover:bg-cream-highlight/40 transition-colors`}>
      {/* # row number */}
      <Td className="text-center text-muted tabular-nums">
        {rowNumber}
      </Td>

      {/* Family Name */}
      <Td>
        <TextCell
          value={family.family_label || ''}
          readOnly={readOnly}
          maxLength={80}
          onSave={(v) => onFieldSave(family.id, 'family_label', v.trim())}
          placeholder="Family name…"
        />
      </Td>

      {/* Faculty */}
      <Td className="text-center">
        {readOnly ? (
          family.is_faculty_family ? (
            <span className="inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-gold border-[0.5px] border-gold/40 rounded">
              Faculty
            </span>
          ) : null
        ) : (
          <input
            type="checkbox"
            checked={!!family.is_faculty_family}
            onChange={(e) => onToggleFaculty(family, e.target.checked)}
            aria-label="Faculty family"
            className="accent-navy cursor-pointer"
          />
        )}
      </Td>

      {/* # Enrolled — Identity group end */}
      <Td className="text-center groupEnd">
        <IntegerCell
          value={family.students_enrolled}
          readOnly={readOnly}
          min={1}
          onSave={(v) => onEnrolledChange(family, v)}
        />
      </Td>

      {/* Base Tuition */}
      <Td className="text-right">
        <ComputedCell value={baseTuition} />
      </Td>

      {/* Multiple Student Discount — $0 explicitly for faculty */}
      <Td className="text-right">
        <ComputedCell value={multiStudent} subtractive />
      </Td>

      {/* Net Tuition Rate — gold dot inline if overridden */}
      <Td className="text-right">
        {tierOverridden && (
          <OverrideDot autoValue={naturalAppliedTierRate(family, scenario)} />
        )}
        <ComputedCell value={netRate} />
      </Td>

      {/* Subtotal for Year — Computed group end */}
      <Td className="text-right groupEnd">
        <ComputedCell value={subtotal} />
      </Td>

      {/* Faculty Discount — editable for faculty; em-dash for non-faculty */}
      <Td className="text-right">
        {family.is_faculty_family ? (
          <span className="inline-flex items-center justify-end w-full">
            {facultyOverridden && (
              <OverrideDot autoValue={facultyAuto} />
            )}
            <CurrencyCell
              value={family.faculty_discount_amount}
              readOnly={readOnly}
              subtractive
              onSave={(v) => onFieldSave(family.id, 'faculty_discount_amount', v)}
            />
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>

      {/* Other Discount */}
      <Td className="text-right">
        <CurrencyCell
          value={family.other_discount_amount}
          readOnly={readOnly}
          subtractive
          onSave={(v) => onFieldSave(family.id, 'other_discount_amount', v)}
        />
      </Td>

      {/* Financial Aid Amount — Discount Allocations group end */}
      <Td className="text-right groupEnd">
        <CurrencyCell
          value={family.financial_aid_amount}
          readOnly={readOnly}
          subtractive
          onSave={(v) => onFieldSave(family.id, 'financial_aid_amount', v)}
        />
      </Td>

      {/* NET Tuition for YEAR — Result group end */}
      <Td className="text-right groupEnd">
        <ComputedCell value={netForYear} emphasized />
      </Td>

      {/* Date Enrolled */}
      <Td>
        <DateCell
          value={family.date_enrolled}
          readOnly={readOnly}
          onSave={(v) => onFieldSave(family.id, 'date_enrolled', v)}
        />
      </Td>

      {/* Notes */}
      <Td>
        <NotesCell
          value={family.notes || ''}
          readOnly={readOnly}
          onSave={(v) => onFieldSave(family.id, 'notes', v)}
        />
      </Td>

      {/* Date Withdrawn — null displays as em-dash, not placeholder */}
      <Td>
        <DateCell
          value={family.date_withdrawn}
          readOnly={readOnly}
          onSave={(v) => onFieldSave(family.id, 'date_withdrawn', v)}
        />
      </Td>

      {/* Row actions: history clock + delete (drafting only) */}
      <Td className="text-center align-top pt-2">
        {!readOnly && (
          <div className="flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={onOpenHistory}
              aria-label="View notes history"
              title="View notes history"
              className="text-muted hover:text-navy"
            >
              <ClockIcon />
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label="Remove family"
              title="Remove family"
              className="text-muted hover:text-status-red text-[14px] leading-none"
            >
              ×
            </button>
          </div>
        )}
      </Td>
    </tr>
  )
}

// ----- Cell sub-components ---------------------------------------------

// Header cell — solid #192A4F navy at 11.5px Cinzel small-caps,
// CENTER-aligned by default (v3.8.17 spec — uniform centering
// across all column headers regardless of body cell alignment).
// Font weight uniform across all headers (no font-medium on any
// individual column). Two-line headers via <br/>. The `groupEnd`
// class adds a subtle right divider matching the v3 mockup's
// vertical group lines.
function Th({ children, className = '' }) {
  const isGroupEnd = className.includes('groupEnd')
  const cleaned = className.replace('groupEnd', '').trim()
  return (
    <th
      className={`px-2 py-2 align-bottom font-display text-[11.5px] uppercase tracking-[0.06em] text-navy text-center ${cleaned} ${
        isGroupEnd ? 'border-r-[0.5px] border-card-border' : ''
      }`}
      style={isGroupEnd ? { borderRightColor: '#D4CDB8' } : undefined}
    >
      {children}
    </th>
  )
}

function Td({ children, className = '' }) {
  const isGroupEnd = className.includes('groupEnd')
  const cleaned = className.replace('groupEnd', '').trim()
  return (
    <td
      className={`px-2 py-1.5 align-middle ${cleaned} ${
        isGroupEnd ? 'border-r-[0.5px]' : ''
      }`}
      style={isGroupEnd ? { borderRightColor: '#D4CDB8' } : undefined}
    >
      {children}
    </td>
  )
}

function ComputedCell({ value, subtractive = false, emphasized = false }) {
  const cls = emphasized
    ? 'tabular-nums text-navy font-medium'
    : 'tabular-nums text-navy/70'
  return (
    <span className={cls}>
      {formatCurrency(value, { subtractive })}
    </span>
  )
}

// Inline-adjacent gold dot. Renders immediately before the cell value
// (using inline-flex on the parent <Td> when needed). Format from the
// mockup: "● ($X,XXX)" with the dot in brand gold (#D7BF67) and the
// value in the cell's normal color. Hover tooltip shows the auto
// value. Implemented as an inline <span> for tooltip accessibility.
function OverrideDot({ autoValue }) {
  const tip = autoValue != null
    ? `Manually overridden — auto value: ${formatCurrency(autoValue)}`
    : 'Manually overridden'
  return (
    <span
      className="text-gold mr-1 cursor-help text-[12px] leading-none"
      title={tip}
      aria-label={tip}
    >
      ●
    </span>
  )
}

function ClockIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 16 14" />
    </svg>
  )
}

function TextCell({ value, readOnly, maxLength, placeholder, onSave }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])

  if (readOnly) {
    return (
      <span className="text-body">
        {value || <span className="text-muted italic">{placeholder || '—'}</span>}
      </span>
    )
  }
  return (
    <input
      type="text"
      value={draft}
      maxLength={maxLength}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onSave(draft)
      }}
      placeholder={placeholder}
      className="w-full bg-transparent border-[0.5px] border-transparent hover:border-card-border focus:border-navy focus:bg-white px-1 py-0.5 rounded text-body text-[12px] focus:outline-none"
    />
  )
}

// Integer cell. v3.8.16: native number input spinners (the up/down
// arrows on Chrome / Firefox) are suppressed via `appearance: none`
// + matching webkit-specific styles. Keeps the cell visually clean
// like the legacy spreadsheet.
function IntegerCell({ value, readOnly, min, onSave }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  useEffect(() => { setDraft(value == null ? '' : String(value)) }, [value])

  if (readOnly) {
    return (
      <span className="tabular-nums text-body">
        {formatInteger(value)}
      </span>
    )
  }
  return (
    <input
      type="number"
      inputMode="numeric"
      min={min}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = Number(draft)
        if (!Number.isFinite(n) || n < (min || 0)) {
          setDraft(value == null ? '' : String(value))
          return
        }
        if (n !== Number(value)) onSave(n)
      }}
      className="w-full bg-transparent border-[0.5px] border-transparent hover:border-card-border focus:border-navy focus:bg-white px-1 py-0.5 rounded text-center tabular-nums text-body text-[12px] focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  )
}

function DateCell({ value, readOnly, onSave }) {
  const [draft, setDraft] = useState(value || '')
  useEffect(() => { setDraft(value || '') }, [value])

  if (readOnly) {
    return (
      <span className="tabular-nums text-body text-[12px]">
        {value ? formatShortDate(value) : <span className="text-muted">—</span>}
      </span>
    )
  }
  // When the stored value is null, show em-dash with a click affordance
  // to switch to the date picker. This honors the spec ("null displays
  // as em-dash, NOT 'mm/dd/yyyy' placeholder").
  if (value == null && draft === '') {
    return (
      <button
        type="button"
        onClick={(e) => {
          // Replace the button with an actual date input by setting
          // draft to a sentinel that triggers the input render below.
          // Use a tiny trick: focus the upcoming input on next tick.
          e.preventDefault()
          setDraft(' ')
          setTimeout(() => {
            const inputs = document.querySelectorAll('input[type="date"][data-just-armed="true"]')
            const last = inputs[inputs.length - 1]
            if (last) {
              last.focus()
              if (typeof last.showPicker === 'function') last.showPicker()
            }
          }, 0)
        }}
        className="text-muted hover:text-navy text-[12px]"
        title="Set date"
      >
        —
      </button>
    )
  }
  return (
    <input
      type="date"
      data-just-armed={draft === ' ' ? 'true' : undefined}
      value={draft === ' ' ? '' : draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft && draft !== ' ' ? draft : null
        if ((next || null) !== (value || null)) onSave(next)
        if (!next) setDraft('')
      }}
      className="w-full bg-transparent border-[0.5px] border-transparent hover:border-card-border focus:border-navy focus:bg-white px-1 py-0.5 rounded tabular-nums text-body text-[12px] focus:outline-none"
    />
  )
}

function CurrencyCell({ value, readOnly, subtractive, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  useEffect(() => { setDraft(value == null ? '' : String(value)) }, [value])

  if (readOnly) {
    return (
      <span className="tabular-nums text-body">
        {formatCurrency(value, { subtractive })}
      </span>
    )
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="w-full text-right tabular-nums text-body text-[12px] hover:bg-cream-highlight/40 px-1 py-0.5 rounded"
      >
        {value == null ? <span className="text-muted">—</span> : formatCurrency(value, { subtractive })}
      </button>
    )
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false)
        const s = String(draft || '').trim()
        if (s === '') {
          if (value != null) onSave(null)
          return
        }
        const cleaned = s.replace(/[$,()\s]/g, '')
        const n = Number(cleaned)
        if (!Number.isFinite(n) || n < 0) {
          setDraft(value == null ? '' : String(value))
          return
        }
        if (n !== Number(value)) onSave(n)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.target.blur()
        if (e.key === 'Escape') {
          setDraft(value == null ? '' : String(value))
          setEditing(false)
        }
      }}
      className="w-full bg-white border-[0.5px] border-navy text-right px-1 py-0.5 rounded tabular-nums text-body text-[12px] focus:outline-none"
    />
  )
}

function NotesCell({ value, readOnly, onSave }) {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => { setDraft(value) }, [value])

  if (readOnly) {
    return (
      <p className="text-body text-[12px] whitespace-pre-wrap leading-relaxed italic">
        {value || <span className="text-muted not-italic">—</span>}
      </p>
    )
  }

  return (
    <textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        if (draft !== value) onSave(draft)
      }}
      rows={focused ? 4 : 1}
      placeholder="Audit context, FA committee notes, board annotations…"
      className="w-full bg-transparent border-[0.5px] border-transparent hover:border-card-border focus:border-navy focus:bg-white px-2 py-1 rounded text-body text-[12px] leading-relaxed resize-none focus:outline-none italic"
    />
  )
}

// ----- Helpers ---------------------------------------------------------

function baseRateOf(scenario) {
  const rates = Array.isArray(scenario?.tier_rates) ? scenario.tier_rates : []
  const t1 = rates.find((r) => Number(r.tier_size) === 1)
  return t1 ? Number(t1.per_student_rate) || 0 : 0
}

function formatShortDate(iso) {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const yy = String(d.getFullYear()).slice(-2)
    return `${mm}/${dd}/${yy}`
  } catch {
    return iso
  }
}
