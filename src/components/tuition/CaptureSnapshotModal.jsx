import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useToast } from '../../lib/Toast'
import FieldLabel from '../FieldLabel'

// Capture Tuition Audit Snapshot modal.
//
// v3.8.16 (Tuition-B2-final). Stage 2 (Tuition Audit) is a living
// working document — there is no lock workflow. Snapshots are
// operator-triggered reference points captured throughout the
// school year (end of fall semester, mid-year, end of school year).
//
// Calls capture_tuition_audit_snapshot(p_scenario_id, p_snapshot_
// reason, p_snapshot_label) RPC introduced in Migration 038.
//
// Reason taxonomy (matches the CHECK constraint on
// tuition_worksheet_snapshots.snapshot_reason):
//   - midyear_reference     (default)
//   - fall_semester_end
//   - spring_semester_end
//   - school_year_end
//   - other                 (label required)
//
// Props:
//   scenario   — active Stage 2 scenario row (for the AYE label
//                in the auto-populated label suggestion)
//   ayeLabel   — e.g. "AYE 2026"
//   onCancel   — () => void
//   onSuccess  — (newSnapshotId) => void; parent shows toast and
//                refreshes the snapshots panel if open

const REASON_OPTIONS = [
  { value: 'midyear_reference',  label: 'Mid-year reference' },
  { value: 'fall_semester_end',  label: 'End of fall semester' },
  { value: 'spring_semester_end', label: 'End of spring semester' },
  { value: 'school_year_end',    label: 'End of school year' },
  { value: 'other',              label: 'Other' },
]

function suggestedLabel(reason, ayeLabel) {
  const today = new Date()
  const dateStr = today.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
  switch (reason) {
    case 'midyear_reference':   return `Mid-year reference ${dateStr}`
    case 'fall_semester_end':   return `End of fall semester${ayeLabel ? ` ${ayeLabel}` : ''}`
    case 'spring_semester_end': return `End of spring semester${ayeLabel ? ` ${ayeLabel}` : ''}`
    case 'school_year_end':     return `End of school year${ayeLabel ? ` ${ayeLabel}` : ''}`
    case 'other':               return ''
    default:                    return ''
  }
}

export default function CaptureSnapshotModal({ scenario, ayeLabel, onCancel, onSuccess }) {
  const toast = useToast()
  const [reason, setReason] = useState('midyear_reference')
  const [label, setLabel] = useState(() => suggestedLabel('midyear_reference', ayeLabel))
  const [labelEditedManually, setLabelEditedManually] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, submitting])

  // When reason changes and the operator hasn't manually edited the
  // label, refresh the suggested label.
  function handleReasonChange(nextReason) {
    setReason(nextReason)
    if (!labelEditedManually) {
      setLabel(suggestedLabel(nextReason, ayeLabel))
    }
  }

  function handleLabelChange(nextLabel) {
    setLabel(nextLabel)
    setLabelEditedManually(true)
  }

  const labelTrimmed = label.trim()
  const labelRequired = reason === 'other'
  const canSubmit =
    !submitting &&
    !!scenario?.id &&
    (!labelRequired || labelTrimmed.length > 0)

  async function handleConfirm() {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const { data, error } = await supabase.rpc('capture_tuition_audit_snapshot', {
        p_scenario_id: scenario.id,
        p_snapshot_reason: reason,
        p_snapshot_label: labelTrimmed.length > 0 ? labelTrimmed : null,
      })
      if (error) throw error
      const newId = Array.isArray(data) ? data[0] : data
      toast.success(`Snapshot captured${labelTrimmed ? `: ${labelTrimmed}` : ''}.`)
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
            points throughout the school year — for example, at the end
            of fall semester, mid-year, or at year-end. Snapshots can be
            reviewed via the Snapshots link in the page header.
          </p>

          <FieldLabel htmlFor="snapshot-reason">
            Snapshot reason
          </FieldLabel>
          <div id="snapshot-reason" role="radiogroup" className="space-y-1.5 mt-1">
            {REASON_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="snapshot-reason"
                  value={opt.value}
                  checked={reason === opt.value}
                  onChange={() => handleReasonChange(opt.value)}
                  className="accent-navy"
                />
                <span className="text-body">{opt.label}</span>
              </label>
            ))}
          </div>

          <div className="mt-5">
            <FieldLabel htmlFor="snapshot-label">
              Snapshot label{labelRequired ? ' (required)' : ' (optional)'}
            </FieldLabel>
            <input
              id="snapshot-label"
              type="text"
              value={label}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder={labelRequired ? 'Required when reason is "Other"' : 'Optional'}
              className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none"
            />
            <p className="font-body text-[11px] text-muted italic mt-1.5">
              Examples: "End of Fall 2025", "Pre-board-meeting reference".
              {!labelEditedManually && reason !== 'other' && (
                <> A default has been suggested; you may edit it.</>
              )}
            </p>
          </div>

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
