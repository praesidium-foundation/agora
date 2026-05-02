// Unlock-workflow client helpers for the Budget module's stage scenarios.
//
// Architecture §8.13 documents the workflow in full. The DB layer (H1)
// is the hard guard — Migration 016's CHECK constraints + trigger plus
// Migration 018's three SECURITY DEFINER functions enforce every rule
// at write time. This file is the application validator layer (the
// middle of the three-layer enforcement model from CLAUDE.md): pure
// sync helpers that mirror the DB rules so the UI can:
//
//   - decide whether to render an action affordance at all
//   - explain a block before the user clicks
//   - re-check at click time before firing the RPC
//
// No DB calls live here. All inputs are already-loaded data:
//   - `scenario` : an in-memory budget_stage_scenarios row, with the
//                  unlock_* fields populated (or NULL/false)
//   - `currentUser` : { id } — the active auth user; only the id is
//                     used for the initiator/approver-self comparisons
//   - `hasSubmitLock` / `hasApproveUnlock` : booleans pre-evaluated by
//                     `useModulePermission(...)`. The hook calls
//                     `current_user_has_module_perm(code, level)` on
//                     the server, which already handles enum
//                     subsumption (admin >= approve_unlock >= ... etc.)
//                     and the system-admin shortcut. So callers pass
//                     booleans, and these helpers don't try to
//                     replicate the comparison client-side.
//
// All `can*` helpers return `{ ok: true }` on success or
// `{ ok: false, reason: '<short_code>' }` on failure. Reasons are
// short, machine-readable codes the UI translates to user-facing copy
// — the helpers themselves don't speak English so the same logic can
// power tooltips, audit messages, and tests without coupling to copy.
//
// Mirror of src/lib/budgetLock.js in spirit — though the lock helpers
// are async (they hit the DB for cascade rules), the unlock helpers
// are pure because all the rules can be checked from in-memory state.

// Determine which of the three banner states applies to a locked
// scenario. Single source of truth for the morphing banner.
//
//   locked_no_request                 → no unlock requested
//   locked_awaiting_first_approval    → unlock requested, no approvals yet
//   locked_awaiting_final_approval    → unlock requested, approval 1 recorded
//
// Returns null if the scenario isn't locked (the caller should be using
// a different banner entirely).
export function getUnlockBannerState(scenario) {
  if (!scenario || scenario.state !== 'locked') return null
  if (!scenario.unlock_requested) return 'locked_no_request'
  if (!scenario.unlock_approval_1_at) return 'locked_awaiting_first_approval'
  return 'locked_awaiting_final_approval'
}

// Can this user request an unlock on this scenario right now?
//
// Mirrors the DB rules in request_budget_stage_unlock:
//   - scenario must be in state = 'locked'
//   - unlock must not already be requested
//   - caller must have submit_lock or higher (subsumption)
export function canRequestUnlock(scenario, currentUser, hasSubmitLock) {
  if (!currentUser?.id) return { ok: false, reason: 'no_user' }
  if (!scenario || scenario.state !== 'locked') {
    return { ok: false, reason: 'state_not_locked' }
  }
  if (scenario.unlock_requested) {
    return { ok: false, reason: 'unlock_already_requested' }
  }
  if (!hasSubmitLock) {
    return { ok: false, reason: 'permission_insufficient' }
  }
  return { ok: true }
}

// Can this user approve the pending unlock?
//
// Mirrors the DB rules in approve_budget_stage_unlock:
//   - scenario state = 'locked' (it stays locked throughout the
//     unlock-in-progress window — §8.13)
//   - unlock_requested = true
//   - caller has approve_unlock or higher
//   - caller is NOT the initiator (initiator separation)
//   - caller is NOT already the first approver (two-distinct rule)
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
  if (scenario.unlock_approval_1_by === currentUser.id) {
    return { ok: false, reason: 'is_first_approver' }
  }
  return { ok: true }
}

// Can this user reject the pending unlock?
//
// Reject is the approve_unlock-holder path (an approver chooses NOT to
// approve). The withdraw path is canWithdrawUnlock — same RPC under the
// hood (H1's function auto-detects withdraw vs reject by caller), but
// different UI affordance. The two checks are deliberately distinct so
// the UI can render "Reject" and "Withdraw" as different controls.
//
// Mirrors the DB rules in reject_budget_stage_unlock:
//   - scenario state = 'locked'
//   - unlock_requested = true
//   - caller has approve_unlock (or is the requester — but that's the
//     withdraw path, not reject)
//
// Note: the DB function accepts the requester as a "withdraw" path, but
// here we explicitly want the reject path: caller must have permission
// AND must NOT be the requester (otherwise it's a withdraw).
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
// housekeeping action, not a governance one. The H1 reject function
// authorizes the requester even if they don't have approve_unlock.
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
export function validateUnlockRequest(scenario, justification, currentUser, hasSubmitLock) {
  const gate = canRequestUnlock(scenario, currentUser, hasSubmitLock)
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
// so changing wording is a single edit. The keys are reason codes; the
// values are end-user copy for tooltips and inline messages.
export const UNLOCK_REASON_COPY = {
  // permission gates
  no_user:                    'You must be signed in.',
  permission_insufficient:    'You do not have permission for this action.',
  // state gates
  state_not_locked:           'This scenario is not currently locked.',
  unlock_already_requested:   'An unlock request is already in progress.',
  no_unlock_requested:        'No unlock request is pending on this scenario.',
  // initiator / approver separation
  is_initiator:               'The unlock initiator cannot approve their own request.',
  is_first_approver:          'You have already recorded the first approval; the final approval requires a different approver.',
  not_initiator:              'Only the original requester can withdraw this request.',
  // content
  justification_empty:        'Justification is required.',
  justification_too_short:    `Justification must be at least ${MIN_TEXT_LENGTH} characters.`,
  reason_empty:               'A reason is required.',
  reason_too_short:           `Reason must be at least ${MIN_TEXT_LENGTH} characters.`,
}
