import { useEffect, useMemo, useState } from 'react'
import {
  fetchScenarioActivity,
  formatActivityTimestamp,
  summarizeEvent,
} from '../../lib/auditLog'

// Per-scenario activity feed.
//
// Renders below the page header zone (under the breadcrumb/title) as a
// collapsible panel. Default state: collapsed, showing just the count
// of events. Click to expand into the chronological feed.
//
// Props:
//   scenarioId   — uuid of the active scenario; refetches when it changes
//   accountsById — { [account_id]: { code, name } } map for resolving
//                  line events into "Curriculum/Book Fees ($0 → $9,750)"
//                  format. BudgetStage already loads accounts; pass
//                  through.
//
// The feed fetches the most recent N events (default 25), with a count
// dropdown to bump up to 50/100/All. Filter dropdown narrows by event
// category. Each filter+count change triggers a refetch (cheap — events
// are scoped to the scenario).
//
// PDF export: footer link → /print/budget/:scenarioId/activity. The
// print route fetches its own data; in-app filter state is NOT
// transmitted (architectural commitment: PDFs are always reproducible
// from the route alone).

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
    return ['lock', 'submit', 'reject', 'override', 'recommend'].includes(event.kind)
  }
  if (filter === 'edits') {
    return ['amount', 'edit', 'insert', 'delete'].includes(event.kind)
  }
  return true
}

export default function ActivityFeedPanel({ scenarioId, accountsById }) {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState(25)
  const [filter, setFilter] = useState('all')
  const [events, setEvents] = useState(null)
  const [error, setError] = useState(null)
  // totalKnownEvents: the un-paginated count of events for the
  // collapsed-state label. Re-fetched once when the panel mounts (we
  // don't refetch on filter/count changes for that label — it's
  // intentionally the unfiltered total).
  const [totalKnownEvents, setTotalKnownEvents] = useState(null)

  // Fetch the unfiltered total once per scenarioId for the header.
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
    // accountsById intentionally omitted: only re-fetch on scenarioId
    // change. The displayed labels degrade gracefully if accountsById
    // arrives later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId])

  // Fetch the displayed slice when the panel is open and the
  // count/filter/scenarioId changes.
  useEffect(() => {
    if (!open || !scenarioId) return
    let mounted = true
    setError(null)
    setEvents(null)
    ;(async () => {
      try {
        // Always fetch up to count*2 to give the filter pass enough
        // headroom, then slice client-side. For 'All' we fetch all.
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
  }, [open, scenarioId, count, filter])

  const headerLabel = useMemo(() => {
    if (totalKnownEvents == null) return 'Recent Activity'
    return `Recent Activity (${totalKnownEvents} ${totalKnownEvents === 1 ? 'change' : 'changes'})`
  }, [totalKnownEvents])

  return (
    <section className="mt-3 border-[0.5px] border-card-border rounded bg-cream-highlight/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-4 py-2 hover:bg-cream-highlight/60 transition-colors text-left"
      >
        <span className="font-display text-navy text-[13px] tracking-[0.06em] uppercase">
          {headerLabel}
        </span>
        <span className="text-muted text-[12px]" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="border-t-[0.5px] border-card-border px-4 py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
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
      )}
    </section>
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
    // Unlock workflow kinds — see LineHistoryModal for the rationale
    // (amber for in-progress, blue for completed, red-muted for
    // rejected, plain muted for withdrawn).
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

  // Lock-icon affordance: 🔒 for lock, 🔓 for unlock-completed
  // (mirrors LockedBanner's icon language for the unlock states).
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
