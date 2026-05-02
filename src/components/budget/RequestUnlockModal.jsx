import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import {
  UNLOCK_REASON_COPY,
  UNLOCK_TEXT_MIN_LENGTH,
  validateUnlockRequest,
} from '../../lib/budgetUnlock'
import FieldLabel from '../FieldLabel'

// Modal that drives the request_budget_stage_unlock RPC.
//
// Why a modal: per §8.13, the unlock workflow is governance-weight.
// Inline-banner request would feel too casual for an action that
// kicks off a multi-approver process. Modal forces a deliberate
// confirmation pause and gives the user a focused space to write the
// justification.
//
// Validation:
//   - Pre-submit: validateUnlockRequest combines permission +
//     state gates with non-empty + min-length content check.
//   - Server-side: H1's request_budget_stage_unlock raises if the
//     justification is empty/whitespace OR the scenario isn't locked
//     OR an unlock is already pending. We mirror the rules in the
//     validator so users learn before round-tripping.
//
// Props:
//   scenario          — the active scenario row (must be locked)
//   currentUser       — { id }
//   hasSubmitLock     — bool from useModulePermission
//   onCancel          — () => void
//   onSuccess         — () => void; parent triggers scenario refetch
export default function RequestUnlockModal({
  scenario,
  currentUser,
  hasSubmitLock,
  onCancel,
  onSuccess,
}) {
  const [justification, setJustification] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  // Escape closes (consistent with SubmitLockModal).
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
    hasSubmitLock,
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
      const { error } = await supabase.rpc('request_budget_stage_unlock', {
        p_scenario_id: scenario.id,
        p_justification: justification.trim(),
      })
      if (error) throw error
      onSuccess?.()
    } catch (e) {
      setSubmitError(e.message || String(e))
      setSubmitting(false)
    }
    // On success the parent closes the modal and refetches; no need
    // to reset submitting locally.
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
        aria-labelledby="request-unlock-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="request-unlock-title"
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
            Unlocking returns{' '}
            <strong className="font-medium">{scenario.scenario_label}</strong>{' '}
            to drafting after two distinct approvers (other than you) confirm.
            The locked snapshot remains in audit history; this only reopens
            the live working copy.
          </p>

          <FieldLabel htmlFor="unlock-justification">
            Justification (required)
          </FieldLabel>
          <textarea
            id="unlock-justification"
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            rows={4}
            placeholder="Why does this scenario need to be unlocked? Surface the change driving this — e.g. updated tuition schedule, corrected staffing assumption, board-requested revision."
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
                {UNLOCK_REASON_COPY[validation.reason] || 'Cannot submit'}
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
