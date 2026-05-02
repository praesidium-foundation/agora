import { useEffect, useState } from 'react'
import {
  describeField,
  fetchLineHistory,
  formatAbsoluteTimestamp,
} from '../../lib/auditLog'

// Per-line audit history modal.
//
// Opens when the user clicks the small History affordance on any leaf
// row in BudgetDetailZone. Renders a chronological list of every
// change_log event that touched that specific budget_stage_lines row
// (creates, amount edits, deletes). Lock events are scenario-level so
// they're not duplicated here — see the activity feed for those.
//
// Props:
//   lineId        — uuid of the budget_stage_lines row
//   accountCode   — for the modal header
//   accountName   — for the modal header
//   onClose       — () => void
//
// Footer offers "Export as PDF" → /print/budget-line/:lineId/history
// and "Close".

export default function LineHistoryModal({ lineId, accountCode, accountName, onClose }) {
  const [events, setEvents] = useState(null)
  const [error, setError] = useState(null)
  const [order, setOrder] = useState('newest')

  // Initial fetch.
  useEffect(() => {
    let mounted = true
    setEvents(null)
    setError(null)
    ;(async () => {
      try {
        const data = await fetchLineHistory(lineId)
        if (mounted) setEvents(data)
      } catch (e) {
        if (mounted) setError(e.message || String(e))
      }
    })()
    return () => { mounted = false }
  }, [lineId])

  // Escape closes the modal.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ordered = events
    ? order === 'newest'
      ? events
      : [...events].reverse()
    : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
      onClick={onClose}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-2xl w-full p-0 shadow-lg max-h-[85vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="line-history-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <div>
            <h3
              id="line-history-title"
              className="font-display text-navy text-[18px] leading-tight"
            >
              History
            </h3>
            <p className="font-body text-muted text-[12px] mt-0.5">
              {accountCode ? `${accountCode} · ` : ''}{accountName}
            </p>
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

        <div className="flex items-center justify-between gap-3 px-6 py-2 border-b-[0.5px] border-card-border bg-cream-highlight/30">
          <span className="font-body text-muted text-[12px]">
            {ordered ? `${ordered.length} event${ordered.length === 1 ? '' : 's'}` : 'Loading…'}
          </span>
          <div className="flex items-center gap-2">
            <label className="font-body text-[11px] text-muted uppercase tracking-wider">
              Sort
            </label>
            <select
              value={order}
              onChange={(e) => setOrder(e.target.value)}
              className="bg-white border-[0.5px] border-card-border text-body px-2 py-1 rounded text-[12px]"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1">
          {error && (
            <p className="text-status-red text-sm" role="alert">{error}</p>
          )}
          {!error && events === null && (
            <p className="text-muted italic text-sm">Loading history…</p>
          )}
          {!error && events !== null && events.length === 0 && (
            <p className="text-muted italic text-sm">
              No history yet for this line.
            </p>
          )}
          {!error && ordered && ordered.length > 0 && (
            <ul className="space-y-2">
              {ordered.map((event, i) => (
                <EventRow key={`${event.changed_at}-${i}`} event={event} />
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 px-6 py-3 border-t-[0.5px] border-card-border">
          <a
            href={`/print/budget-line/${lineId}/history`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-body text-status-blue hover:underline text-sm"
          >
            Export as PDF
          </a>
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

// Single event row. Visual treatment varies by `event.kind`:
//   insert: subtle navy left rule
//   amount/edit: default
//   delete: red left rule
//   (lock/override never appear in line history but are handled
//    defensively for forward compatibility)
function EventRow({ event }) {
  const kindStyles = {
    insert: 'border-status-green',
    amount: 'border-card-border',
    edit:   'border-card-border',
    delete: 'border-status-red',
    lock:   'border-status-blue bg-status-blue-bg/40',
    override: 'border-status-amber bg-status-amber-bg/40',
    submit: 'border-status-amber',
    reject: 'border-status-amber',
    recommend: 'border-gold',
    // Unlock workflow kinds. Amber for in-progress (parallel to
    // override). Blue for completed (mirrors lock — both are
    // governance milestones at the symmetric ends of the
    // lock/unlock cycle). Red-muted for rejected (denial). Plain
    // muted for withdrawn (housekeeping, neutral).
    unlock_requested:        'border-status-amber bg-status-amber-bg/40',
    unlock_first_approval:   'border-status-amber bg-status-amber-bg/40',
    unlock_completed:        'border-status-blue bg-status-blue-bg/40',
    unlock_rejected:         'border-status-red bg-status-red-bg/30',
    unlock_withdrawn:        'border-card-border bg-cream-highlight/40',
  }
  const cls = kindStyles[event.kind] || 'border-card-border'

  // Strip system fields when rendering the diff list.
  const real = event.fields.filter(
    (f) => f.field_name !== '__insert__' && f.field_name !== '__delete__'
  )

  return (
    <li className={`pl-3 py-2 border-l-2 ${cls}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-body text-body text-sm font-medium">
          {labelForKind(event.kind)}
        </span>
        <span className="font-body text-muted text-[11px] tabular-nums whitespace-nowrap">
          {formatAbsoluteTimestamp(event.changed_at)}
        </span>
      </div>
      <p className="font-body text-muted text-[12px] mt-0.5">
        {event.changed_by_name || '(unknown user)'}
      </p>
      {(event.kind === 'insert' || event.kind === 'delete') && (
        <p className="font-body text-body text-[13px] mt-1 italic">
          {event.kind === 'insert'
            ? `Created with amount ${formatInsertAmount(event)}`
            : `Removed (last amount: ${formatDeleteAmount(event)})`}
        </p>
      )}
      {real.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {real.map((f, i) => (
            <li key={i} className="font-body text-body text-[13px]">
              {describeField(f)}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function labelForKind(kind) {
  switch (kind) {
    case 'insert':                return 'Created'
    case 'delete':                return 'Deleted'
    case 'amount':                return 'Amount changed'
    case 'edit':                  return 'Edited'
    case 'lock':                  return 'Scenario locked'
    case 'override':              return 'Override applied'
    case 'submit':                return 'Submitted for lock review'
    case 'reject':                return 'Rejected back to drafting'
    case 'recommend':             return 'Recommended status changed'
    case 'unlock_requested':      return 'Unlock requested'
    case 'unlock_first_approval': return 'Unlock — first approval'
    case 'unlock_completed':      return 'Unlock approved · returned to drafting'
    case 'unlock_rejected':       return 'Unlock request rejected'
    case 'unlock_withdrawn':      return 'Unlock request withdrawn'
    default:                      return 'Change'
  }
}

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
})

function formatInsertAmount(event) {
  const ins = event.fields.find((f) => f.field_name === '__insert__')
  if (!ins || !ins.new_value) return '—'
  return usd0.format(Number(ins.new_value.amount) || 0)
}
function formatDeleteAmount(event) {
  const del = event.fields.find((f) => f.field_name === '__delete__')
  if (!del || !del.old_value) return '—'
  return usd0.format(Number(del.old_value.amount) || 0)
}
