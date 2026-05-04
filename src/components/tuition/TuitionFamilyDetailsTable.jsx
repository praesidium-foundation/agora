import { useEffect, useMemo, useState } from 'react'
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
// Architecture §7.3 ("Stage 2 immutability rules" + "Faculty discount
// rule" v3.8.14). The operational surface where the school records
// actual enrollment family-by-family, allocates discretionary
// discount envelopes (Faculty / Other / Financial Aid), and
// captures audit-trail-grade Notes per family.
//
// Mirrors the legacy Google Sheet's column structure for continuity
// with the operator's existing mental model. Eleven primary columns
// (Family Name, # Enrolled, Base Tuition, Multi-Student Discount,
// Net Tuition Rate, Subtotal Tuition for Year, Faculty Discount,
// Other Discounts, Financial Aid, NET Tuition for YEAR, Notes), plus
// an is_faculty_family toggle in a narrow leading column, plus
// date_enrolled / date_withdrawn columns for mid-year enrollment
// tracking. Per-row clock affordance opens TuitionFamilyHistoryModal
// for the Notes column's change_log history.
//
// Faculty discount rule (architecture §7.3 + Appendix C):
//   Faculty discount REPLACES multi-student tier discount. Toggling
//   is_faculty_family true cascades: applied_tier_size = 1,
//   applied_tier_rate = base_rate, faculty_discount_amount = base ×
//   students × pct/100. The Multi-Student Discount column displays
//   $0 for faculty families. Manual overrides (faculty_discount_amount
//   or applied_tier_rate) are visually marked with a small gold dot
//   indicator at the cell's top-right corner with a tooltip showing
//   the auto-computed value.
//
// Sort: faculty families clustered alphabetically at the top; thin
// navy separator rule between faculty and non-faculty groups; then
// non-faculty alphabetically. Sort is automatic, not user-configurable.
//
// Read-only state (scenario.state !== 'drafting'): all editable cells
// render as plain text without input chrome. Notes textarea becomes
// wrapped plain text. is_faculty_family toggle becomes a small
// "Faculty" badge when true (hidden when false). Add Family
// affordance hides. Clock icons for per-row history hide.
//
// Props:
//   families     — array of tuition_worksheet_family_details rows
//   scenario     — active Stage 2 scenario row (for tier_rates,
//                  faculty_discount_pct)
//   readOnly     — bool; when true, no input chrome anywhere
//   onUpdateRow  — (familyId, patchObj) => Promise<boolean>; saves a
//                  multi-field update atomically. Used for cascade
//                  saves (toggling faculty triggers tier + faculty
//                  discount cascade in one save).
//   onDeleteRow  — (familyId) => Promise<void>; removes a family
//                  (delete affordance is in the row's overflow menu;
//                  only enabled for drafting state)
//   onAddFamily  — () => Promise<void>; creates a new row with sane
//                  defaults; parent focuses the new row's Family
//                  Name input.

