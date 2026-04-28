import { useEffect, useState } from 'react'

// Collapsible KPI sidebar for the Budget module. For Commit B (shell +
// bootstrap), this renders structure with placeholder "—" values for every
// KPI; Commit C wires the real computation. The intent is that the
// component contract (props: {scenarioId, lines}) is stable from B
// forward, so swapping in real numbers is a one-shot edit to the body of
// this file rather than a structural change.
//
// Default expanded on screens >= 1200px (architecture Section 8.1);
// collapsed otherwise. State persists per session (not per user) via
// localStorage; intentional to mirror the sidebar collapsibility pattern
// established in AppShell.

const STORAGE_KEY = 'agora.budget.kpiSidebarCollapsed'

function loadInitialCollapsed() {
  try {
    // Initial collapse: respect saved preference if any; otherwise
    // collapse on narrow viewports.
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === '1') return true
    if (saved === '0') return false
    return window.innerWidth < 1200
  } catch {
    return false
  }
}

// One KPI row. value is allowed to be a string (so "—" and "$0" can both
// render); subtitle slot supports the "Pending [Module]" placeholder
// pattern from Section I of the build spec.
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

function KpiSidebar() {
  const [collapsed, setCollapsed] = useState(loadInitialCollapsed)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')
    } catch {
      // localStorage unavailable; ignore.
    }
  }, [collapsed])

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Expand KPI panel"
        className="bg-navy text-gold/70 hover:text-gold w-9 flex-shrink-0 flex flex-col items-center pt-4 gap-2 cursor-pointer transition-colors"
      >
        <span className="text-[14px]" aria-hidden="true">▸</span>
        <span
          className="font-display text-[10px] tracking-[0.2em] uppercase"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          KPI
        </span>
      </button>
    )
  }

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
          ◂
        </button>
      </div>

      <div className="space-y-4">
        <Kpi label="Total Income" value="—" subtitle="Pending budget data" />
        <Kpi label="Total Expenses" value="—" subtitle="Pending budget data" />
        <Kpi label="Net Income" value="—" subtitle="Pending budget data" />

        <Divider />

        <Kpi label="Ed Program $" value="—" subtitle="Pending budget data" />
        <Kpi label="Ed Program Ratio" value="—" subtitle="Pending Strategic Plan" />
        <Kpi label="Contributions" value="—" subtitle="Pending budget data" />
        <Kpi label="% Personnel" value="—" subtitle="Pending budget data" />

        <Divider />

        <Kpi label="Number of Students" value="—" subtitle="Pending Enrollment Estimator" />
        <Kpi label="Cost per Student" value="—" subtitle="Pending Enrollment Estimator" />
        <Kpi label="Current Tuition" value="—" subtitle="Pending Tuition Worksheet" />
        <Kpi label="Tuition Gap" value="—" subtitle="Pending Tuition Worksheet" />
        <Kpi label="Break-even Enrollment" value="—" subtitle="Pending Tuition Worksheet" />
        <Kpi label="Cash Reserve Months" value="—" subtitle="Pending Cash Flow integration" />
      </div>
    </aside>
  )
}

export default KpiSidebar
