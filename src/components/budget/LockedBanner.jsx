import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import {
  canApproveUnlock,
  canRejectUnlock,
  canRequestUnlock,
  canWithdrawUnlock,
  getUnlockBannerState,
  UNLOCK_REASON_COPY,
} from '../../lib/budgetUnlock'
import { getDisplayNameForContext } from '../../lib/scenarioName'

// Banner shown above the budget detail when the active scenario is
// locked. Surfaces the lock metadata (when, by whom, override or
// not) so the user understands the state of the budget at a glance.
//
// Architecture §2.6: locked outputs carry an approved-by indicator.
// This banner is the on-screen equivalent of the PDF approved-by
// footer.
//
// Architecture §8.13: the banner morphs through three states based on
// scenario.unlock_requested and scenario.unlock_approval_1_at:
//
//   1. locked_no_request               — green/approved treatment
//      (or amber when locked_via='override'). Existing production
//      copy. Shows "Request unlock" button when canRequestUnlock.
//
//   2. locked_awaiting_first_approval  — amber treatment. Shows
//      requester / timestamp / justification (no truncation). Action
//      buttons: Approve unlock, Reject, Withdraw request — each gated
//      by the corresponding canX helper.
//
//   3. locked_awaiting_final_approval  — same amber treatment plus
//      a second line showing the first approver and timestamp. Action
//      buttons: Approve unlock (final), Reject, Withdraw request.
//
// Slim banner, modal-driven actions: status copy lives in the banner;
// every action opens a modal for confirmation. Approval is
// governance-weight; modal pause is appropriate.
//
// Justification text is always visible inline. No truncation. No
// "show more" toggle. This parallels §9.1's commitment that override
// justifications are never buried.
//
// Props:
//   scenario         — active scenario row (state = 'locked')
//   aye              — { id, label } the active AYE — for canonical name
//   stage            — { id, display_name, ... } the active stage — for canonical name
//   lockedByName     — display name for scenario.locked_by (resolved
//                      by parent — pre-existing pattern)
//   currentUser      — { id }
//   hasSubmitLock    — bool from useModulePermission
//   hasApproveUnlock — bool from useModulePermission
//   onRequestUnlock  — () => void; opens RequestUnlockModal
//   onApproveUnlock  — () => void; opens ApproveUnlockModal
//   onRejectUnlock   — () => void; opens RejectUnlockModal
//   onWithdrawUnlock — () => void; opens WithdrawUnlockModal
//
// Name resolution for unlock_requested_by and unlock_approval_1_by is
// done internally — those uids are only needed in the morphing
// states, and keeping the lookup co-located with the rendering code
// keeps BudgetStage less crowded.
//
// Canonical naming (architecture §8.15): when state = locked the
// banner heading shows the canonical artifact name (e.g.
// "Libertas Academy AYE 2026 Preliminary Budget") rather than the
// working scenario label. The artifact identity does not change
// while unlock is pending — only after unlock completes does state
// flip to drafting and the working name take over (and at that point
// the banner does not render at all).

