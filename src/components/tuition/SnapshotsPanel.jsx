import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useToast } from '../../lib/Toast'
import { useModulePermission } from '../../lib/usePermission'

// Snapshots side panel for the Tuition Audit page.
//
// v3.8.16 (Tuition-B2-final). Slide-out right-side panel listing
// every snapshot for the active Stage 2 scenario, chronological
// (newest first).
//
// v3.8.20 (Tuition-CrossModule-KPIs): per-row "Mark as Final Budget
// reference" affordance. The promoted snapshot anchors Final
// Budget's enrollment-dependent KPIs (Cost per Student, Tuition
// Gap, Break-even Enrollment); see §7.3 cross-module data flow.
// Only one snapshot per scenario can be the reference at a time;
// promotion is atomic (demote prior + promote new in one
// transaction).
//
// Per-row "View" affordance is a stub for B2-final — the read-only
// snapshot view ships in a future Tuition-E session.
//
// Props:
//   scenarioId  — uuid of the active Stage 2 scenario
//   ayeLabel    — optional; displayed in the promote-confirmation copy
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

export default function SnapshotsPanel({ scenarioId, ayeLabel, onClose, refreshKey = 0 }) {
  const toast = useToast()
  const { allowed: canEdit } = useModulePermission('tuition', 'edit')
  const [snapshots, setSnapshots] = useState(null)
  const [error, setError] = useState(null)
  const [capturerNames, setCapturerNames] = useState({})
  const [internalRefreshKey, setInternalRefreshKey] = useState(0)

  // Promotion confirmation modal state.
  // {snapshotId, snapshotLabel, currentRefId, currentRefLabel} | null
  const [promoteConfirm, setPromoteConfirm] = useState(null)
  const [promoting, setPromoting] = useState(false)

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !promoting) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, promoting])

  // Load snapshots for this scenario.
  useEffect(() => {
    if (!scenarioId) return
    let mounted = true
    setSnapshots(null)
    setError(null)
    ;(async () => {
      const { data, error: queryError } = await supabase
        .from('tuition_worksheet_snapshots')
        .select('id, snapshot_reason, snapshot_label, captured_at, locked_at, locked_by, locked_by_name_at_lock, locked_via, scenario_label_at_lock, stage_type_at_lock, is_final_budget_reference')
        .eq('scenario_id', scenarioId)
        .order('captured_at', { ascending: false })
      if (!mounted) return
      if (queryError) {
        setError(queryError.message)
        return
      }
      setSnapshots(data || [])

      const names = {}
      for (const snap of data || []) {
        if (snap.locked_by_name_at_lock) names[snap.id] = snap.locked_by_name_at_lock
      }
      setCapturerNames(names)
    })()
    return () => { mounted = false }
  }, [scenarioId, refreshKey, internalRefreshKey])

  function handleViewSnapshot(snapshotId) {
    void snapshotId
    toast.success('Read-only snapshot view ships in a future Tuition-E session. The snapshot data is preserved in the database.')
  }

  function handlePromoteClick(snap) {
    if (!canEdit) return
    const currentRef = (snapshots || []).find((s) => s.is_final_budget_reference)
    setPromoteConfirm({
      snapshotId:     snap.id,
      snapshotLabel:  snap.snapshot_label || synthesizeLabel(snap),
      currentRefId:   currentRef?.id || null,
      currentRefLabel: currentRef?.snapshot_label || (currentRef ? synthesizeLabel(currentRef) : null),
    })
  }

  async function performPromote() {
    if (!promoteConfirm) return
    setPromoting(true)
    try {
      const { error: rpcError } = await supabase.rpc('mark_snapshot_as_final_budget_reference', {
        p_snapshot_id: promoteConfirm.snapshotId,
      })
      if (rpcError) throw rpcError
      toast.success(`Snapshot marked as Final Budget reference: ${promoteConfirm.snapshotLabel}`)
      setPromoteConfirm(null)
      setInternalRefreshKey((k) => k + 1)
    } catch (e) {
      toast.error(e.message || String(e))
    } finally {
      setPromoting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-navy/30"
      onClick={() => !promoting && onClose()}
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
                  canEdit={canEdit}
                  onView={() => handleViewSnapshot(snap.id)}
                  onPromote={() => handlePromoteClick(snap)}
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

      {promoteConfirm && (
        <PromoteConfirmModal
          confirm={promoteConfirm}
          ayeLabel={ayeLabel}
          submitting={promoting}
          onCancel={() => !promoting && setPromoteConfirm(null)}
          onConfirm={performPromote}
        />
      )}
    </div>
  )
}

