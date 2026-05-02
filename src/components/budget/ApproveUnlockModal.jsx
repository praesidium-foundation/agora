import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import {
  UNLOCK_REASON_COPY,
  validateUnlockApproval,
} from '../../lib/budgetUnlock'

// Modal that drives the approve_budget_stage_unlock RPC.
//
// The RPC behavior depends on prior state — first call records
// approval 1 and returns 'first_approval_recorded'; second call (by a
// different user) flips state to 'drafting' and clears unlock fields,
// returning 'unlock_completed'. The modal title and copy adapt by
// inspecting unlock_approval_1_at on the scenario row:
//
//   approval_1_at IS NULL  → "Approve unlock — first of two"
//   approval_1_at NOT NULL → "Approve unlock — final approval"
//                            (emphasize the consequence: state flips)
//
// Initiator separation, two-distinct-approvers, and state
// preconditions are checked in budgetUnlock.js (validateUnlockApproval)
// — but the parent only mounts this modal when canApproveUnlock is OK.
// We re-check at click time as defense in depth.
//
// Props:
//   scenario          — active scenario row
//   currentUser       — { id }
//   hasApproveUnlock  — bool
//   onCancel          — () => void
//   onSuccess         — (rpcReturn: 'first_approval_recorded'
//                                  | 'unlock_completed') => void
//
// Display names for unlock_requested_by and unlock_approval_1_by are
// resolved internally from user_profiles — same pattern as the
// LockedBanner component. Self-contained so BudgetStage doesn't need
// to plumb the names through.
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
  const [firstApproverName, setFirstApproverName] = useState(null)

  const isFinalApproval = scenario.unlock_approval_1_at != null

  // Resolve display names. Mirrors the internal fetch in LockedBanner.
  useEffect(() => {
    let mounted = true
    const targets = []
    if (scenario.unlock_requested_by) targets.push(scenario.unlock_requested_by)
    if (scenario.unlock_approval_1_by) targets.push(scenario.unlock_approval_1_by)
    if (targets.length === 0) return
    ;(async () => {
      const { data } = await supabase
        .from('user_profiles')
        .select('id, full_name')
        .in('id', targets)
      if (!mounted) return
      const byId = new Map((data || []).map((u) => [u.id, u.full_name]))
      setRequesterName(scenario.unlock_requested_by ? byId.get(scenario.unlock_requested_by) || null : null)
      setFirstApproverName(scenario.unlock_approval_1_by ? byId.get(scenario.unlock_approval_1_by) || null : null)
    })()
    return () => { mounted = false }
  }, [scenario.unlock_requested_by, scenario.unlock_approval_1_by])

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
  const firstApprovedAt = scenario.unlock_approval_1_at
    ? new Date(scenario.unlock_approval_1_at).toLocaleString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    : null

  async function handleConfirm() {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const { data, error } = await supabase.rpc('approve_budget_stage_unlock', {
        p_scenario_id: scenario.id,
      })
      if (error) throw error
      onSuccess?.(data)
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
            {isFinalApproval
              ? 'Approve unlock — final approval'
              : 'Approve unlock — first of two'}
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
          {/* Context: full request details, no truncation (§9.1
              commitment — governance text is always visible). */}
          <div className="mb-4">
            <p className="font-display text-[11px] text-muted uppercase tracking-wider mb-1">
              Unlock request
            </p>
            <p className="font-body text-sm text-body leading-relaxed">
              Requested by{' '}
              <strong className="font-medium">{requesterName || 'unknown user'}</strong>{' '}
              on <strong className="font-medium">{requestedAt}</strong>.
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

          {isFinalApproval && (
            <div className="mb-4">
              <p className="font-display text-[11px] text-muted uppercase tracking-wider mb-1">
                First approval
              </p>
              <p className="font-body text-sm text-body leading-relaxed">
                Recorded by{' '}
                <strong className="font-medium">
                  {firstApproverName || 'unknown user'}
                </strong>{' '}
                on <strong className="font-medium">{firstApprovedAt}</strong>.
              </p>
            </div>
          )}

          {/* Consequence framing — always present. Final approval gets
              the louder version because it actually flips state. */}
          {isFinalApproval ? (
            <p className="font-body text-sm text-body leading-relaxed mt-3 pt-3 border-t-[0.5px] border-card-border">
              <strong className="font-medium">Approving now will return this scenario to drafting</strong>{' '}
              and clear all unlock approval state. The locked snapshot
              remains in audit history; this reopens the live working copy.
            </p>
          ) : (
            <p className="font-body text-sm text-muted leading-relaxed mt-3 pt-3 border-t-[0.5px] border-card-border">
              Approving now records your approval as the first of two.
              The scenario stays locked until a second approver
              (different from both you and the requester) confirms.
            </p>
          )}

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
            {submitting
              ? 'Submitting…'
              : isFinalApproval
                ? 'Approve unlock and reopen'
                : 'Record first approval'}
          </button>
        </div>
      </div>
    </div>
  )
}
