import { useEffect, useState } from 'react'

// Collapsible KPI sidebar, rendered on the RIGHT side of the budget
// detail zone (architecture Section 8.1). Right-side placement avoids
// adjacency-collision with the navy nav sidebar on the left and matches
// standard dashboard convention (primary data on the left, summary
// metrics on the right).
//
// Default expanded on screens >= 1200px, collapsed otherwise. State
// persists per-user via localStorage; the chevron points inward (left,
// ◂) when collapsed to suggest "click here to expand inward" and outward
// (right, ▸) when expanded to suggest "click here to collapse outward."
//
// Props:
//   kpis: {
//     totalIncome, totalExpense, netIncome,
//     edProgramDollars, edProgramRatio, contributionsTotal, pctPersonnel
//   } | null
//
//   stageType:    'preliminary' | 'final' | other
//                 v3.8.20 (Tuition-CrossModule-KPIs). Drives the
//                 source for "Number of Students" and other
//                 enrollment-dependent Tuition KPIs:
//                   preliminary → reads from the locked Stage 1
//                                 Tuition Planning snapshot
//                   final       → reads from the operator-promoted
//                                 Final Budget reference Audit
//                                 snapshot (anchors to a fixed
//                                 enrollment baseline; live Audit
//                                 edits do not shift Final Budget
//                                 KPIs)
//
//   tuitionStage1: row from get_latest_locked_tuition_planning RPC
//                  or null when no Stage 1 lock exists for the AYE
//
//   tuitionAuditRef: row from get_tuition_audit_final_budget_
//                    reference_summary RPC or null when no operator
//                    has promoted a reference snapshot for the AYE.
//                    Only consulted when stageType === 'final'.
//
// When `kpis` is null (no scenario yet), every value renders as "—".

const STORAGE_KEY = 'agora.kpiSidebar.collapsed'

function loadInitialCollapsed() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === '1') return true
    if (saved === '0') return false
    return window.innerWidth < 1200
  } catch {
    return false
  }
}

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const pct1 = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

function fmtUsd(n) {
  if (n === null || n === undefined) return '—'
  return usd0.format(n)
}
function fmtPct(n) {
  if (n === null || n === undefined) return '—'
  return pct1.format(n)
}
function fmtInt(n) {
  if (n === null || n === undefined) return '—'
  return new Intl.NumberFormat('en-US').format(Math.round(Number(n)))
}

function Kpi({ label, value, subtitle, valueClass = '' }) {
  return (
    <div className="space-y-0.5">
      <div className="font-body text-[10px] text-white/55 uppercase tracking-wider">
        {label}
      </div>
      <div className={`font-display text-[18px] text-white tabular-nums leading-tight ${valueClass}`}>
        {value}
      </div>
      {subtitle && (
        <div className="font-body italic text-[11px] text-white/50 leading-tight">
          {subtitle}
        </div>
      )}
    </div>
  )
}

function Divider() {
  return <div className="border-t-[0.5px] border-white/10 my-4" />
}

