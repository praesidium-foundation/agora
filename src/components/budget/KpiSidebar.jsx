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
// When `kpis` is null (no scenario yet), every value renders as "—".
// When present, computable values render their numbers; values that
// require modules that don't exist yet (Number of Students, Cost per
// Student, etc.) keep their "Pending [Module]" subtitles per Section I
// of the build spec.

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

function KpiSidebar({ kpis }) {
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

  // KPI panel rendering. When `kpis` is null, every computed value
  // collapses to "—" (the formatters handle null). When non-null, the
  // computed values come straight from the math; the placeholder slots
  // (Number of Students, Tuition, etc.) keep their static "Pending"
  // subtitles because they require modules that don't yet exist.
  const k = kpis || {}
  const netClass =
    k.netIncome !== undefined && k.netIncome !== null && k.netIncome < 0
      ? 'text-status-red-bg'  // light red on dark; visible without screaming
      : ''
  const netSubtitle =
    k.netIncome !== undefined && k.netIncome !== null && k.netIncome < 0
      ? 'deficit'
      : null

  return (
    <aside className="bg-navy text-white w-[220px] flex-shrink-0 px-5 py-5 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <span className="font-display text-[12px] text-gold/85 tracking-[0.14em] uppercase">
          Key Metrics
        </span>
        {/* Expanded panel, right-side chevron points RIGHT (▸) to
            suggest "click to collapse outward toward the page edge." */}
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

        <Kpi label="Number of Students" value="—" subtitle="Pending Enrollment Estimator" />
        <Kpi label="Cost per Student"   value="—" subtitle="Pending Enrollment Estimator" />
        <Kpi label="Current Tuition"    value="—" subtitle="Pending Tuition Worksheet" />
        <Kpi label="Tuition Gap"        value="—" subtitle="Pending Tuition Worksheet" />
        <Kpi label="Break-even Enrollment" value="—" subtitle="Pending Tuition Worksheet" />
        <Kpi label="Cash Reserve Months" value="—" subtitle="Pending Cash Flow integration" />
      </div>
    </aside>
  )
}

export default KpiSidebar
