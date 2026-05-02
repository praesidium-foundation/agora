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
// tabs row. The link opens this modal. The internal feed UI (count
// dropdown, filter dropdown, FeedRow list, PDF export link) is
// unchanged from the prior inline-panel version — only the shell
// changed (panel → modal).
//
// Why a modal: visual weight reduction. The cream-highlight banner
// competed with the Income heading; a right-aligned text link in the
// tabs row is appropriately sized for an audit affordance, and the
// modal pattern matches LineHistoryModal / SubmitLockModal — the
// established convention for "open a focused governance surface".
//
// Props:
//   scenarioId   — uuid of the active scenario; refetches when it changes
//   accountsById — { [account_id]: { code, name } } map for resolving
//                  line events into "Curriculum/Book Fees ($0 → $9,750)"
//                  format. BudgetStage already loads accounts; pass
//                  through.
//   onClose      — () => void
//
// Filter state and count selections are local to the modal session —
// closing and reopening resets to defaults (25 events, all activity).
// PDF export goes through /print/budget/:scenarioId/activity which
// fetches its own data; in-app filter state is NOT transmitted to the
// print route (architectural commitment: PDFs are reproducible from
// the URL alone).

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
      'unlock_rejected', 'unlock_withdrawn'].includes(event.kind)
  }
  if (filter === 'edits') {
    return ['amount', 'edit', 'insert', 'delete'].includes(event.kind)
  }
  return true
}

export default function ActivityFeedModal({ scenarioId, accountsById, onClose }) {
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
        const all = await fetchScenarioActivity(scenarioId, {
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
  }, [scenarioId])

  // Fetch the displayed slice when count/filter/scenarioId changes.
  useEffect(() => {
    if (!scenarioId) return
    let mounted = true
    setError(null)
    setEvents(null)
    ;(async () => {
      try {
        const fetchLimit = count == null ? null : Math.max(count * 3, count)
        const all = await fetchScenarioActivity(scenarioId, {
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
  }, [scenarioId, count, filter])

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
          <a
            href={`/print/budget/${scenarioId}/activity`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-body text-status-blue hover:underline text-[12px]"
          >
            Export as PDF
          </a>
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
  }
  const cls = treatments[event.kind] || 'border-card-border'
  const isGov = [
    'lock', 'override',
    'unlock_requested', 'unlock_first_approval', 'unlock_completed',
    'unlock_rejected', 'unlock_withdrawn',
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
