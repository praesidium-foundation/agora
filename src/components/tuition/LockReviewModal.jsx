import { useEffect, useState } from 'react'
import {
  approveAndLockTuitionScenario,
  rejectTuitionScenarioLock,
} from '../../lib/tuitionWorksheet'

// Approver-facing modal for a Tuition scenario in pending_lock_review.
//
// Two action paths share this modal: Approve (calls
// lock_tuition_scenario RPC) and Reject (calls reject_tuition_
// scenario_lock RPC with a required reason). Which one runs depends
// on which button the user clicks.
//
// Why one modal for two actions: both actions are pending-state
// terminations, both surface the same scenario context, and a unified
// modal makes the "I want to consider both" workflow one click. The
// inline reason textarea sits dormant until the user picks Reject,
// at which point it becomes required.
//
// The submitted justification (if the lock was originally submitted
// with override) renders inline at the top so the approver can read
// the override reasoning before deciding.
//
// Props:
//   scenario   — active scenario row (state = 'pending_lock_review')
//   onCancel   — () => void
//   onSuccess  — () => void; parent triggers refetch
export default function LockReviewModal({ scenario, onCancel, onSuccess }) {
  const [mode, setMode] = useState('choose')   // 'choose' | 'reject' (intermediate state for capturing reason)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, submitting])

  const isOverride = scenario.locked_via === 'override'

  async function handleApprove() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      await approveAndLockTuitionScenario({
        scenarioId: scenario.id,
        // Pass through the locked_via the submitter chose. The RPC
        // re-validates that override carries justification text.
        lockedVia: scenario.locked_via || 'cascade',
        overrideJustification: scenario.override_justification || null,
      })
      onSuccess?.()
    } catch (e) {
      setSubmitError(e.message || String(e))
      setSubmitting(false)
    }
  }

  async function handleReject() {
    const trimmed = reason.trim()
    if (trimmed.length < 10) {
      setSubmitError('A reason of at least 10 characters is required to reject.')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      await rejectTuitionScenarioLock({
        scenarioId: scenario.id,
        reason: trimmed,
      })
      onSuccess?.()
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
        aria-labelledby="tuition-lock-review-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="tuition-lock-review-title"
            className="font-display text-navy text-[18px] leading-tight"
          >
            {mode === 'reject' ? 'Reject lock review' : 'Lock review'}
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
          <p className="font-body text-sm text-body leading-relaxed mb-3">
            <strong className="font-medium">{scenario.scenario_label}</strong> is{' '}
            <strong className="font-medium">PENDING LOCK REVIEW</strong>.
            Approving locks the scenario and creates the immutable tuition
            schedule that families will sign agreements against. Rejecting
            returns it to drafting.
          </p>

          {isOverride && scenario.override_justification && (
            <div className="mb-4 px-3 py-2 bg-status-amber-bg border-[0.5px] border-status-amber/25 rounded text-sm">
              <p className="font-body text-[11px] text-status-amber uppercase tracking-wider mb-1">
                Submitted with override · Justification
              </p>
              <p className="text-body italic leading-relaxed whitespace-pre-wrap">
                {scenario.override_justification}
              </p>
            </div>
          )}

          {mode === 'reject' && (
            <div className="mt-3">
              <label
                htmlFor="tuition-lock-reject-reason"
                className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5"
              >
                Reason for rejection (required)
              </label>
              <textarea
                id="tuition-lock-reject-reason"
                value={reason}
                onChange={(e) => { setReason(e.target.value); setSubmitError(null) }}
                rows={4}
                placeholder="Explain why this scenario should not be locked. The reason is recorded permanently in the audit log."
                className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none"
                required
              />
              <p className="font-body text-[11px] text-muted italic mt-1.5">
                Minimum 10 characters.
              </p>
            </div>
          )}

          {submitError && (
            <p className="text-status-red text-sm mt-4" role="alert">
              {submitError}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t-[0.5px] border-card-border">
          {mode === 'reject' ? (
            <>
              <button
                type="button"
                onClick={() => { setMode('choose'); setReason(''); setSubmitError(null) }}
                disabled={submitting}
                className="font-body text-muted hover:text-navy text-sm disabled:opacity-30"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleReject}
                disabled={submitting || reason.trim().length < 10}
                className="bg-status-red text-white border-[0.5px] border-status-red px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Submitting…' : 'Reject and return to drafting'}
              </button>
            </>
          ) : (
            <>
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
                onClick={() => setMode('reject')}
                disabled={submitting}
                className="bg-white text-status-red border-[0.5px] border-status-red/40 px-4 py-2 rounded text-sm font-body hover:bg-status-red-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Reject…
              </button>
              <button
                type="button"
                onClick={handleApprove}
                disabled={submitting}
                className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Locking…' : 'Approve and lock'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
