import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import {
  TUITION_LOCK_REASON_COPY,
  UNLOCK_TEXT_MIN_LENGTH,
  validateUnlockRejection,
} from '../../lib/tuitionWorksheet'
import FieldLabel from '../FieldLabel'

// Modal driving the reject branch of reject_tuition_scenario_unlock.
//
// Same RPC as withdraw — Migration 025's function auto-detects by
// comparing auth.uid() to scenario.unlock_requested_by. Caller is
// NOT the requester → recorded as 'unlock_rejected'. Caller IS the
// requester → recorded as 'unlock_withdrawn'. The two modals are
// deliberately distinct UI even though they share the RPC.
//
// Mirrors src/components/budget/RejectUnlockModal.jsx in shape.
export default function RejectUnlockModal({
  scenario,
  currentUser,
  hasApproveUnlock,
  onCancel,
  onSuccess,
}) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [requesterName, setRequesterName] = useState(null)

  useEffect(() => {
    let mounted = true
    if (!scenario.unlock_requested_by) return
    ;(async () => {
      const { data } = await supabase
        .from('user_profiles')
        .select('full_name')
        .eq('id', scenario.unlock_requested_by)
        .maybeSingle()
      if (mounted) setRequesterName(data?.full_name || null)
    })()
    return () => { mounted = false }
  }, [scenario.unlock_requested_by])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, submitting])

  const validation = validateUnlockRejection(scenario, reason, currentUser, hasApproveUnlock)
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
      const { error } = await supabase.rpc('reject_tuition_scenario_unlock', {
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
        aria-labelledby="tuition-reject-unlock-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="tuition-reject-unlock-title"
            className="font-display text-navy text-[18px] leading-tight"
          >
            Reject unlock request
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
            You're rejecting{' '}
            <strong className="font-medium">{requesterName || 'the requester'}</strong>'s
            request to unlock{' '}
            <strong className="font-medium">{scenario.scenario_label}</strong>.
            The scenario stays locked. {requesterName || 'They'} will need to
            file a new request if they want to proceed.
          </p>

          <FieldLabel htmlFor="tuition-reject-reason">
            Reason for rejection (required)
          </FieldLabel>
          <textarea
            id="tuition-reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            placeholder="Explain why this unlock should not proceed. The reason is recorded permanently in the audit log alongside the original request."
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
            className="bg-status-red text-white border-[0.5px] border-status-red px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Submitting…' : 'Reject unlock request'}
          </button>
        </div>
      </div>
    </div>
  )
}
