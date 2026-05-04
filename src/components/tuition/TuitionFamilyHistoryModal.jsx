import { useEffect, useState } from 'react'
import {
  fetchFamilyNotesHistory,
  formatAbsoluteTimestamp,
} from '../../lib/auditLog'

// Per-family notes history modal.
//
// Mirrors src/components/budget/LineHistoryModal.jsx in shape — opens
// from a small clock affordance on the Notes column of each row in
// TuitionFamilyDetailsTable. Renders the chronological list of every
// change_log event that touched the family's `notes` field, plus the
// row's create / delete events for context.
//
// The clock affordance hides when scenario state is 'locked' per
// architecture §9.1's locked-state suppression rule. The activity
// feed (Stage 2 — queued for B2b) is the comprehensive audit surface
// in locked state.
//
// Props:
//   familyId    — uuid of the tuition_worksheet_family_details row
//   familyLabel — text label for the modal header (the family's name)
//   onClose     — () => void
//
// Footer: "Export as PDF" deferred to Tuition-E (rendered as a
// disabled link with tooltip) and a "Close" button.

export default function TuitionFamilyHistoryModal({ familyId, familyLabel, onClose }) {
  const [events, setEvents] = useState(null)
  const [error, setError] = useState(null)
  const [order, setOrder] = useState('newest')

  useEffect(() => {
    let mounted = true
    setEvents(null)
    setError(null)
    ;(async () => {
      try {
        const data = await fetchFamilyNotesHistory(familyId)
        if (mounted) setEvents(data)
      } catch (e) {
        if (mounted) setError(e.message || String(e))
      }
    })()
    return () => { mounted = false }
  }, [familyId])

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
        aria-labelledby="family-history-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <div>
            <h3
              id="family-history-title"
              className="font-display text-navy text-[18px] leading-tight"
            >
              {familyLabel || 'Family'} — Notes History
            </h3>
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
              No notes history yet for this family.
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
          <span
            className="font-body text-muted text-sm italic cursor-not-allowed"
            title="PDF export ships in Tuition-E."
          >
            Export as PDF
          </span>
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
//   insert: subtle green left rule
//   edit (notes change): default
//   delete: red left rule
function EventRow({ event }) {
  const kindStyles = {
    insert: 'border-status-green',
    edit:   'border-card-border',
    delete: 'border-status-red',
  }
  const cls = kindStyles[event.kind] || 'border-card-border'

  const notesField = event.fields.find((f) => f.field_name === 'notes')
  const insertField = event.fields.find((f) => f.field_name === '__insert__')
  const deleteField = event.fields.find((f) => f.field_name === '__delete__')

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
      {insertField && insertField.new_value && (
        <p className="font-body text-body text-[13px] mt-1 italic">
          Created with notes:{' '}
          <span className="not-italic">
            {insertField.new_value.notes
              ? `"${truncate(String(insertField.new_value.notes), 200)}"`
              : '(empty)'}
          </span>
        </p>
      )}
      {deleteField && deleteField.old_value && (
        <p className="font-body text-body text-[13px] mt-1 italic">
          Removed (last notes:{' '}
          <span className="not-italic">
            {deleteField.old_value.notes
              ? `"${truncate(String(deleteField.old_value.notes), 200)}"`
              : '(empty)'}
          </span>
          )
        </p>
      )}
      {notesField && (
        <div className="mt-1 space-y-1">
          <p className="font-body text-muted text-[12px]">
            From:{' '}
            <span className="text-body italic whitespace-pre-wrap">
              {notesField.old_value ? `"${String(notesField.old_value)}"` : '(empty)'}
            </span>
          </p>
          <p className="font-body text-muted text-[12px]">
            To:{' '}
            <span className="text-body italic whitespace-pre-wrap">
              {notesField.new_value ? `"${String(notesField.new_value)}"` : '(empty)'}
            </span>
          </p>
        </div>
      )}
    </li>
  )
}

function labelForKind(kind) {
  switch (kind) {
    case 'insert': return 'Family added'
    case 'delete': return 'Family removed'
    case 'edit':
    default:       return 'Notes updated'
  }
}

function truncate(s, max) {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}
