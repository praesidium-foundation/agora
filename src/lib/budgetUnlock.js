// Unlock-workflow client helpers for the Budget module's stage scenarios.
//
// Architecture §8.13 documents the workflow in full. The DB layer
// (Migrations 016 + 020 schema, Migration 021 functions) is the hard
// guard — CHECK constraints + trigger plus three SECURITY DEFINER
// functions enforce every rule at write time. This file is the
// application validator layer (the middle of the three-layer
// enforcement model from CLAUDE.md): pure sync helpers that mirror
// the DB rules so the UI can:
//
//   - decide whether to render an action affordance at all
//   - explain a block before the user clicks
//   - re-check at click time before firing the RPC
//
// **Two-identity model** (v3.7 refactor). Submitting an unlock request
// counts as approval_1 — it represents the requester's professional
// judgment that unlock is warranted. One additional approver (distinct
// from the requester) records approval_2, which transitions state to
// drafting. Both identities must hold approve_unlock permission.
//
// No DB calls live here. All inputs are already-loaded data:
//   - `scenario` : an in-memory budget_stage_scenarios row, with the
//                  unlock_* fields populated (or NULL/false)
//   - `currentUser` : { id } — the active auth user; only the id is
//                     used for the requester/approver-self comparisons
//   - `hasApproveUnlock` : boolean pre-evaluated by
//                     `useModulePermission(...)`. The hook calls
//                     `current_user_has_module_perm('budget',
//                     'approve_unlock')` on the server, which already
//                     handles enum subsumption (admin >= approve_unlock
//                     >= ... etc.) and the system-admin shortcut.
//
// All `can*` helpers return `{ ok: true }` on success or
// `{ ok: false, reason: '<short_code>' }` on failure. Reasons are
// short, machine-readable codes the UI translates to user-facing
// copy via UNLOCK_REASON_COPY below — the helpers themselves do not
// speak English so the same logic can power tooltips, audit messages,
// and tests without coupling to copy.

// Determine which banner state applies to a locked scenario. Single
// source of truth for the morphing locked banner.
//
// v3.7: collapsed from three states to two. The intermediate
// 'locked_awaiting_first_approval' is gone because approval_1 is
// always already populated by request time (the requester's
// submission counts as approval_1).
//
//   locked_no_request               → state = 'locked',
//                                     unlock_requested = false
//   locked_awaiting_final_approval  → state = 'locked',
//                                     unlock_requested = true
//                                     (approval_1 always populated;
//                                      only approval_2 outstanding)
//
// Returns null if the scenario isn't locked (the caller should be
// using a different banner entirely).
export function getUnlockBannerState(scenario) {
  if (!scenario || scenario.state !== 'locked') return null
  if (!scenario.unlock_requested) return 'locked_no_request'
  return 'locked_awaiting_final_approval'
}

// Can this user request an unlock on this scenario right now?
//
// v3.7: permission gate is `approve_unlock` (was `submit_lock`).
// Submitting an unlock request is itself a governance act of approval
// — the requester's submission counts as approval_1 — so the request
// gate matches the approve gate.
//
// Mirrors the DB rules in request_budget_stage_unlock:
//   - scenario must be in state = 'locked'
//   - unlock must not already be requested
//   - caller must have approve_unlock or higher (subsumption)
export function canRequestUnlock(scenario, currentUser, hasApproveUnlock) {
  if (!currentUser?.id) return { ok: false, reason: 'no_user' }
  if (!scenario || scenario.state !== 'locked') {
    return { ok: false, reason: 'state_not_locked' }
  }
  if (scenario.unlock_requested) {
    return { ok: false, reason: 'unlock_already_requested' }
  }
  if (!hasApproveUnlock) {
    return { ok: false, reason: 'permission_insufficient' }
  }
  return { ok: true }
}

// Can this user approve the pending unlock?
//
// v3.7: simplified. The 'is_first_approver' failure mode is gone
// because there is no longer a separate first-approver check — the
// requester is always approval_1, so the only check is "caller is not
// the requester."
//
// Mirrors the DB rules in approve_budget_stage_unlock:
//   - scenario state = 'locked' (it stays locked throughout the
//     unlock-in-progress window — §8.13)
//   - unlock_requested = true
//   - caller has approve_unlock or higher
//   - caller is NOT the requester (initiator separation)
export function canApproveUnlock(scenario, currentUser, hasApproveUnlock) {
  if (!currentUser?.id) return { ok: false, reason: 'no_user' }
  if (!scenario || scenario.state !== 'locked') {
    return { ok: false, reason: 'state_not_locked' }
  }
  if (!scenario.unlock_requested) {
    return { ok: false, reason: 'no_unlock_requested' }
  }
  if (!hasApproveUnlock) {
    return { ok: false, reason: 'permission_insufficient' }
  }
  if (scenario.unlock_requested_by === currentUser.id) {
    return { ok: false, reason: 'is_initiator' }
  }
  return { ok: true }
}