function SnapshotRow({ snapshot, capturerName, canEdit, onView, onPromote }) {
  const reason = snapshot.snapshot_reason
    || (snapshot.locked_via === 'snapshot' ? 'midyear_reference' : 'lock')
  const reasonLabel = REASON_LABELS[reason] || reason
  const displayLabel = snapshot.snapshot_label || reasonLabel

  const capturedAtStr = snapshot.captured_at
    ? new Date(snapshot.captured_at).toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    : '—'

  // Visual treatment by reason. Lock snapshots get a navy/blue rule
  // (governance milestone); operator snapshots get a muted gold rule
  // (working reference).
  const ruleClass = reason === 'lock'
    ? 'border-status-blue'
    : 'border-gold/60'

  // Final Budget reference promotion is only meaningful for Stage 2
  // (audit) snapshots — Stage 1 lock snapshots aren't eligible.
  const isAuditSnapshot = snapshot.stage_type_at_lock === 'final'
  const isReference = !!snapshot.is_final_budget_reference

  return (
    <li className={`pl-3 py-2 border-l-2 ${ruleClass} bg-white border-[0.5px] border-card-border rounded-r`}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <span className="font-display text-navy text-[14px] tracking-[0.04em]">
          {displayLabel}
        </span>
        <div className="flex items-center gap-3 flex-shrink-0">
          {isReference && (
            <span
              className="inline-block px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-gold border-[0.5px] border-gold/40 rounded"
              title="This snapshot is the Final Budget reference for the AYE"
            >
              Final Budget reference
            </span>
          )}
          <button
            type="button"
            onClick={onView}
            className="font-body text-status-blue hover:underline text-[12px]"
          >
            View
          </button>
        </div>
      </div>
      <p className="font-body text-muted text-[11px] uppercase tracking-wider mt-0.5">
        {reasonLabel}
      </p>
      <p className="font-body text-body text-[12px] mt-1">
        Captured <strong className="font-medium">{capturedAtStr}</strong>
        {capturerName ? <> · by <strong className="font-medium">{capturerName}</strong></> : null}
      </p>
      {isAuditSnapshot && !isReference && canEdit && (
        <div className="mt-2">
          <button
            type="button"
            onClick={onPromote}
            className="font-body text-[12px] text-navy hover:underline underline-offset-2"
            title="Promote this snapshot as the Final Budget reference for the AYE"
          >
            Mark as Final Budget reference
          </button>
        </div>
      )}
    </li>
  )
}

function PromoteConfirmModal({ confirm, ayeLabel, submitting, onCancel, onConfirm }) {
  const ayeText = ayeLabel ? `for ${ayeLabel}` : 'for this AYE'
  const replacingPrior = !!confirm.currentRefId && confirm.currentRefId !== confirm.snapshotId

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/40"
      onClick={onCancel}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-md w-full p-6 shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="promote-confirm-title"
      >
        <h3
          id="promote-confirm-title"
          className="font-display text-navy text-[18px] mb-2 leading-tight"
        >
          Mark as Final Budget reference?
        </h3>
        {replacingPrior ? (
          <p className="text-body text-sm leading-relaxed mb-4">
            This will replace the current Final Budget reference{' '}
            (currently:{' '}
            <strong className="font-medium">{confirm.currentRefLabel || '(unlabeled)'}</strong>)
            with{' '}
            <strong className="font-medium">{confirm.snapshotLabel}</strong>.
            The Final Budget {ayeText} will start reading from this
            snapshot's data instead. Confirm?
          </p>
        ) : (
          <p className="text-body text-sm leading-relaxed mb-4">
            Mark{' '}
            <strong className="font-medium">{confirm.snapshotLabel}</strong>{' '}
            as the Final Budget reference {ayeText}? Final Budget KPIs
            will read from this snapshot's data.
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="font-body text-muted hover:text-navy text-sm disabled:opacity-30"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Promoting…' : (replacingPrior ? 'Replace and Promote' : 'Promote')}
          </button>
        </div>
      </div>
    </div>
  )
}

function synthesizeLabel(snap) {
  if (snap.snapshot_label) return snap.snapshot_label
  const reason = snap.snapshot_reason
    || (snap.locked_via === 'snapshot' ? 'midyear_reference' : 'lock')
  return REASON_LABELS[reason] || reason
}