export default function TuitionFamilyDetailsTable({
  families,
  scenario,
  readOnly,
  onUpdateRow,
  onDeleteRow,
  onAddFamily,
}) {
  const [historyFor, setHistoryFor] = useState(null) // {familyId, familyLabel}
  const [adding, setAdding] = useState(false)

  // Sort: faculty first by name, then non-faculty by name.
  const sorted = useMemo(() => sortFamilies(families), [families])

  // Find the boundary index between faculty and non-faculty so we can
  // render the separator. -1 means no faculty (no separator) or
  // all-faculty (no separator).
  const facultyCount = sorted.filter((f) => f.is_faculty_family).length
  const showSeparator = facultyCount > 0 && facultyCount < sorted.length

  // Save cascades — invoked by row controls. Each returns the patch
  // object to send to onUpdateRow, then executes the save.

  // Toggle is_faculty_family. Cascades applied_tier_size,
  // applied_tier_rate, faculty_discount_amount per architecture §7.3.
  async function handleToggleFaculty(family, nextValue) {
    if (readOnly) return
    const patch = { is_faculty_family: nextValue }
    if (nextValue) {
      // Becoming faculty: tier collapses to 1 / base, faculty
      // discount auto-populates.
      patch.applied_tier_size = 1
      patch.applied_tier_rate = baseRateOf(scenario)
      patch.faculty_discount_amount = computeFamilyFacultyDiscountAuto(
        { ...family, is_faculty_family: true },
        scenario,
      )
    } else {
      // Leaving faculty: revert to natural tier; clear faculty discount.
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

  // # Enrolled change. Cascades tier rate (for non-faculty without
  // override) and faculty discount (for faculty without override).
  async function handleEnrolledChange(family, nextValue) {
    if (readOnly) return
    const patch = { students_enrolled: nextValue }
    const next = { ...family, students_enrolled: nextValue }
    if (family.is_faculty_family) {
      // Faculty: tier stays at 1/base; recompute faculty discount
      // unless manually overridden.
      const overridden = isFamilyFacultyDiscountOverridden(family, scenario)
      if (!overridden) {
        patch.faculty_discount_amount = computeFamilyFacultyDiscountAuto(next, scenario)
      }
    } else {
      // Non-faculty: recompute tier_size and tier_rate unless overridden.
      const overridden = isFamilyTierRateOverridden(family, scenario)
      if (!overridden) {
        patch.applied_tier_size = naturalAppliedTierSize(next, scenario)
        patch.applied_tier_rate = naturalAppliedTierRate(next, scenario)
      }
    }
    await onUpdateRow(family.id, patch)
  }

  // Single-field saves for the simple cells (label, dates, currency).
  async function handleFieldSave(familyId, field, value) {
    if (readOnly) return
    await onUpdateRow(familyId, { [field]: value })
  }

  async function handleAddFamilyClick() {
    if (readOnly) return
    if (adding) return
    setAdding(true)
    try {
      await onAddFamily()
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="w-full">
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-[12px] font-body">
          <thead>
            <tr className="text-left border-b-[0.5px] border-card-border bg-cream-highlight/40">
              <Th className="w-[40px] text-center">Faculty</Th>
              <Th className="min-w-[160px]">Family Name</Th>
              <Th className="w-[60px] text-center"># Enr.</Th>
              <Th className="w-[100px]">Date Enrolled</Th>
              <Th className="w-[100px]">Date Withdrawn</Th>
              <Th className="w-[90px] text-right">Base Tuition</Th>
              <Th className="w-[110px] text-right">Multi-Student Discount</Th>
              <Th className="w-[105px] text-right">Net Tuition Rate</Th>
              <Th className="w-[110px] text-right">Subtotal / Yr</Th>
              <Th className="w-[105px] text-right">Faculty Discount</Th>
              <Th className="w-[100px] text-right">Other Disc.</Th>
              <Th className="w-[100px] text-right">Financial Aid</Th>
              <Th className="w-[120px] text-right font-medium">NET / Yr</Th>
              <Th className="min-w-[180px]">Notes</Th>
              <Th className="w-[24px]" aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={15} className="px-3 py-6 text-muted italic text-center">
                  No families recorded yet. Use “+ Add Family” below to begin.
                </td>
              </tr>
            )}
            {sorted.map((family, idx) => {
              const isLastFacultyRow =
                showSeparator &&
                family.is_faculty_family &&
                idx + 1 < sorted.length &&
                !sorted[idx + 1].is_faculty_family
              return (
                <FamilyRow
                  key={family.id}
                  family={family}
                  scenario={scenario}
                  readOnly={readOnly}
                  bottomSeparator={isLastFacultyRow}
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
              )
            })}
          </tbody>
        </table>
      </div>

      {!readOnly && (
        <div className="mt-3">
          <button
            type="button"
            onClick={handleAddFamilyClick}
            disabled={adding}
            className="font-body text-status-blue hover:underline text-[13px] disabled:opacity-50 disabled:cursor-wait"
          >
            {adding ? 'Adding…' : '+ Add Family'}
          </button>
        </div>
      )}

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

// ----- Row component ----------------------------------------------------

function FamilyRow({
  family, scenario, readOnly, bottomSeparator,
  onToggleFaculty, onEnrolledChange, onFieldSave,
  onOpenHistory, onDelete,
}) {
  const baseRate = baseRateOf(scenario)
  const students = Number(family.students_enrolled) || 0

  // Computed values for the read-only cells.
  const baseTuition = baseRate > 0 && students > 0 ? baseRate * students : null
  const multiStudent = computeFamilyMultiStudentDiscount(family, scenario)
  const netRate = computeFamilyAppliedTierRate(family, scenario)
  const subtotal = netRate != null && students > 0 ? netRate * students : null
  const netForYear = computeFamilyNetTuition(family, scenario)
  const facultyAuto = computeFamilyFacultyDiscountAuto(family, scenario)
  const facultyOverridden = isFamilyFacultyDiscountOverridden(family, scenario)
  const tierOverridden = isFamilyTierRateOverridden(family, scenario)

  // Row class — bottom separator after the last faculty family.
  const rowClass = `border-b-[0.5px] border-card-border/60 hover:bg-cream-highlight/20 ${
    bottomSeparator ? 'border-b-2 border-b-navy/25' : ''
  }`

  return (
    <tr className={rowClass}>
      {/* Faculty toggle */}
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

      {/* # Enrolled */}
      <Td className="text-center">
        <IntegerCell
          value={family.students_enrolled}
          readOnly={readOnly}
          min={1}
          onSave={(v) => onEnrolledChange(family, v)}
        />
      </Td>

      {/* Date Enrolled */}
      <Td>
        <DateCell
          value={family.date_enrolled}
          readOnly={readOnly}
          onSave={(v) => onFieldSave(family.id, 'date_enrolled', v)}
        />
      </Td>

      {/* Date Withdrawn */}
      <Td>
        <DateCell
          value={family.date_withdrawn}
          readOnly={readOnly}
          onSave={(v) => onFieldSave(family.id, 'date_withdrawn', v)}
        />
      </Td>

      {/* Base Tuition (computed) */}
      <Td className="text-right">
        <ComputedCell value={baseTuition} />
      </Td>

      {/* Multi-Student Discount (computed; $0 for faculty) */}
      <Td className="text-right">
        <ComputedCell value={multiStudent} subtractive />
      </Td>

      {/* Net Tuition Rate (computed; gold dot if tier overridden) */}
      <Td className="text-right relative">
        <ComputedCell value={netRate} />
        {tierOverridden && (
          <OverrideDot autoValue={naturalAppliedTierRate(family, scenario)} />
        )}
      </Td>

      {/* Subtotal / Yr (computed) */}
      <Td className="text-right">
        <ComputedCell value={subtotal} />
      </Td>

      {/* Faculty Discount (editable; gold dot if overridden; only
          editable when is_faculty_family is true) */}
      <Td className="text-right relative">
        {family.is_faculty_family ? (
          <CurrencyCell
            value={family.faculty_discount_amount}
            readOnly={readOnly}
            subtractive
            onSave={(v) => onFieldSave(family.id, 'faculty_discount_amount', v)}
          />
        ) : (
          // Non-faculty families: the field doesn't apply. Render
          // em-dash so it reads as "not applicable."
          <span className="text-muted">—</span>
        )}
        {facultyOverridden && (
          <OverrideDot autoValue={facultyAuto} />
        )}
      </Td>

      {/* Other Discounts */}
      <Td className="text-right">
        <CurrencyCell
          value={family.other_discount_amount}
          readOnly={readOnly}
          subtractive
          onSave={(v) => onFieldSave(family.id, 'other_discount_amount', v)}
        />
      </Td>

      {/* Financial Aid */}
      <Td className="text-right">
        <CurrencyCell
          value={family.financial_aid_amount}
          readOnly={readOnly}
          subtractive
          onSave={(v) => onFieldSave(family.id, 'financial_aid_amount', v)}
        />
      </Td>

      {/* NET / Yr (computed; emphasized) */}
      <Td className="text-right">
        <ComputedCell value={netForYear} emphasized />
      </Td>

      {/* Notes */}
      <Td>
        <NotesCell
          value={family.notes || ''}
          readOnly={readOnly}
          onSave={(v) => onFieldSave(family.id, 'notes', v)}
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

function Th({ children, className = '' }) {
  return (
    <th className={`px-2 py-2 font-display text-[11px] uppercase tracking-wider text-muted ${className}`}>
      {children}
    </th>
  )
}

function Td({ children, className = '' }) {
  return (
    <td className={`px-2 py-1.5 align-middle ${className}`}>
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

function OverrideDot({ autoValue }) {
  const tip = autoValue != null
    ? `Manually overridden — auto value: ${formatCurrency(autoValue)}`
    : 'Manually overridden'
  return (
    <span
      className="absolute top-1 right-1 text-gold text-[10px] leading-none cursor-help"
      title={tip}
      aria-label={tip}
    >
      •
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

// Text cell with input on focus, plain text on blur. Saves on blur
// when the value changed.
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
          // Revert silently to last good value.
          setDraft(value == null ? '' : String(value))
          return
        }
        if (n !== Number(value)) onSave(n)
      }}
      className="w-full bg-transparent border-[0.5px] border-transparent hover:border-card-border focus:border-navy focus:bg-white px-1 py-0.5 rounded text-center tabular-nums text-body text-[12px] focus:outline-none"
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
  return (
    <input
      type="date"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft || null
        if ((next || null) !== (value || null)) onSave(next)
      }}
      className="w-full bg-transparent border-[0.5px] border-transparent hover:border-card-border focus:border-navy focus:bg-white px-1 py-0.5 rounded tabular-nums text-body text-[12px] focus:outline-none"
    />
  )
}

// Currency cell with parens-display convention from B1.3. Display
// state shows formatCurrency result (parens for subtractive); focus
// state shows raw numeric for entry.
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
      <p className="text-body text-[12px] whitespace-pre-wrap leading-relaxed">
        {value || <span className="text-muted italic">—</span>}
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
      rows={focused ? 4 : 2}
      placeholder="Audit context, FA committee notes, board annotations…"
      className="w-full bg-transparent border-[0.5px] border-transparent hover:border-card-border focus:border-navy focus:bg-white px-2 py-1 rounded text-body text-[12px] leading-relaxed resize-none focus:outline-none"
    />
  )
}

// ----- Helpers ---------------------------------------------------------

function baseRateOf(scenario) {
  const rates = Array.isArray(scenario?.tier_rates) ? scenario.tier_rates : []
  const t1 = rates.find((r) => Number(r.tier_size) === 1)
  return t1 ? Number(t1.per_student_rate) || 0 : 0
}

function sortFamilies(families) {
  if (!Array.isArray(families)) return []
  return [...families].sort((a, b) => {
    const af = a.is_faculty_family ? 0 : 1
    const bf = b.is_faculty_family ? 0 : 1
    if (af !== bf) return af - bf
    const an = (a.family_label || '').toLowerCase()
    const bn = (b.family_label || '').toLowerCase()
    return an.localeCompare(bn)
  })
}

function formatShortDate(iso) {
  // iso may be a date-only string ('2026-09-08') or a full timestamp.
  // Display as MM/DD/YY for tight fit.
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
