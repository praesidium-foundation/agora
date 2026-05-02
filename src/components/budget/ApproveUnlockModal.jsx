import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import {
  UNLOCK_REASON_COPY,
  validateUnlockApproval,
} from '../../lib/budgetUnlock'

// Modal that drives the approve_budget_stage_unlock RPC.
//
// v3.7 (two-identity model). Approval_1 is always already populated
// by the time this modal mounts — the requester's submission counts
// as approval_1 (Migration 021's request_budget_stage_unlock writes
// both request fields and approval_1 fields atomically). So this
// modal only ever handles approval_2 + the state transition. No more
// "first of two / final of two" branching — every approval through
// this modal is the final approval.
//
// Initiator separation is enforced at the DB layer (the function
// raises if the caller equals the requester) and at the application
// layer (canApproveUnlock in budgetUnlock.js returns
// {ok: false, reason: 'is_initiator'} for the requester). The parent
// only mounts this modal when canApproveUnlock is OK; the inline
// validation here is defense in depth.
//
// Props:
//   scenario          — active scenario row
//   currentUser       — { id }
//   hasApproveUnlock  — bool from useModulePermission
//   onCancel          — () => void
//   onSuccess         — () => void; parent triggers scenario refetch
//
// Display name for the requester is resolved internally from
// user_profiles. Self-contained so BudgetStage doesn't need to plumb
// the name through. The requester is also approval_1 under the
// two-identity model, so we only need one lookup.
export default function ApproveUnlockModal({
  scenario,
  currentUser,
  hasApproveUnlock,
  onCancel,
  onSuccess,
}) {
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

  const validation = validateUnlockApproval(scenario, currentUser, hasApproveUnlock)
  const canSubmit = validation.ok

  const requestedAt = scenario.unlock_requested_at
    ? new Date(scenario.unlock_requested_at).toLocaleString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    : '—'

  async function handleConfirm() {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const { error } = await supabase.rpc('approve_budget_stage_unlock', {
        p_scenario_id: scenario.id,
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
        aria-labelledby="approve-unlock-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="approve-unlock-title"
            className="font-display text-navy text-[18px] leading-tight"
          >
            Approve unlock
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
          {/* Request context. Justification text rendered in full,
              no truncation (§9.1 commitment — governance text is
              always visible). */}
          <div className="mb-4">
            <p className="font-display text-[11px] text-muted uppercase tracking-wider mb-1">
              Unlock request
            </p>
            <p className="font-body text-sm text-body leading-relaxed">
              Submitted by{' '}
              <strong className="font-medium">{requesterName || 'unknown user'}</strong>{' '}
              on <strong className="font-medium">{requestedAt}</strong>.
              Their submission counts as the first approval.
            </p>
            <div className="mt-2 px-3 py-2 bg-status-amber-bg border-[0.5px] border-status-amber/25 rounded text-sm">
              <p className="font-body text-[11px] text-status-amber uppercase tracking-wider mb-1">
                Justification
              </p>
              <p className="text-body italic leading-relaxed whitespace-pre-wrap">
                {scenario.unlock_request_justification || '—'}
              </p>
            </div>
          </div>

          {/* Consequence framing. Approval here is always the second
              of two and triggers the state transition. */}
          <p className="font-body text-sm text-body leading-relaxed mt-3 pt-3 border-t-[0.5px] border-card-border">
            You are recording the second approval of this unlock
            request. <strong className="font-medium">Confirming will
            transition this scenario to drafting</strong> and clear all
            unlock approval state. The locked snapshot remains in audit
            history.
          </p>

          {!validation.ok && validation.reason && (
            <p className="font-body text-status-amber text-sm italic mt-3" role="alert">
              {UNLOCK_REASON_COPY[validation.reason] || 'You cannot approve this request.'}
            </p>
          )}
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
            {submitting ? 'Submitting…' : 'Approve and unlock'}
          </button>
        </div>
      </div>
    </div>
  )
}