// Compute the cross-module Tuition KPIs based on stage + reference
// data. Returns an object keyed by KPI name with `{ value, subtitle }`
// per slot. The KpiSidebar caller renders these directly.
//
// The "—" sentinel and "Pending …" subtitles work in tandem: when an
// upstream piece is missing, the value collapses to "—" and the
// subtitle names which upstream is missing so the operator knows
// what to do.
function computeTuitionKpis({ kpis, stageType, tuitionStage1, tuitionAuditRef }) {
  const totalExpense = kpis?.totalExpense
  const baseRate = tuitionStage1?.base_rate
  const stage1HasLock = tuitionStage1 != null

  // Number of Students:
  //   final       → audit reference's total_students
  //   preliminary → Stage 1 snapshot's total_students projection
  let studentsValue, studentsSubtitle
  if (stageType === 'final') {
    if (tuitionAuditRef?.total_students != null && tuitionAuditRef.total_students > 0) {
      studentsValue = fmtInt(tuitionAuditRef.total_students)
      studentsSubtitle = 'From promoted Audit reference'
    } else {
      studentsValue = '—'
      studentsSubtitle = 'Pending Final Budget reference snapshot'
    }
  } else {
    if (stage1HasLock && tuitionStage1.total_students != null) {
      studentsValue = fmtInt(tuitionStage1.total_students)
      studentsSubtitle = 'From locked Tuition Planning'
    } else {
      studentsValue = '—'
      studentsSubtitle = 'Pending Tuition Planning lock'
    }
  }

  // Current Tuition: base rate from Stage 1 (same source for both
  // budget stages — what the school is charging is set in Stage 1).
  let tuitionValue, tuitionSubtitle
  if (stage1HasLock && baseRate > 0) {
    tuitionValue = fmtUsd(baseRate)
    tuitionSubtitle = 'Base rate · 1 student'
  } else {
    tuitionValue = '—'
    tuitionSubtitle = 'Pending Tuition Planning lock'
  }

  // Cost per Student: totalExpense / number_of_students. Uses the
  // appropriate students source per stage.
  const enrolledForCpS = stageType === 'final'
    ? tuitionAuditRef?.total_students
    : tuitionStage1?.total_students
  let costPerStudentValue, costPerStudentSubtitle
  if (totalExpense != null && totalExpense > 0 && enrolledForCpS != null && enrolledForCpS > 0) {
    costPerStudentValue = fmtUsd(totalExpense / enrolledForCpS)
    costPerStudentSubtitle = stageType === 'final' ? 'Expenses ÷ audit enrollment' : 'Expenses ÷ projected enrollment'
  } else {
    costPerStudentValue = '—'
    if (totalExpense == null || totalExpense <= 0) {
      costPerStudentSubtitle = 'Pending expense entry'
    } else if (stageType === 'final') {
      costPerStudentSubtitle = 'Pending Final Budget reference snapshot'
    } else {
      costPerStudentSubtitle = 'Pending Tuition Planning lock'
    }
  }

  // Tuition Gap: cost_per_student − base_rate. The shortfall the
  // school covers via contributions / FA / etc. Positive number =
  // gap exists.
  let gapValue, gapSubtitle
  if (totalExpense != null && totalExpense > 0
      && enrolledForCpS != null && enrolledForCpS > 0
      && baseRate != null && baseRate > 0) {
    gapValue = fmtUsd(totalExpense / enrolledForCpS - baseRate)
    gapSubtitle = 'Cost per student − tuition'
  } else {
    gapValue = '—'
    gapSubtitle = totalExpense == null
      ? 'Pending expense entry'
      : (stageType === 'final' && tuitionAuditRef == null
          ? 'Pending Final Budget reference snapshot'
          : 'Pending Tuition Planning lock')
  }

  // Break-even Enrollment:
  //   preliminary → read pre-computed kpi_breakeven_enrollment from
  //                 the Stage 1 snapshot directly (the value was
  //                 captured at lock time per Migration 032).
  //   final       → compute live: ceil(totalExpense / avg_net_per_student)
  //                 where avg_net_per_student = audit.net_tuition_for_year
  //                 / audit.total_students. This is sensitive to live
  //                 Final Budget edits but anchors to the audit's
  //                 fixed actual-enrollment baseline.
  let breakevenValue, breakevenSubtitle
  if (stageType === 'final') {
    if (totalExpense != null && totalExpense > 0
        && tuitionAuditRef?.total_students != null && tuitionAuditRef.total_students > 0
        && tuitionAuditRef.net_tuition_for_year != null && tuitionAuditRef.net_tuition_for_year > 0) {
      const avgNetPerStudent = tuitionAuditRef.net_tuition_for_year / tuitionAuditRef.total_students
      breakevenValue = fmtInt(Math.ceil(totalExpense / avgNetPerStudent))
      breakevenSubtitle = 'At audit reference avg NET'
    } else {
      breakevenValue = '—'
      breakevenSubtitle = totalExpense == null
        ? 'Pending expense entry'
        : 'Pending Final Budget reference snapshot'
    }
  } else {
    if (stage1HasLock && tuitionStage1.breakeven_enrollment != null) {
      breakevenValue = fmtInt(tuitionStage1.breakeven_enrollment)
      breakevenSubtitle = 'From Tuition Planning'
    } else {
      breakevenValue = '—'
      breakevenSubtitle = 'Pending Tuition Planning lock'
    }
  }

  return {
    students:       { value: studentsValue,       subtitle: studentsSubtitle },
    tuition:        { value: tuitionValue,        subtitle: tuitionSubtitle },
    costPerStudent: { value: costPerStudentValue, subtitle: costPerStudentSubtitle },
    gap:            { value: gapValue,            subtitle: gapSubtitle },
    breakeven:      { value: breakevenValue,      subtitle: breakevenSubtitle },
  }
}

