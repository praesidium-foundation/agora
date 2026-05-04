import { useState } from 'react'
import {
  computeFamilyAppliedTierRate,
  computeFamilyMultiStudentDiscount,
  computeFamilyNetTuition,
} from '../../lib/tuitionMath'
import { formatCurrency, formatInteger } from '../../lib/format'

// Staging review table for the Tuition import workflow.
//
// v3.8.18 (Tuition-B2-import). Renders one row per staged family
// row with computed columns alongside parsed values, so operators
// can see the math result of their import before committing.
//
// Mirrors TuitionFamilyDetailsTable's column layout where it makes
// sense; adds a leading "Row #" column (the source spreadsheet row
// number, 1-indexed for operator reference) and a trailing "Status"
// column showing per-row error / warning counts. Clicking a status
// cell expands inline to show the detailed messages.
//
// Hard errors render with a red left rule on the row; warnings
// render with an amber left rule. Clean rows render without
// emphasis.
//
// Read-only — staging table is preview-only. Editing in staging is
// not in scope for B2-import; the operator rejects + re-uploads to
// fix errors.
//
// Props:
//   stagedRows  — array of tuition_audit_import_staged_rows rows
//                 (joined with their parse_errors / parse_warnings)
//   scenario    — active Stage 2 scenario row (for tier_rates,
//                 faculty_discount_pct — drives the computed
//                 columns)

