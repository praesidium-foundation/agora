import { useEffect, useState } from 'react'
import {
  fetchScenarioActivity,
  formatActivityTimestamp,
  summarizeEvent,
} from '../../lib/auditLog'

// Per-scenario activity feed — modal shell.
//
// Phase 2 polish (v3.6) relocated this from a cream-highlight banner
// above the budget detail to a "Recent Activity" link in the scenario
// tabs row. The link opens this modal.
//
// v3.8.10 (Tuition-D) generalized this from Budget-only to
// module-aware. Tuition reuses this exact component (mounted from
// TuitionWorksheet); the only per-module varying piece is the
// `moduleId` prop, which selects which scenario/line tables to read
// via MODULE_AUDIT_CONFIGS in src/lib/auditLog.js. The PDF export
// link is also moduleId-aware so the print route differs per module
// (Budget → /print/budget/.../activity; Tuition → not yet wired,
// renders as a text-only "(PDF in a future commit)").
//
// Props:
//   moduleId     — 'budget' | 'tuition' (selects audit config)
//   scenarioId   — uuid of the active scenario; refetches when it changes
//   accountsById — { [account_id]: { code, name } } map for resolving
//                  line events into "Curriculum/Book Fees ($0 → $9,750)"
//                  format. Budget passes through; Tuition passes null.
//   onClose      — () => void
//
// Filter state and count selections are local to the modal session.
// PDF export (when present) goes through the per-module print route
// which fetches its own data; in-app filter state is NOT transmitted
// to the print route.

const COUNT_OPTIONS = [
  { value: 10,    label: '10' },
  { value: 25,    label: '25' },
  { value: 50,    label: '50' },
  { value: 100,   label: '100' },
  { value: null,  label: 'All' },
]

const FILTER_OPTIONS = [
  { value: 'all',         label: 'All activity' },
  { value: 'governance',  label: 'Lock + override events only' },
  { value: 'edits',       label: 'Edits only' },
]

// Map event kinds to the filter buckets above.
function passesFilter(event, filter) {
  if (filter === 'all') return true
  if (filter === 'governance') {
    return ['lock', 'submit', 'reject', 'override', 'recommend',
      'unlock_requested', 'unlock_first_approval', 'unlock_completed',
      'unlock_rejected', 'unlock_withdrawn',
      // v3.8.17: tuition snapshot capture is an operator-driven
      // governance-flavored event — preserves state at a reference
      // point even though it doesn't change scenario state.
      'snapshot_captured',
      // v3.8.18: tuition bulk import accept/reject — operator-driven
      // events with material data consequences (accept commits rows;
      // reject is a recorded decline). Belong in governance bucket.
      'import_accepted', 'import_rejected'].includes(event.kind)
  }
  if (filter === 'edits') {
    return ['amount', 'edit', 'insert', 'delete'].includes(event.kind)
  }
  return true
}

