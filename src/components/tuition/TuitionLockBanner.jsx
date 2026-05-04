import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import {
  canApproveLock,
  canApproveUnlock,
  canRejectLock,
  canRejectUnlock,
  canRequestUnlock,
  canWithdrawUnlock,
  getLockBannerState,
  TUITION_LOCK_REASON_COPY,
} from '../../lib/tuitionWorksheet'
import { getDisplayNameForContext } from '../../lib/scenarioName'

// Unified lock-state banner for the Tuition module. Renders one of
// three variants based on the scenario's state + unlock_requested:
//
//   1. pending_lock_review              — amber banner; "Approve and
//                                          lock" + "Reject" buttons
//                                          (gated by approve_lock).
//                                          Non-approvers see a
//                                          read-only status message.
//
//   2. locked_no_request                — green banner (or amber for
//                                          override locks). "Request
//                                          unlock" button gated by
//                                          approve_unlock.
//
//   3. locked_awaiting_final_approval   — amber banner. Approve /
//                                          Reject (for non-requester
//                                          approvers) / Withdraw
//                                          (for the requester)
//                                          buttons.
//
// Mirrors src/components/budget/LockedBanner.jsx and ApproveLockBar
// merged into one component. Tuition combines them because the
// tuition page is smaller than budget — there is less competition
// for vertical space, and one component to maintain reduces
// surface area.
//
// Props:
//   scenario         — active scenario row
//   aye              — { id, label } the active AYE — for canonical name
//   stage            — { id, display_name, ... } the active stage
//   lockedByName     — display name for scenario.locked_by (parent
//                      resolves; pre-existing pattern from Budget)
//   currentUser      — { id }
//   hasApproveLock   — bool (approve_lock perm)
//   hasApproveUnlock — bool (approve_unlock perm — also gates request)
//   onApproveLock    — () => void; opens LockReviewModal in approve mode
//                      (parent owns the modal; banner just signals)
//   onRejectLock     — () => void; opens LockReviewModal in reject mode
//   onRequestUnlock  — () => void; opens RequestUnlockModal
//   onApproveUnlock  — () => void; opens UnlockApprovalModal
//   onRejectUnlock   — () => void; opens RejectUnlockModal
//   onWithdrawUnlock — () => void; opens WithdrawUnlockModal
export default function TuitionLockBanner({
  scenario,
  aye,
  stage,
  lockedByName,
  currentUser,
  hasApproveLock,
  hasApproveUnlock,
  onApproveLock,
  onRejectLock,
  onRequestUnlock,
  onApproveUnlock,
  onRejectUnlock,
  onWithdrawUnlock,
}) {
  const bannerState = getLockBannerState(scenario)

  // Unlock requester name (only relevant for locked_awaiting_final_approval).
  const [requesterName, setRequesterName] = useState(null)
  useEffect(() => {
    let mounted = true
    if (!scenario.unlock_requested_by) {
      setRequesterName(null)
      return
    }
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

  if (bannerState === 'pending_lock_review') {
    return (
      <PendingLockReviewBody
        scenario={scenario}
        hasApproveLock={hasApproveLock}
        onApproveLock={onApproveLock}
        onRejectLock={onRejectLock}
      />
    )
  }
  if (bannerState === 'locked_no_request') {
    return (
      <LockedNoRequestBody
        scenario={scenario}
        aye={aye}
        stage={stage}
        lockedByName={lockedByName}
        currentUser={currentUser}
        hasApproveUnlock={hasApproveUnlock}
        onRequestUnlock={onRequestUnlock}
      />
    )
  }
  if (bannerState === 'locked_awaiting_final_approval') {
    return (
      <UnlockInProgressBody
        scenario={scenario}
        aye={aye}
        stage={stage}
        requesterName={requesterName}
        currentUser={currentUser}
        hasApproveUnlock={hasApproveUnlock}
        onApproveUnlock={onApproveUnlock}
        onRejectUnlock={onRejectUnlock}
        onWithdrawUnlock={onWithdrawUnlock}
      />
    )
  }
  return null
}

// ---- State 1: pending_lock_review --------------------------------------

function PendingLockReviewBody({
  scenario, hasApproveLock, onApproveLock, onRejectLock,
}) {
  const approveGate = canApproveLock({ scenario, hasApproveLock })
  const rejectGate = canRejectLock({ scenario, hasApproveLock })
  const isOverride = scenario.locked_via === 'override'
  // Use working name during pending review (canonical name kicks in
  // only when state = 'locked' per scenarioName.js / §8.15).
  const displayName = scenario.scenario_label || 'Untitled scenario'

  return (
    <div
      className="mb-4 px-4 py-3 border-[0.5px] rounded bg-status-blue-bg border-status-blue/25"
      role="status"
    >
      <div className="flex items-start gap-3 flex-wrap">
        <span
          className="font-display text-[18px] leading-none text-status-blue flex-shrink-0"
          aria-hidden="true"
        >
          ⏳
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-display text-[13px] tracking-[0.06em] uppercase mb-0.5 text-status-blue">
            Pending lock review {isOverride && '— with override'}
          </p>
          <p className="text-sm text-body leading-relaxed">
            <strong className="font-medium">{displayName}</strong> is awaiting
            approval. The detail view is read-only until approval or rejection.
          </p>
          {isOverride && scenario.override_justification && (
            <div className="mt-2 px-3 py-2 bg-white/60 border-[0.5px] border-status-amber/25 rounded text-sm">
              <p className="font-body text-[11px] text-status-amber uppercase tracking-wider mb-1">
                Override justification
              </p>
              <p className="text-body italic leading-relaxed whitespace-pre-wrap">
                {scenario.override_justification}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {rejectGate.ok && (
            <button
              type="button"
              onClick={onRejectLock}
              className="bg-white border-[0.5px] border-status-red/40 text-status-red px-3 py-1.5 rounded text-sm font-body hover:bg-status-red-bg transition-colors"
            >
              Reject
            </button>
          )}
          {approveGate.ok && (
            <button
              type="button"
              onClick={onApproveLock}
              className="bg-navy text-gold border-[0.5px] border-navy px-3 py-1.5 rounded text-sm font-body hover:opacity-90 transition-opacity"
            >
              Approve and lock
            </button>
          )}
          {!approveGate.ok && !rejectGate.ok && (
            <p className="font-body italic text-muted text-[12px]">
              Submitted; waiting for an approver.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- State 2: locked_no_request ----------------------------------------

function LockedNoRequestBody({
  scenario, aye, stage, lockedByName, currentUser,
  hasApproveUnlock, onRequestUnlock,
}) {
  const dateStr = scenario.locked_at
    ? new Date(scenario.locked_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : '—'
  const isOverride = scenario.locked_via === 'override'
  const requestGate = canRequestUnlock(scenario, currentUser, hasApproveUnlock)
  // Canonical name for the heading line — official identity of the
  // locked artifact, not the working scenario label (§8.15).
  const canonicalName = getDisplayNameForContext('locked_banner', { scenario, aye, stage })

  return (
    <div
      className={`mb-4 px-4 py-3 border-[0.5px] rounded ${
        isOverride
          ? 'bg-status-amber-bg border-status-amber/30'
          : 'bg-status-green-bg border-status-green/25'
      }`}
      role="status"
    >
      <div className="flex items-start gap-3">
        <span
          className={`font-display text-[18px] leading-none ${
            isOverride ? 'text-status-amber' : 'text-status-green'
          }`}
          aria-hidden="true"
        >
          🔒
        </span>
        <div className="flex-1 min-w-0">
          <p className={`font-display text-[13px] tracking-[0.06em] uppercase mb-0.5 ${
            isOverride ? 'text-status-amber' : 'text-status-green'
          }`}>
            Locked {isOverride && '— with override'}
          </p>
          <p className="text-sm text-body leading-relaxed">
            <strong className="font-medium">{canonicalName}</strong>{' '}
            was locked on <strong className="font-medium">{dateStr}</strong>
            {lockedByName ? <> by <strong className="font-medium">{lockedByName}</strong></> : null}.
            To edit, request unlock.
          </p>
          {isOverride && scenario.override_justification && (
            <div className="mt-2 px-3 py-2 bg-white/60 border-[0.5px] border-status-amber/20 rounded text-sm">
              <p className="font-body text-[11px] text-status-amber uppercase tracking-wider mb-1">
                Override justification
              </p>
              <p className="text-body italic leading-relaxed whitespace-pre-wrap">
                {scenario.override_justification}
              </p>
            </div>
          )}
        </div>
        {requestGate.ok && (
          <button
            type="button"
            onClick={onRequestUnlock}
            className="bg-white border-[0.5px] border-card-border text-navy px-3 py-1.5 rounded text-sm font-body hover:bg-cream-highlight transition-colors flex-shrink-0"
          >
            Request unlock
          </button>
        )}
      </div>
    </div>
  )
}

// ---- State 3: locked_awaiting_final_approval ---------------------------

function UnlockInProgressBody({
  scenario, aye, stage, requesterName, currentUser, hasApproveUnlock,
  onApproveUnlock, onRejectUnlock, onWithdrawUnlock,
}) {
  const canonicalName = getDisplayNameForContext('locked_banner', { scenario, aye, stage })
  const requestedAtStr = scenario.unlock_requested_at
    ? new Date(scenario.unlock_requested_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : '—'

  const approveGate = canApproveUnlock(scenario, currentUser, hasApproveUnlock)
  const rejectGate = canRejectUnlock(scenario, currentUser, hasApproveUnlock)
  const withdrawGate = canWithdrawUnlock(scenario, currentUser)

  const approveDisabledTooltip = approveGate.ok
    ? undefined
    : TUITION_LOCK_REASON_COPY[approveGate.reason]

  const showApproveButton =
    hasApproveUnlock && approveGate.reason !== 'permission_insufficient'

  return (
    <div
      className="mb-4 px-4 py-3 border-[0.5px] rounded bg-status-amber-bg border-status-amber/30"
      role="status"
    >
      <div className="flex items-start gap-3 flex-wrap">
        <span
          className="font-display text-[18px] leading-none text-status-amber flex-shrink-0"
          aria-hidden="true"
        >
          🔓
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-display text-[13px] tracking-[0.06em] uppercase mb-0.5 text-status-amber">
            Unlock requested · awaiting final approval
          </p>
          <p className="text-sm text-body leading-relaxed">
            <strong className="font-medium">{canonicalName}</strong>:
            requested by{' '}
            <strong className="font-medium">{requesterName || 'unknown user'}</strong>{' '}
            on <strong className="font-medium">{requestedAtStr}</strong>.
            Their submission counts as the first approval; one
            additional approver is required to complete the unlock.
          </p>
          {scenario.unlock_request_justification && (
            <div className="mt-2 px-3 py-2 bg-white/60 border-[0.5px] border-status-amber/20 rounded text-sm">
              <p className="font-body text-[11px] text-status-amber uppercase tracking-wider mb-1">
                Reason
              </p>
              <p className="text-body italic leading-relaxed whitespace-pre-wrap">
                {scenario.unlock_request_justification}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {showApproveButton && (
            <button
              type="button"
              onClick={onApproveUnlock}
              disabled={!approveGate.ok}
              title={approveDisabledTooltip}
              className="bg-navy text-gold border-[0.5px] border-navy px-3 py-1.5 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Approve unlock
            </button>
          )}
          {rejectGate.ok && (
            <button
              type="button"
              onClick={onRejectUnlock}
              className="bg-white border-[0.5px] border-status-red/40 text-status-red px-3 py-1.5 rounded text-sm font-body hover:bg-status-red-bg transition-colors"
            >
              Reject
            </button>
          )}
          {withdrawGate.ok && (
            <button
              type="button"
              onClick={onWithdrawUnlock}
              className="font-body text-muted hover:text-navy text-sm underline-offset-2 hover:underline px-2 py-1.5"
            >
              Withdraw request
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
