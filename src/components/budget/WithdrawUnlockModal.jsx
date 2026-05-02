import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import {
  UNLOCK_REASON_COPY,
  UNLOCK_TEXT_MIN_LENGTH,
  validateUnlockWithdraw,
} from '../../lib/budgetUnlock'
import FieldLabel from '../FieldLabel'

// Modal driving the withdraw branch of reject_budget_stage_unlock.
//
// Same RPC as reject — the function detects the path by comparing the
// caller to scenario.unlock_requested_by. Caller IS the requester →
// recorded as 'unlock_withdrawn' with the user's reason text. The
// scenario stays locked; all unlock fields clear.
//
// Withdraw is housekeeping: cancelling your own request because you
// changed your mind, gathered more information, etc. Treatment is
// muted/secondary, not destructive — different from rejecting
// someone else's request.
//
// Props:
//   scenario     — active scenario row
//   currentUser  — { id }; must be == scenario.unlock_requested_by
//   onCancel     — () => void
//   onSuccess    — () => void; parent triggers refetch
export default function WithdrawUnlockModal({
  scenario,
  currentUser,
  onCancel,
  onSuccess,
}) {
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

  const validation = validateUnlockWithdraw(scenario, reason, currentUser)
  const canSubmit = validation.ok

  const trimmedLength = reason.trim().length
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
      const { error } = await supabase.rpc('reject_budget_stage_unlock', {
        p_scenario_id: scenario.id,
        p_reason: reason.trim(),
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
        aria-labelledby="withdraw-unlock-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="withdraw-unlock-title"
            className="font-display text-navy text-[18px] leading-tight"
          >
            Withdraw unlock request
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
            Withdraws your unlock request on{' '}
            <strong className="font-medium">{scenario.scenario_label}</strong>.
            The scenario stays locked. You can file a new request later
            if needed; the original justification and this withdrawal
            reason both remain in the audit log.
          </p>

          <FieldLabel htmlFor="withdraw-reason">
            Why are you withdrawing? (required)
          </FieldLabel>
          <textarea
            id="withdraw-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="A short note for the audit log — e.g. waiting on board input, no longer needed, request was premature."
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
            className="bg-white text-body border-[0.5px] border-card-border px-4 py-2 rounded text-sm font-body hover:bg-cream-highlight transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Submitting…' : 'Withdraw request'}
          </button>
        </div>
      </div>
    </div>
  )
}