export default function ActivityFeedModal({ moduleId = 'budget', scenarioId, accountsById, onClose }) {
  const [count, setCount] = useState(25)
  const [filter, setFilter] = useState('all')
  const [events, setEvents] = useState(null)
  const [error, setError] = useState(null)
  const [totalKnownEvents, setTotalKnownEvents] = useState(null)

  // Escape closes the modal (consistent with other modals).
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Fetch the unfiltered total once per scenarioId for the header
  // count display.
  useEffect(() => {
    if (!scenarioId) return
    let mounted = true
    ;(async () => {
      try {
        const all = await fetchScenarioActivity(moduleId, scenarioId, {
          limit: null,
          accountsById,
        })
        if (mounted) setTotalKnownEvents(all.length)
      } catch (_e) {
        if (mounted) setTotalKnownEvents(null)
      }
    })()
    return () => { mounted = false }
    // accountsById intentionally omitted: only re-fetch on scenarioId change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleId, scenarioId])

  // Fetch the displayed slice when count/filter/scenarioId changes.
  useEffect(() => {
    if (!scenarioId) return
    let mounted = true
    setError(null)
    setEvents(null)
    ;(async () => {
      try {
        const fetchLimit = count == null ? null : Math.max(count * 3, count)
        const all = await fetchScenarioActivity(moduleId, scenarioId, {
          limit: fetchLimit,
          accountsById,
        })
        if (!mounted) return
        const filtered = all.filter((e) => passesFilter(e, filter))
        const sliced = count == null ? filtered : filtered.slice(0, count)
        setEvents(sliced)
      } catch (e) {
        if (mounted) setError(e.message || String(e))
      }
    })()
    return () => { mounted = false }
    // accountsById intentionally omitted (see note above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleId, scenarioId, count, filter])

  const headerCount =
    totalKnownEvents == null
      ? null
      : `${totalKnownEvents} ${totalKnownEvents === 1 ? 'change' : 'changes'}`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
      onClick={onClose}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-3xl w-full p-0 shadow-lg max-h-[85vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-feed-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <div>
            <h3
              id="activity-feed-title"
              className="font-display text-navy text-[18px] leading-tight"
            >
              Recent Activity
            </h3>
            {headerCount && (
              <p className="font-body text-muted text-[12px] mt-0.5">
                {headerCount} on this scenario
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-navy text-[18px] leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap px-6 py-2 border-b-[0.5px] border-card-border bg-cream-highlight/30">
          <div className="flex items-center gap-2">
            <label className="font-body text-[11px] text-muted uppercase tracking-wider">
              Show
            </label>
            <select
              value={String(count)}
              onChange={(e) =>
                setCount(e.target.value === 'null' ? null : Number(e.target.value))
              }
              className="bg-white border-[0.5px] border-card-border text-body px-2 py-1 rounded text-[12px]"
            >
              {COUNT_OPTIONS.map((o) => (
                <option key={String(o.value)} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </select>

            <label className="font-body text-[11px] text-muted uppercase tracking-wider ml-3">
              Filter
            </label>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="bg-white border-[0.5px] border-card-border text-body px-2 py-1 rounded text-[12px]"
            >
              {FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          {moduleId === 'budget' ? (
            <a
              href={`/print/budget/${scenarioId}/activity`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-body text-status-blue hover:underline text-[12px]"
            >
              Export as PDF
            </a>
          ) : (
            // Per-module print routes are added when each module's
            // print surface ships. Tuition's print routes are queued
            // for Tuition-E.
            <span className="font-body text-muted italic text-[12px]">
              PDF export ships in a future commit
            </span>
          )}
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1">
          {error && (
            <p className="text-status-red text-sm" role="alert">{error}</p>
          )}
          {!error && events === null && (
            <p className="text-muted italic text-sm">Loading…</p>
          )}
          {!error && events !== null && events.length === 0 && (
            <p className="text-muted italic text-sm">
              No activity matches the current filter.
            </p>
          )}
          {!error && events && events.length > 0 && (
            <ul className="space-y-1.5">
              {events.map((event, i) => (
                <FeedRow key={`${event.changed_at}-${event.target_id}-${i}`} event={event} />
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-4 px-6 py-3 border-t-[0.5px] border-card-border">
          <button
            type="button"
            onClick={onClose}
            className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function FeedRow({ event }) {
  // Visual treatment per event kind. Lock and override get strong
  // distinct treatment per architecture §9.1 ("overrides documented,
  // not buried"). Other kinds get subtle left-border tints.
  const treatments = {
    lock:      'border-status-blue bg-status-blue-bg/40',
    override:  'border-status-amber bg-status-amber-bg/50',
    submit:    'border-status-amber',
    reject:    'border-status-amber',
    recommend: 'border-gold',
    insert:    'border-status-green',
    delete:    'border-status-red',
    amount:    'border-card-border',
    edit:      'border-card-border',
    // Unlock workflow kinds — amber for in-progress, blue for
    // completed (mirrors lock as a governance milestone), red-muted
    // for rejected, plain muted for withdrawn.
    unlock_requested:        'border-status-amber bg-status-amber-bg/50',
    unlock_first_approval:   'border-status-amber bg-status-amber-bg/40',
    unlock_completed:        'border-status-blue bg-status-blue-bg/40',
    unlock_rejected:         'border-status-red bg-status-red-bg/30',
    unlock_withdrawn:        'border-card-border bg-cream-highlight/40',
    // v3.8.17 (Tuition-B2-final-fixes): operator-captured snapshot.
    // Gold rule (the brand "operator reference" treatment) —
    // distinct from blue/lock and amber/in-progress.
    snapshot_captured:       'border-gold bg-cream-highlight/30',
    // v3.8.18 (Tuition-B2-import): bulk import events. Accept gets
    // a green left rule (material data addition, like the per-line
    // 'insert' treatment); reject gets a muted treatment
    // (declined-without-effect, similar to unlock_withdrawn).
    import_accepted:         'border-status-green bg-status-green-bg/20',
    import_rejected:         'border-card-border bg-cream-highlight/40',
  }
  const cls = treatments[event.kind] || 'border-card-border'
  const isGov = [
    'lock', 'override',
    'unlock_requested', 'unlock_first_approval', 'unlock_completed',
    'unlock_rejected', 'unlock_withdrawn',
    'snapshot_captured',
    'import_accepted', 'import_rejected',
  ].includes(event.kind)

  // Override events render the full justification text underneath the
  // summary (architectural commitment to override visibility).
  let overrideJustification = null
  if (event.kind === 'override') {
    const f = event.fields.find((x) => x.field_name === 'override_justification')
    if (f && f.new_value) overrideJustification = String(f.new_value)
  }

  // Lock-icon affordance: 🔒 for lock, 🔓 for unlock-completed.
  let icon = null
  if (event.kind === 'lock') icon = { glyph: '🔒', tone: 'text-status-blue' }
  if (event.kind === 'unlock_completed') icon = { glyph: '🔓', tone: 'text-status-blue' }
  // v3.8.17: no icon for snapshot_captured — the gold left rule on
  // the row (border-gold treatment in the kindStyles map above) is
  // the visual signal. NO emoji is added per the no-emoji discipline
  // established in B2a/B2-final.

  return (
    <li className={`pl-3 pr-2 py-1.5 border-l-2 ${cls} ${isGov ? 'rounded-r' : ''}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          {icon && (
            <span className={`${icon.tone} text-[12px]`} aria-hidden="true">{icon.glyph}</span>
          )}
          <span className="font-body text-body text-[13px]">
            <span className="text-muted">{event.changed_by_name || '(unknown)'}</span>
            {' — '}
            {summarizeEvent(event)}
          </span>
        </div>
        <span className="font-body text-muted text-[11px] tabular-nums whitespace-nowrap flex-shrink-0">
          {formatActivityTimestamp(event.changed_at)}
        </span>
      </div>
      {overrideJustification && (
        <p className="font-body text-status-amber text-[12px] italic mt-1">
          Justification: "{overrideJustification}"
        </p>
      )}
    </li>
  )
}