// Can this user reject the pending unlock?
//
// Reject is the approve_unlock-holder path (an approver chooses NOT
// to approve someone else's request). The withdraw path is
// canWithdrawUnlock — same RPC under the hood (the function auto-
// detects withdraw vs reject by caller), but different UI affordance.
// The two checks are deliberately distinct so the UI can render
// "Reject" and "Withdraw request" as different controls.
//
// Mirrors the DB rules in reject_budget_stage_unlock:
//   - scenario state = 'locked'
//   - unlock_requested = true
//   - caller has approve_unlock (or is the requester — but that's
//     the withdraw path, gated separately by canWithdrawUnlock)
//
// Caller must NOT be the requester here; otherwise it is a withdraw.
export function canRejectUnlock(scenario, currentUser, hasApproveUnlock) {
  if (!currentUser?.id) return { ok: false, reason: 'no_user' }
  if (!scenario || scenario.state !== 'locked') {
    return { ok: false, reason: 'state_not_locked' }
  }
  if (!scenario.unlock_requested) {
    return { ok: false, reason: 'no_unlock_requested' }
  }
  if (!hasApproveUnlock) {
    return { ok: false, reason: 'permission_insufficient' }
  }
  if (scenario.unlock_requested_by === currentUser.id) {
    return { ok: false, reason: 'is_initiator' } // use withdraw instead
  }
  return { ok: true }
}

// Can this user withdraw their own unlock request?
//
// Only the original requester can withdraw their own request. No
// permission check beyond that — withdrawing your own request is a
// housekeeping action, not a governance one. The reject function
// authorizes the requester even if they don't have approve_unlock
// (in practice they do, since v3.7 the request gate is approve_unlock,
// but the reject function still permits the requester unconditionally
// as a safety net).
export function canWithdrawUnlock(scenario, currentUser) {
  if (!currentUser?.id) return { ok: false, reason: 'no_user' }
  if (!scenario || scenario.state !== 'locked') {
    return { ok: false, reason: 'state_not_locked' }
  }
  if (!scenario.unlock_requested) {
    return { ok: false, reason: 'no_unlock_requested' }
  }
  if (scenario.unlock_requested_by !== currentUser.id) {
    return { ok: false, reason: 'not_initiator' }
  }
  return { ok: true }
}

// ---- Validators that combine permission gates with content checks --------

// Minimum length for the justification (request) and reason (reject /
// withdraw) text fields. Matches the spirit of §8.13's "non-empty
// after trim" DB-level validation but adds a minimum so the UI can
// reject obvious throwaways before the round-trip.
const MIN_TEXT_LENGTH = 10

// Wraps canRequestUnlock with text-content validation on the
// justification. Returns the same `{ok, reason, field?}` shape so
// the UI can highlight the specific field on a content failure.
//
// v3.7: third arg is hasApproveUnlock (was hasSubmitLock).
export function validateUnlockRequest(scenario, justification, currentUser, hasApproveUnlock) {
  const gate = canRequestUnlock(scenario, currentUser, hasApproveUnlock)
  if (!gate.ok) return gate
  const trimmed = (justification || '').trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'justification_empty', field: 'justification' }
  }
  if (trimmed.length < MIN_TEXT_LENGTH) {
    return { ok: false, reason: 'justification_too_short', field: 'justification' }
  }
  return { ok: true }
}

// Permission-only gate for approval — kept as a separate function for
// symmetry with the others (a future need might add content
// requirements; the call site doesn't need to change shape).
export function validateUnlockApproval(scenario, currentUser, hasApproveUnlock) {
  return canApproveUnlock(scenario, currentUser, hasApproveUnlock)
}

// Wraps canRejectUnlock with text-content validation on the reason.
export function validateUnlockRejection(scenario, reason, currentUser, hasApproveUnlock) {
  const gate = canRejectUnlock(scenario, currentUser, hasApproveUnlock)
  if (!gate.ok) return gate
  const trimmed = (reason || '').trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'reason_empty', field: 'reason' }
  }
  if (trimmed.length < MIN_TEXT_LENGTH) {
    return { ok: false, reason: 'reason_too_short', field: 'reason' }
  }
  return { ok: true }
}

// Wraps canWithdrawUnlock with text-content validation on the reason.
// Same minimum-length rule as rejection — withdrawing should also
// produce a useful audit trail.
export function validateUnlockWithdraw(scenario, reason, currentUser) {
  const gate = canWithdrawUnlock(scenario, currentUser)
  if (!gate.ok) return gate
  const trimmed = (reason || '').trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'reason_empty', field: 'reason' }
  }
  if (trimmed.length < MIN_TEXT_LENGTH) {
    return { ok: false, reason: 'reason_too_short', field: 'reason' }
  }
  return { ok: true }
}

// Public constants — exported so modal components can use the same
// minimum without redefining it.
export const UNLOCK_TEXT_MIN_LENGTH = MIN_TEXT_LENGTH

// Human-readable copy for each reason code. Keep in one place so the
// UI doesn't sprinkle copy decisions throughout every component, and
// so changing wording is a single edit. The keys are reason codes;
// the values are end-user copy for tooltips and inline messages.
//
// v3.7: 'is_first_approver' removed (no more separate first-approver
// check); 'is_initiator' copy refreshed to reflect the requester-as-
// approval_1 reality; permission_insufficient copy updated to
// reference approve_unlock specifically.
export const UNLOCK_REASON_COPY = {
  // permission gates
  no_user:                    'You must be signed in.',
  permission_insufficient:    'This action requires approve_unlock permission on the Budget module.',
  // state gates
  state_not_locked:           'This scenario is not currently locked.',
  unlock_already_requested:   'An unlock request is already in progress.',
  no_unlock_requested:        'No unlock request is pending on this scenario.',
  // initiator separation
  is_initiator:               'The unlock requester (whose submission counts as the first approval) cannot also record the second approval. A different approver is required.',
  not_initiator:              'Only the original requester can withdraw this request.',
  // content
  justification_empty:        'Justification is required.',
  justification_too_short:    `Justification must be at least ${MIN_TEXT_LENGTH} characters.`,
  reason_empty:               'A reason is required.',
  reason_too_short:           `Reason must be at least ${MIN_TEXT_LENGTH} characters.`,
}