export default function TuitionImportStagingTable({ stagedRows, scenario }) {
  const [expandedRowId, setExpandedRowId] = useState(null)

  return (
    <div className="w-full">
      <div className="overflow-x-auto overflow-y-auto bg-white border-[0.5px] border-card-border rounded-[6px] max-h-[calc(100vh-26rem)]">
        <table className="w-full text-[12px] font-body border-collapse">
          <thead className="sticky top-0 z-10 bg-cream-highlight/80 backdrop-blur">
            <tr className="border-b-[0.5px] border-card-border">
              <Th className="w-[44px]">Row #</Th>
              <Th className="min-w-[150px]">Family<br />Name</Th>
              <Th className="w-[60px]">Faculty</Th>
              <Th className="w-[50px] groupEnd"># Enr.</Th>
              <Th className="w-[92px]">Base<br />Tuition</Th>
              <Th className="w-[105px]">Multi-Student<br />Discount</Th>
              <Th className="w-[100px]">Net<br />Tuition Rate</Th>
              <Th className="w-[105px] groupEnd">Subtotal<br />for Year</Th>
              <Th className="w-[105px]">Faculty<br />Discount</Th>
              <Th className="w-[100px]">Other<br />Discount</Th>
              <Th className="w-[105px] groupEnd">Financial<br />Aid Amount</Th>
              <Th className="w-[115px] groupEnd">NET Tuition<br />for YEAR</Th>
              <Th className="w-[88px]">Date<br />Enrolled</Th>
              <Th className="w-[88px]">Date<br />Withdrawn</Th>
              <Th className="min-w-[160px]">Notes</Th>
              <Th className="w-[80px]">Status</Th>
            </tr>
          </thead>
          <tbody>
            {stagedRows.length === 0 ? (
              <tr>
                <td colSpan={16} className="px-3 py-6 text-muted italic text-center">
                  No staged rows.
                </td>
              </tr>
            ) : (
              stagedRows.map((row, idx) => {
                const errors = Array.isArray(row.parse_errors) ? row.parse_errors : []
                const warnings = Array.isArray(row.parse_warnings) ? row.parse_warnings : []
                const expanded = expandedRowId === row.id
                return (
                  <StagedRow
                    key={row.id}
                    row={row}
                    scenario={scenario}
                    errors={errors}
                    warnings={warnings}
                    expanded={expanded}
                    zebra={idx % 2 === 1}
                    onToggleExpand={() =>
                      setExpandedRowId((prev) => (prev === row.id ? null : row.id))
                    }
                  />
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ----- Row component ---------------------------------------------------

function StagedRow({ row, scenario, errors, warnings, expanded, zebra, onToggleExpand }) {
  // Build a family-shaped object for the math helpers.
  const family = {
    students_enrolled:       row.students_enrolled,
    is_faculty_family:       row.is_faculty_family,
    applied_tier_size:       null,  // derived at render
    applied_tier_rate:       null,
    faculty_discount_amount: row.faculty_discount_amount,
    other_discount_amount:   row.other_discount_amount,
    financial_aid_amount:    row.financial_aid_amount,
  }

  const baseRate = baseRateOf(scenario)
  const students = Number(row.students_enrolled) || 0
  const baseTuition = baseRate > 0 && students > 0 ? baseRate * students : null
  const multiStudent = computeFamilyMultiStudentDiscount(family, scenario)
  const netRate = computeFamilyAppliedTierRate(family, scenario)
  const subtotal = netRate != null && students > 0 ? netRate * students : null
  const netForYear = computeFamilyNetTuition(family, scenario)

  const hasErrors = errors.length > 0
  const hasWarnings = warnings.length > 0
  const ruleClass = hasErrors
    ? 'border-l-[3px] border-status-red'
    : hasWarnings
      ? 'border-l-[3px] border-status-amber'
      : ''
  const rowBg = zebra ? 'bg-cream-highlight/15' : 'bg-white'

  return (
    <>
      <tr className={`border-b-[0.5px] border-card-border/40 ${rowBg} ${ruleClass}`}>
        <Td className="text-center text-muted tabular-nums">{row.row_number}</Td>
        <Td>
          <span className="text-body">
            {row.family_label || <span className="text-muted italic">(missing)</span>}
          </span>
        </Td>
        <Td className="text-center">
          {row.is_faculty_family ? (
            <span className="inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-gold border-[0.5px] border-gold/40 rounded">
              Faculty
            </span>
          ) : null}
        </Td>
        <Td className="text-center groupEnd">
          <span className="tabular-nums text-body">
            {row.students_enrolled != null ? formatInteger(row.students_enrolled) : <span className="text-muted">—</span>}
          </span>
        </Td>
        <Td className="text-right">
          <ComputedCell value={baseTuition} />
        </Td>
        <Td className="text-right">
          <ComputedCell value={multiStudent} subtractive />
        </Td>
        <Td className="text-right">
          <ComputedCell value={netRate} />
        </Td>
        <Td className="text-right groupEnd">
          <ComputedCell value={subtotal} />
        </Td>
        <Td className="text-right">
          {row.is_faculty_family ? (
            <span className="tabular-nums text-body">
              {row.faculty_discount_amount != null
                ? formatCurrency(row.faculty_discount_amount, { subtractive: true })
                : <span className="text-muted italic">auto</span>}
            </span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </Td>
        <Td className="text-right">
          <span className="tabular-nums text-body">
            {row.other_discount_amount != null
              ? formatCurrency(row.other_discount_amount, { subtractive: true })
              : <span className="text-muted">—</span>}
          </span>
        </Td>
        <Td className="text-right groupEnd">
          <span className="tabular-nums text-body">
            {row.financial_aid_amount != null
              ? formatCurrency(row.financial_aid_amount, { subtractive: true })
              : <span className="text-muted">—</span>}
          </span>
        </Td>
        <Td className="text-right groupEnd">
          <ComputedCell value={netForYear} emphasized />
        </Td>
        <Td>
          <span className="tabular-nums text-body text-[12px]">
            {row.date_enrolled ? formatShortDate(row.date_enrolled) : <span className="text-muted">—</span>}
          </span>
        </Td>
        <Td>
          <span className="tabular-nums text-body text-[12px]">
            {row.date_withdrawn ? formatShortDate(row.date_withdrawn) : <span className="text-muted">—</span>}
          </span>
        </Td>
        <Td>
          <span className="text-body italic text-[12px] line-clamp-2">
            {row.notes || <span className="text-muted not-italic">—</span>}
          </span>
        </Td>
        <Td>
          <StatusButton
            errors={errors}
            warnings={warnings}
            expanded={expanded}
            onClick={onToggleExpand}
          />
        </Td>
      </tr>
      {expanded && (hasErrors || hasWarnings) && (
        <tr className={`border-b-[0.5px] border-card-border/40 ${rowBg}`}>
          <td colSpan={16} className="px-4 py-2">
            {hasErrors && (
              <div className="mb-2">
                <p className="font-body text-[11px] text-status-red uppercase tracking-wider mb-1">
                  Errors ({errors.length})
                </p>
                <ul className="text-status-red text-[12px] list-disc pl-5 space-y-0.5">
                  {errors.map((e, i) => (
                    <li key={i}>
                      <strong className="font-medium">{e.field}:</strong> {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {hasWarnings && (
              <div>
                <p className="font-body text-[11px] text-status-amber uppercase tracking-wider mb-1">
                  Warnings ({warnings.length})
                </p>
                <ul className="text-status-amber text-[12px] list-disc pl-5 space-y-0.5">
                  {warnings.map((w, i) => (
                    <li key={i}>
                      <strong className="font-medium">{w.field}:</strong> {w.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function StatusButton({ errors, warnings, expanded, onClick }) {
  const hasErrors = errors.length > 0
  const hasWarnings = warnings.length > 0
  if (!hasErrors && !hasWarnings) {
    return (
      <span className="text-status-green text-[11px] uppercase tracking-wider">
        Clean
      </span>
    )
  }
  const tone = hasErrors ? 'text-status-red' : 'text-status-amber'
  const label = hasErrors
    ? `${errors.length} error${errors.length === 1 ? '' : 's'}`
    : `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${tone} text-[11px] uppercase tracking-wider hover:underline`}
      aria-expanded={expanded}
    >
      {label} {expanded ? '▴' : '▾'}
    </button>
  )
}

// ----- Cell sub-components ---------------------------------------------

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
