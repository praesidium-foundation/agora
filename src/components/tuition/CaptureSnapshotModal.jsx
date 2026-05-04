import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useToast } from '../../lib/Toast'
import FieldLabel from '../FieldLabel'

// Capture Tuition Audit Snapshot modal.
//
// v3.8.17 (Tuition-B2-final-fixes). The reason taxonomy from v3.8.16
// is dropped — schools have varying operational calendars and the
// taxonomy added rigidity without analytical value. The freeform
// `snapshot_label` field already conveys what the operator wants to
// communicate about the snapshot's purpose.
//
// Calls capture_tuition_audit_snapshot(p_scenario_id, p_snapshot_
// label) — two-arg signature introduced in Migration 039.
//
// Props:
//   scenario   — active Stage 2 scenario row
//   ayeLabel   — optional; not used in v3.8.17 (the auto-suggested
//                label was retired alongside the reason taxonomy);
//                kept in props for back-compat in case the parent
//                still passes it.
//   onCancel   — () => void
//   onSuccess  — (newSnapshotId) => void

export default function CaptureSnapshotModal({ scenario, ayeLabel, onCancel, onSuccess }) {
  // ayeLabel is intentionally unused in v3.8.17 — kept in props for
  // call-site back-compat. Reference once to silence unused-var lint.
  void ayeLabel

  const toast = useToast()
  const [label, setLabel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, submitting])

  const labelTrimmed = label.trim()
  const canSubmit = !submitting && !!scenario?.id && labelTrimmed.length > 0

  async function handleConfirm() {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const { data, error } = await supabase.rpc('capture_tuition_audit_snapshot', {
        p_scenario_id: scenario.id,
        p_snapshot_label: labelTrimmed,
      })
      if (error) throw error
      const newId = Array.isArray(data) ? data[0] : data
      toast.success(`Snapshot captured: ${labelTrimmed}`)
      onSuccess?.(newId)
    } catch (e) {
      setSubmitError(e.message || String(e))
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
      onClick={() => !submitting && onCancel()}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-xl w-full p-0 shadow-lg max-h-[90vh] overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="capture-snapshot-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="capture-snapshot-title"
            className="font-display text-navy text-[18px] leading-tight"
          >
            Capture Tuition Audit Snapshot
          </h3>
          <button
            type="button"
            onClick={() => !submitting && onCancel()}
            disabled={submitting}
            aria-label="Close"
            className="text-muted hover:text-navy text-[18px] leading-none disabled:opacity-30"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto">
          <p className="text-body text-sm leading-relaxed mb-4">
            Snapshots preserve the current state of the Tuition Audit at a
            specific point in time. Use snapshots to record reference
            points throughout the school year. Snapshots can be reviewed
            via the Snapshots link in the page header.
          </p>

          <FieldLabel htmlFor="snapshot-label">
            Snapshot label (required)
          </FieldLabel>
          <input
            id="snapshot-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What does this snapshot represent?"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault()
                handleConfirm()
              }
            }}
            className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none"
          />
          <p className="font-body text-[11px] text-muted italic mt-1.5">
            Examples: "End of Fall 2025", "Mid-year reference 2/15/26",
            "Pre-board-meeting".
          </p>

          {submitError && (
            <p className="text-status-red text-sm mt-4" role="alert">
              {submitError}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-4 px-6 py-4 border-t-[0.5px] border-card-border">
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
            onClick={handleConfirm}
            disabled={!canSubmit}
            className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Capturing…' : 'Capture Snapshot'}
          </button>
        </div>
      </div>
    </div>
  )
}
