// KPI tile with a 3px colored accent bar at the top.
// Cream-highlight background; label in muted small-caps EB Garamond;
// value in large Cinzel; optional muted italic note.
const ACCENT_BG = {
  gold:  'bg-gold',
  green: 'bg-status-green',
  amber: 'bg-status-amber',
  red:   'bg-status-red',
  blue:  'bg-status-blue',
}

function MetricCard({ label, value, note, accent = 'gold' }) {
  const barClass = ACCENT_BG[accent] || ACCENT_BG.gold
  return (
    <div className="bg-cream-highlight rounded-lg overflow-hidden">
      <div className={`h-[3px] ${barClass}`} />
      <div className="px-4 py-3.5">
        <div className="font-body text-[11px] text-muted uppercase tracking-wider mb-1">
          {label}
        </div>
        <div className="font-display text-[22px] text-navy font-normal leading-tight">
          {value}
        </div>
        {note && (
          <div className="font-body text-[11px] text-muted mt-1 italic">
            {note}
          </div>
        )}
      </div>
    </div>
  )
}

export default MetricCard
