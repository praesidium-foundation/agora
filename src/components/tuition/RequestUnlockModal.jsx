import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import {
  TUITION_LOCK_REASON_COPY,
  UNLOCK_TEXT_MIN_LENGTH,
  validateUnlockRequest,
} from '../../lib/tuitionWorksheet'
import FieldLabel from '../FieldLabel'

// Modal that drives the request_tuition_scenario_unlock RPC.
//
// v3.7 two-identity model: submitting this request atomically
// records the requester's approval as approval_1. One additional
// approver (different identity, also holding approve_unlock)
// completes the unlock by recording approval_2, which transitions
// state to drafting.
//
// Mirrors src/components/budget/RequestUnlockModal.jsx in shape.
//
// Props:
//   scenario          — the active scenario row (must be locked)
//   currentUser       — { id }
//   hasApproveUnlock  — bool from useModulePermission
//   onCancel          — () => void
//   onSuccess         — () => void; parent triggers scenario refetch
export default function RequestUnlockModal({
  scenario,
  currentUser,
  hasApproveUnlock,
  onCancel,
  onSuccess,
}) {
  const [justification, setJustification] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, submitting])

  const validation = validateUnlockRequest(
    scenario,
    justification,
    currentUser,
    hasApproveUnlock,
  )
  const canSubmit = validation.ok

  const trimmedLength = justification.trim().length
  const charCounterColor =
    trimmedLength === 0
      ? 'text-muted'
      : trimmedLength < UNLOCK_TEXT_MIN_LENGTH
        ? 'text-status-amber'
        : 'text-status-green'

  async function handleConfirm() {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const { error } = await supabase.rpc('request_tuition_scenario_unlock', {
        p_scenario_id: scenario.id,
        p_justification: justification.trim(),
      })
      if (error) throw error
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
        aria-labelledby="tuition-request-unlock-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="tuition-request-unlock-title"
            className="font-display text-navy text-[18px] leading-tight"
          >
            Request unlock
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
            Submitting records your approval as the first of two. One
            additional approver (different identity) must confirm to
            complete the unlock of{' '}
            <strong className="font-medium">{scenario.scenario_label}</strong>.
            The locked snapshot remains in audit history; this only
            reopens the live working copy. Tuition agreements families
            have already signed against the locked tier rates remain
            in force — unlock is for revising the planning forward.
          </p>

          <FieldLabel htmlFor="tuition-unlock-justification">
            Justification (required)
          </FieldLabel>
          <textarea
            id="tuition-unlock-justification"
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            rows={4}
            placeholder="Why does this scenario need to be unlocked? Surface the change driving this — e.g. tier rate revision, projected enrollment update, board-requested adjustment."
            className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none"
            required
          />

          <div className="flex items-center justify-between mt-1.5">
            <p className={`font-body text-[11px] ${charCounterColor}`}>
              {trimmedLength}/{UNLOCK_TEXT_MIN_LENGTH} characters
              {trimmedLength > 0 && trimmedLength < UNLOCK_TEXT_MIN_LENGTH
                ? ' — too short'
                : null}
            </p>
            {!validation.ok && validation.reason && trimmedLength >= UNLOCK_TEXT_MIN_LENGTH && (
              <p className="font-body text-[11px] text-status-amber italic">
                {TUITION_LOCK_REASON_COPY[validation.reason] || 'Cannot submit'}
              </p>
            )}
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
            disabled={submitting || !canSubmit}
            className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Submitting…' : 'Submit unlock request'}
          </button>
        </div>
      </div>
    </div>
  )
}