function KpiSidebar({ kpis, stageType, tuitionStage1, tuitionAuditRef }) {
  const [collapsed, setCollapsed] = useState(loadInitialCollapsed)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')
    } catch {
      // ignore
    }
  }, [collapsed])

  if (collapsed) {
    // Collapsed strip on the right edge. Chevron points LEFT (◂) to
    // suggest "click to expand inward toward the detail zone."
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Expand KPI panel"
        className="bg-navy text-gold/70 hover:text-gold w-9 flex-shrink-0 flex flex-col items-center pt-4 gap-2 cursor-pointer transition-colors"
      >
        <span className="text-[14px]" aria-hidden="true">◂</span>
        <span
          className="font-display text-[10px] tracking-[0.2em] uppercase"
          style={{ writingMode: 'vertical-rl' }}
        >
          KPI
        </span>
      </button>
    )
  }

  const k = kpis || {}
  const netClass =
    k.netIncome !== undefined && k.netIncome !== null && k.netIncome < 0
      ? 'text-status-red-bg'
      : ''
  const netSubtitle =
    k.netIncome !== undefined && k.netIncome !== null && k.netIncome < 0
      ? 'deficit'
      : null

  // Cross-module Tuition KPIs (v3.8.20). Computed from kpis +
  // upstream Tuition data per stage.
  const tuitionKpis = computeTuitionKpis({ kpis, stageType, tuitionStage1, tuitionAuditRef })

  // Reference info for Final Budget — quiet single-line note
  // showing which Audit snapshot the cross-module KPIs are reading.
  const showRefNote = stageType === 'final' && tuitionAuditRef != null
  const refLabelStr = tuitionAuditRef?.snapshot_label || 'Audit reference'
  const refDateStr = tuitionAuditRef?.captured_at
    ? new Date(tuitionAuditRef.captured_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      })
    : null

  // Reference info for Preliminary Budget — quiet single-line note
  // showing which Stage 1 snapshot we're reading.
  const showStage1Note = stageType === 'preliminary' && tuitionStage1 != null
  const stage1DateStr = tuitionStage1?.captured_at
    ? new Date(tuitionStage1.captured_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      })
    : null

  return (
    <aside className="bg-navy text-white w-[220px] flex-shrink-0 px-5 py-5 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <span className="font-display text-[12px] text-gold/85 tracking-[0.14em] uppercase">
          Key Metrics
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse KPI panel"
          className="text-gold/60 hover:text-gold text-[12px] leading-none"
        >
          ▸
        </button>
      </div>

      <div className="space-y-4">
        <Kpi label="Total Income"   value={fmtUsd(k.totalIncome)} />
        <Kpi label="Total Expenses" value={fmtUsd(k.totalExpense)} />
        <Kpi
          label="Net Income"
          value={fmtUsd(k.netIncome)}
          valueClass={netClass}
          subtitle={netSubtitle}
        />

        <Divider />

        <Kpi label="Ed Program $" value={fmtUsd(k.edProgramDollars)} />
        <Kpi
          label="Ed Program Ratio"
          value={fmtPct(k.edProgramRatio)}
          subtitle="Target — Pending Strategic Plan"
        />
        <Kpi label="Contributions" value={fmtUsd(k.contributionsTotal)} />
        <Kpi label="% Personnel"   value={fmtPct(k.pctPersonnel)} />

        <Divider />

        {/* Cross-module Tuition KPIs (v3.8.20). Wired through
            tuitionStage1 (Stage 1 lock snapshot) and tuitionAuditRef
            (Final Budget reference Audit snapshot). */}
        <Kpi label="Number of Students"   value={tuitionKpis.students.value}       subtitle={tuitionKpis.students.subtitle} />
        <Kpi label="Cost per Student"     value={tuitionKpis.costPerStudent.value} subtitle={tuitionKpis.costPerStudent.subtitle} />
        <Kpi label="Current Tuition"      value={tuitionKpis.tuition.value}        subtitle={tuitionKpis.tuition.subtitle} />
        <Kpi label="Tuition Gap"          value={tuitionKpis.gap.value}            subtitle={tuitionKpis.gap.subtitle} />
        <Kpi label="Break-even Enrollment" value={tuitionKpis.breakeven.value}     subtitle={tuitionKpis.breakeven.subtitle} />
        <Kpi label="Cash Reserve Months"  value="—" subtitle="Pending Cash Flow integration" />

        {(showRefNote || showStage1Note) && (
          <div className="border-t-[0.5px] border-white/10 pt-3 mt-3">
            {showRefNote && (
              <p className="font-body italic text-[10px] text-white/50 leading-tight">
                Tuition Audit reference:{' '}
                <span className="not-italic text-white/70">{refLabelStr}</span>
                {refDateStr ? <> — {refDateStr}</> : null}
              </p>
            )}
            {showStage1Note && (
              <p className="font-body italic text-[10px] text-white/50 leading-tight">
                Tuition Planning reference: locked
                {stage1DateStr ? <> {stage1DateStr}</> : ''}
              </p>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

export default KpiSidebar
