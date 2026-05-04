import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useToast } from '../../lib/Toast'

// Snapshots side panel for the Tuition Audit page.
//
// v3.8.16 (Tuition-B2-final). Slide-out right-side panel listing
// every snapshot for the active Stage 2 scenario, chronological
// (newest first). Each row shows the snapshot reason, the operator-
// provided label (or a synthesized one for legacy lock snapshots),
// captured_at timestamp, and the captured-by name.
//
// Per-row "View" affordance is a stub for B2-final — the read-only
// snapshot view (full Tuition Audit page rendered against the
// snapshot data) ships in a future Tuition-E session. For now the
// button shows a toast directing users to the eventual feature.
//
// Props:
//   scenarioId  — uuid of the active Stage 2 scenario
//   onClose     — () => void
//   refreshKey  — incrementing number that triggers re-fetch (used by
//                  the parent to reload after a new snapshot is
//                  captured)

const REASON_LABELS = {
  lock:                  'Lock snapshot',
  midyear_reference:     'Mid-year reference',
  fall_semester_end:     'End of fall semester',
  spring_semester_end:   'End of spring semester',
  school_year_end:       'End of school year',
  other:                 'Other',
}

export default function SnapshotsPanel({ scenarioId, onClose, refreshKey = 0 }) {
  const toast = useToast()
  const [snapshots, setSnapshots] = useState(null)
  const [error, setError] = useState(null)
  const [capturerNames, setCapturerNames] = useState({})

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Load snapshots for this scenario.
  useEffect(() => {
    if (!scenarioId) return
    let mounted = true
    setSnapshots(null)
    setError(null)
    ;(async () => {
      const { data, error: queryError } = await supabase
        .from('tuition_worksheet_snapshots')
        .select('id, snapshot_reason, snapshot_label, captured_at, locked_by, locked_by_name_at_lock, locked_via, scenario_label_at_lock')
        .eq('scenario_id', scenarioId)
        .order('captured_at', { ascending: false })
      if (!mounted) return
      if (queryError) {
        setError(queryError.message)
        return
      }
      setSnapshots(data || [])

      // Resolve capturer names. The captured-by-value
      // locked_by_name_at_lock column is the durable identity field
      // (the user row may be deleted later), so we use it directly
      // rather than re-resolving via user_profiles.
      const names = {}
      for (const snap of data || []) {
        if (snap.locked_by_name_at_lock) names[snap.id] = snap.locked_by_name_at_lock
      }
      setCapturerNames(names)
    })()
    return () => { mounted = false }
  }, [scenarioId, refreshKey])

  function handleViewSnapshot(snapshotId) {
    // The read-only snapshot view ships in Tuition-E. For now, surface
    // a toast directing users to the eventual feature.
    void snapshotId
    toast.success('Read-only snapshot view ships in a future Tuition-E session. The snapshot data is preserved in the database.')
  }

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-navy/30"
      onClick={onClose}
      role="presentation"
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        className="bg-cream border-l-[0.5px] border-card-border w-full max-w-md h-full flex flex-col shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snapshots-panel-title"
      >
        <header className="flex items-center justify-between px-5 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <div>
            <h3
              id="snapshots-panel-title"
              className="font-display text-navy text-[18px] leading-tight"
            >
              Tuition Audit Snapshots
            </h3>
            <p className="font-body text-muted text-[12px] mt-0.5">
              {snapshots == null
                ? 'Loading…'
                : snapshots.length === 0
                  ? 'No snapshots captured yet.'
                  : `${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}`}
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
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <p className="text-status-red text-sm" role="alert">{error}</p>
          )}
          {!error && snapshots == null && (
            <p className="text-muted italic text-sm">Loading snapshots…</p>
          )}
          {!error && snapshots && snapshots.length === 0 && (
            <p className="text-muted italic text-sm leading-relaxed">
              No snapshots have been captured for this scenario yet. Use
              the Capture Snapshot button to record the current state as
              a reference point.
            </p>
          )}
          {!error && snapshots && snapshots.length > 0 && (
            <ul className="space-y-3">
              {snapshots.map((snap) => (
                <SnapshotRow
                  key={snap.id}
                  snapshot={snap}
                  capturerName={capturerNames[snap.id] || snap.locked_by_name_at_lock}
                  onView={() => handleViewSnapshot(snap.id)}
                />
              ))}
            </ul>
          )}
        </div>

        <footer className="px-5 py-3 border-t-[0.5px] border-card-border">
          <button
            type="button"
            onClick={onClose}
            className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity"
          >
            Close
          </button>
        </footer>
      </aside>
    </div>
  )
}

function SnapshotRow({ snapshot, capturerName, onView }) {
  // Synthesize a reason label. snapshot_reason may be NULL on
  // pre-Migration-038 lock snapshots; infer 'lock' from locked_via
  // when reason is missing.
  const reason = snapshot.snapshot_reason
    || (snapshot.locked_via === 'snapshot' ? 'midyear_reference' : 'lock')
  const reasonLabel = REASON_LABELS[reason] || reason

  // Display label: operator-provided; fall back to reason label for
  // lock snapshots that have no label.
  const displayLabel = snapshot.snapshot_label || reasonLabel

  const capturedAtStr = snapshot.captured_at
    ? new Date(snapshot.captured_at).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    : '—'

  // Visual treatment by reason. Lock snapshots get a navy left rule
  // (governance milestone); operator snapshots get a muted gold rule
  // (working reference).
  const ruleClass = reason === 'lock'
    ? 'border-status-blue'
    : 'border-gold/60'

  return (
    <li className={`pl-3 py-2 border-l-2 ${ruleClass} bg-white border-[0.5px] border-card-border rounded-r`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-navy text-[14px] tracking-[0.04em]">
          {displayLabel}
        </span>
        <button
          type="button"
          onClick={onView}
          className="font-body text-status-blue hover:underline text-[12px] flex-shrink-0"
        >
          View
        </button>
      </div>
      <p className="font-body text-muted text-[11px] uppercase tracking-wider mt-0.5">
        {reasonLabel}
      </p>
      <p className="font-body text-body text-[12px] mt-1">
        Captured <strong className="font-medium">{capturedAtStr}</strong>
        {capturerName ? <> · by <strong className="font-medium">{capturerName}</strong></> : null}
      </p>
    </li>
  )
}