function LockedBanner({
  scenario,
  aye,
  stage,
  lockedByName,
  currentUser,
  hasSubmitLock,
  hasApproveUnlock,
  onRequestUnlock,
  onApproveUnlock,
  onRejectUnlock,
  onWithdrawUnlock,
}) {
  const bannerState = getUnlockBannerState(scenario)

  // Names for unlock_requested_by and unlock_approval_1_by. Fetched
  // lazily — empty until the scenario actually has those uids set.
  const [requesterName, setRequesterName] = useState(null)
  const [firstApproverName, setFirstApproverName] = useState(null)

  useEffect(() => {
    let mounted = true
    const targets = []
    if (scenario.unlock_requested_by) targets.push(scenario.unlock_requested_by)
    if (scenario.unlock_approval_1_by) targets.push(scenario.unlock_approval_1_by)
    if (targets.length === 0) {
      setRequesterName(null)
      setFirstApproverName(null)
      return
    }
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

  if (bannerState === 'locked_no_request') {
    return (
      <BaseLockedBody
        scenario={scenario}
        aye={aye}
        stage={stage}
        lockedByName={lockedByName}
        currentUser={currentUser}
        hasSubmitLock={hasSubmitLock}
        onRequestUnlock={onRequestUnlock}
      />
    )
  }
  return (
    <UnlockInProgressBody
      bannerState={bannerState}
      scenario={scenario}
      aye={aye}
      stage={stage}
      requesterName={requesterName}
      firstApproverName={firstApproverName}
      currentUser={currentUser}
      hasApproveUnlock={hasApproveUnlock}
      onApproveUnlock={onApproveUnlock}
      onRejectUnlock={onRejectUnlock}
      onWithdrawUnlock={onWithdrawUnlock}
    />
  )
}

// State 1: existing locked-banner production behavior. Approved
// treatment (green) when locked_via='normal'; amber when 'override'.
function BaseLockedBody({
  scenario,
  aye,
  stage,
  lockedByName,
  currentUser,
  hasSubmitLock,
  onRequestUnlock,
}) {
  const dateStr = scenario.locked_at
    ? new Date(scenario.locked_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : '—'
  const isOverride = scenario.locked_via === 'override'
  const requestGate = canRequestUnlock(scenario, currentUser, hasSubmitLock)
  // Canonical name for the heading line — official identity of the
  // locked artifact, not the working scenario label (architecture §8.15).
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
            To edit, request unlock from the Treasurer.
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

// States 2 + 3: amber treatment, request details visible inline,
// action buttons gated by helper outcomes. The artifact identity does
// not change while unlock is pending — the canonical name still applies
// (architecture §8.15: state stays 'locked' throughout the unlock-
// in-progress window).
function UnlockInProgressBody({
  bannerState,
  scenario,
  aye,
  stage,
  requesterName,
  firstApproverName,
  currentUser,
  hasApproveUnlock,
  onApproveUnlock,
  onRejectUnlock,
  onWithdrawUnlock,
}) {
  const canonicalName = getDisplayNameForContext('locked_banner', { scenario, aye, stage })
  const requestedAtStr = scenario.unlock_requested_at
    ? new Date(scenario.unlock_requested_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : '—'
  const firstApprovedAtStr = scenario.unlock_approval_1_at
    ? new Date(scenario.unlock_approval_1_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : null

  const isFinalApproval = bannerState === 'locked_awaiting_final_approval'
  const approveGate = canApproveUnlock(scenario, currentUser, hasApproveUnlock)
  const rejectGate = canRejectUnlock(scenario, currentUser, hasApproveUnlock)
  const withdrawGate = canWithdrawUnlock(scenario, currentUser)

  // Tooltip when approve button is disabled with a real reason (e.g.
  // initiator separation). Hidden when it's just a plain "you don't
  // have permission" state (the button isn't rendered then).
  const approveDisabledTooltip = approveGate.ok
    ? undefined
    : UNLOCK_REASON_COPY[approveGate.reason]

  // The approve button is only rendered when the user *might* be able
  // to approve — i.e., they have approve_unlock and aren't blocked by
  // a permission-only failure. Initiator-separation and
  // first-approver-self failures still render the button as
  // disabled-with-tooltip so the user understands the rule rather
  // than wondering where the affordance went.
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
            Unlock requested · {isFinalApproval ? 'awaiting final approval' : 'awaiting first approval'}
          </p>
          <p className="text-sm text-body leading-relaxed">
            <strong className="font-medium">{canonicalName}</strong>:
            requested by{' '}
            <strong className="font-medium">{requesterName || 'unknown user'}</strong>{' '}
            on <strong className="font-medium">{requestedAtStr}</strong>.
            {isFinalApproval && firstApproverName ? (
              <>
                {' '}First approved by{' '}
                <strong className="font-medium">{firstApproverName}</strong>{' '}
                on <strong className="font-medium">{firstApprovedAtStr}</strong>.
              </>
            ) : null}
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
              {isFinalApproval ? 'Approve unlock (final)' : 'Approve unlock'}
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

export default LockedBanner
