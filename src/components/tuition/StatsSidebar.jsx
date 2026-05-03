import { useEffect, useState } from 'react'
import { formatCurrency } from '../../lib/format'

// Data-driven stats sidebar. Right-side placement and visual treatment
// mirror Budget's KpiSidebar exactly (architecture §8.1) — navy panel
// against the cream detail surface, collapsibility with chevron
// pointing inward when collapsed (◂) and outward when expanded (▸).
//
// Designed for forward compatibility: in Tuition-B1 we feed it a
// handful of direct-sum stats (projected gross at Tier 1, total
// discount envelopes, projected families, projected students). In
// Tuition-C the same component renders computed KPIs (break-even
// enrollment count, net education program ratio, year-over-year
// comparison) without rewrite — the parent simply passes a richer
// `stats` array with `target` / `comparison` / `status` fields.
//
// Props:
//   stats: Array<{
//     key:        string                                — stable React key
//     label:      string                                — uppercase small-caps label
//     value:      number | null | undefined             — null/undefined renders as "—"
//     format:     'currency' | 'integer' | 'percent' | 'ratio' | 'text'
//     subtitle?:  string                                — italic line below value (legacy alias for sublabel)
//     sublabel?:  string                                — italic line below value (preferred name; v3.8.3)
//     target?:    number                                — comparison reference (Tuition-C)
//     comparison?: 'higher_better' | 'lower_better' | 'within_range'
//     status?:    'ok' | 'warning' | 'alert'
//     emphasized?: boolean                              — render value at ~1.15× standard typography
//                                                          (v3.8.3 — used for Net Projected Ed Program
//                                                          Revenue, the load-bearing operational KPI)
//     subtractive?: boolean                             — currency-only (v3.8.4): always render the
//                                                          value with parens, regardless of sign
//                                                          (e.g., Total Projected Discounts).
//                                                          Negative currency values render with
//                                                          parens automatically without this flag.
//                                                          Per architecture §10.4 accounting
//                                                          parentheses convention.
//   }>
//   collapsed:         boolean                          — controlled
//   onCollapseChange: (next: boolean) => void

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const int0 = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

const pct1 = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

// v3.8.4: currency values route through formatCurrency for the
// universal parens convention (§10.4). Other formats keep their
// inline formatters.
function formatValue(value, format, { subtractive = false } = {}) {
  if (value === null || value === undefined) return '—'
  if (format === 'currency') {
    // formatCurrency handles its own null/non-finite cases and
    // applies parens for either subtractive=true OR negative value.
    return formatCurrency(value, { subtractive })
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return format === 'text' ? String(value) : '—'
  }
  switch (format) {
    case 'integer':  return int0.format(value)
    case 'percent':  return pct1.format(value)
    case 'ratio':    return value.toFixed(3)
    case 'text':     return String(value)
    default:         return String(value)
  }
}

// Status indicator pill. Renders a small dot + label when status is
// provided. Tuition-B1 never sets status, so this stays dormant; it
// activates in Tuition-C when KPIs gain comparison-against-target
// semantics.
function StatusPill({ status }) {
  if (!status) return null
  const cfg = {
    ok:      { dot: 'bg-status-green', text: 'text-status-green' },
    warning: { dot: 'bg-status-amber', text: 'text-status-amber' },
    alert:   { dot: 'bg-status-red',   text: 'text-status-red' },
  }[status]
  if (!cfg) return null
  return (
    <span className={`inline-flex items-center gap-1 ${cfg.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} aria-hidden="true" />
      <span className="font-body text-[10px] tracking-wider uppercase">
        {status}
      </span>
    </span>
  )
}

function Stat({ label, value, format, subtitle, sublabel, status, target, comparison, emphasized, subtractive }) {
  // Optional target line — only renders when target is supplied. Tuition-C
  // surface; B1 never passes a target.
  const targetLine =
    target !== undefined && target !== null && Number.isFinite(target)
      ? `Target: ${formatValue(target, format, { subtractive })}`
      : null

  // Subtitle line precedence: explicit subtitle/sublabel wins; otherwise
  // target (when present) renders. v3.8.3 introduces `sublabel` as the
  // preferred name; `subtitle` stays as a back-compat alias.
  const subLine = sublabel || subtitle || targetLine

  // v3.8.3: emphasized stat renders the value at ~1.15× the standard
  // 18px size. Surfaces Net Projected Ed Program Revenue visually
  // within the stats column without breaking the column's typography
  // rhythm (the label and sublabel stay the same size; only the
  // numeric value scales up).
  const valueSizeClass = emphasized ? 'text-[21px]' : 'text-[18px]'

  return (
    <div className="space-y-0.5">
      <div className="font-body text-[10px] text-white/55 uppercase tracking-wider">
        {label}
      </div>
      <div className={`font-display ${valueSizeClass} text-white tabular-nums leading-tight`}>
        {formatValue(value, format, { subtractive })}
      </div>
      {subLine && (
        <div className="font-body italic text-[11px] text-white/50 leading-tight">
          {subLine}
        </div>
      )}
      {status && (
        <div className="pt-0.5">
          <StatusPill status={status} />
        </div>
      )}
      {/* `comparison` is metadata for downstream styling decisions
          (e.g., "higher is better" might color positive deltas green
          in Tuition-C). It does not render directly in B1. */}
      {comparison ? <span className="hidden">{comparison}</span> : null}
    </div>
  )
}

function StatsSidebar({ stats = [], collapsed, onCollapseChange }) {
  // The sidebar is uncontrolled-friendly: if no `collapsed` prop is
  // passed, manage state internally. The parent (TuitionWorksheet)
  // controls it so collapse state persists in localStorage at the
  // page level.
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const isControlled = typeof collapsed === 'boolean'
  const isCollapsed = isControlled ? collapsed : internalCollapsed
  const setCollapsed = isControlled
    ? (next) => onCollapseChange?.(next)
    : setInternalCollapsed

  useEffect(() => {
    if (!isControlled) return
    // Controlled mode: parent owns persistence.
  }, [isControlled])

  if (isCollapsed) {
    // Collapsed strip on the right edge. Chevron points LEFT (◂) to
    // suggest "click to expand inward toward the detail zone." Visual
    // parity with KpiSidebar.
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Expand stats panel"
        className="bg-navy text-gold/70 hover:text-gold w-9 flex-shrink-0 flex flex-col items-center pt-4 gap-2 cursor-pointer transition-colors"
      >
        <span className="text-[14px]" aria-hidden="true">◂</span>
        <span
          className="font-display text-[10px] tracking-[0.2em] uppercase"
          style={{ writingMode: 'vertical-rl' }}
        >
          Stats
        </span>
      </button>
    )
  }

  return (
    <aside className="bg-navy text-white w-[220px] flex-shrink-0 px-5 py-5 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <span className="font-display text-[12px] text-gold/85 tracking-[0.14em] uppercase">
          Stats
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse stats panel"
          className="text-gold/60 hover:text-gold text-[12px] leading-none"
        >
          ▸
        </button>
      </div>

      {stats.length === 0 ? (
        <p className="font-body italic text-white/50 text-[12px]">
          No stats to display yet.
        </p>
      ) : (
        <div className="space-y-4">
          {stats.map((s) => (
            <Stat
              key={s.key}
              label={s.label}
              value={s.value}
              format={s.format}
              subtitle={s.subtitle}
              sublabel={s.sublabel}
              status={s.status}
              target={s.target}
              comparison={s.comparison}
              emphasized={s.emphasized}
              subtractive={s.subtractive}
            />
          ))}
        </div>
      )}
    </aside>
  )
}

export default StatsSidebar
