// Lock + unlock workflow client helpers for the Tuition module's
// scenarios.
//
// Architecture §8.13 (unlock two-identity model) and §7.5 (cross-
// module cascade rules) are the canonical specs. The DB layer
// (Migrations 022 + 024 + 025 + 032) is the hard guard — three
// SECURITY DEFINER functions enforce every rule at write time. This
// file is the application validator layer (the middle of the
// three-layer enforcement model from CLAUDE.md): pure helpers that
// mirror the DB rules so the UI can:
//
//   - decide whether to render an action affordance at all
//   - explain a block before the user clicks
//   - re-check at click time before firing the RPC
//
// **Two-identity unlock model** (architecture §8.13). Submitting an
// unlock request counts as approval_1 — it represents the requester's
// professional judgment that unlock is warranted. One additional
// approver (distinct from the requester) records approval_2, which
// transitions state to drafting. Both identities must hold
// approve_unlock permission.
//
// Tuition deviates from Budget's lock client surface in one important
// way: Tuition has dedicated RPCs for submit_for_lock_review and
// reject_lock (Migration 024), where Budget uses direct UPDATEs from
// budgetLock.js. The stricter pattern is appropriate for Tuition
// because a locked Tuition snapshot triggers downstream contractual
// commitments to families (the tuition schedule families sign).
// Helpers here call the RPCs.
//
// All `can*` helpers return `{ ok: true }` on success or
// `{ ok: false, reason: '<short_code>' }` on failure. Reasons are
// short, machine-readable codes the UI translates to user-facing
// copy via TUITION_LOCK_REASON_COPY below — the helpers themselves
// do not speak English so the same logic can power tooltips, audit
// messages, and tests without coupling to copy.

import { supabase } from './supabase'

// ============================================================================
// LOCK WORKFLOW
// ============================================================================

// Find a sibling scenario (same AYE + stage) that's currently locked.
// Returns the sibling row or null. Pure / sync; takes the in-memory
// scenarios array from the page so it doesn't need a DB roundtrip.
//
// Used by:
//   - TuitionLockBanner gating ("you can't recommend while locked")
//   - SubmitForLockReviewModal pre-flight (hardBlock failure)
//   - TuitionWorksheet sibling-locked banner
//
// Schema-level safety net: tg_prevent_lock_submit_while_sibling_
// locked_tuition (Migration 022) rejects the same transitions even if
// a malicious caller bypasses these UI checks.
export function findLockedSibling(scenarios, currentScenarioId) {
  if (!Array.isArray(scenarios)) return null
  return scenarios.find(
    (s) => s.id !== currentScenarioId && s.state === 'locked'
  ) || null
}

// Pure validation over a tuition scenario for "submit for lock review".
// Mirrors the DB rules in submit_tuition_scenario_for_lock_review:
//
//   - Scenario must exist and be in drafting state
//   - Scenario must be marked is_recommended (only the recommended
//     scenario can be locked — DB CHECK enforces "one locked
//     recommended per (AYE, stage)")
//   - No sibling scenario in this (AYE, stage) may be locked
//     (hardBlock — the DB trigger refuses the transition even with
//     admin override; mirroring Budget's hardBlock pattern)
//   - At least one tuition input must be non-zero. "All zeros"
//     genuinely indicates the scenario has not been filled in. The
//     check uses the lightest possible signal that catches the
//     fresh-empty case without overspecifying — tier_1 rate > 0 OR
//     total_students > 0 OR any envelope > 0.
//
// Failures may carry a `hardBlock: true` flag indicating the failure
// can NOT be overridden at the application layer (it'd be rejected by
// the DB trigger anyway). The override checkbox in the modal is
// hidden when any hardBlock failure is present.
//
// Returns Failure[] — empty array means clean pass.
export function validateScenarioForLock(scenario, lockedSibling = null) {
  const failures = []

  if (!scenario) {
    failures.push({ kind: 'missing_scenario', message: 'No active scenario.' })
    return failures
  }

  // Sibling-lock guard. Hard block — Migration 022's
  // tg_prevent_lock_submit_while_sibling_locked_tuition rejects the
  // transition even with admin "override" set, so we don't expose an
  // override path the database would refuse.
  if (lockedSibling) {
    failures.push({
      kind: 'sibling_locked',
      hardBlock: true,
      message:
        `"${lockedSibling.scenario_label}" in this (AYE, stage) is currently locked. ` +
        `Unlock it before submitting "${scenario.scenario_label}" for review.`,
    })
  }

  if (scenario.state !== 'drafting') {
    failures.push({
      kind: 'wrong_state',
      message: `Scenario is in ${scenario.state} state, not drafting.`,
    })
  }

  if (!scenario.is_recommended) {
    failures.push({
      kind: 'not_recommended',
      message:
        'Scenario must be marked as recommended before submitting for lock review.',
    })
  }

  // "All zeros" check — Tuition's analog to Budget's "at least one
  // line non-zero" guard. The Tuition scenario row carries direct
  // numeric inputs (no separate lines table at Stage 1), so we look
  // at the most load-bearing inputs:
  //   - Tier 1 per_student_rate (the base rate that drives every
  //     other tier rate via discount)
  //   - total_students (the headcount projection)
  //   - any of the three discount envelopes
  // If ALL of those are zero / null, the scenario is effectively
  // empty and locking it would commit a zero-revenue tuition schedule
  // — almost certainly unintentional.
  const tier1Rate = getTier1Rate(scenario)
  const totalStudents = Number(scenario.total_students) || 0
  const facultyEnv = Number(scenario.projected_faculty_discount_amount) || 0
  const otherEnv = Number(scenario.projected_other_discount) || 0
  const faEnv = Number(scenario.projected_financial_aid) || 0
  const allZero =
    tier1Rate <= 0 &&
    totalStudents <= 0 &&
    facultyEnv === 0 &&
    otherEnv === 0 &&
    faEnv === 0
  if (allZero) {
    failures.push({
      kind: 'all_zero',
      message:
        'Tuition inputs are all zero. Set at least the base tier rate and projected enrollment before submitting for lock review.',
    })
  }

  return failures
}

// Tier 1 (base) rate from the tier_rates jsonb. Helper for the
// validator; pure / sync.
function getTier1Rate(scenario) {
  const rates = Array.isArray(scenario?.tier_rates) ? scenario.tier_rates : []
  const tier1 = rates.find((r) => Number(r.tier_size) === 1)
  return tier1 ? Number(tier1.per_student_rate) || 0 : 0
}

// Determine which lock banner state applies to a tuition scenario.
// Single source of truth for the banner morphing in TuitionLockBanner
// + the unlock-workflow banner.
//
//   null                                → not displayed (drafting,
//                                          no banner needed)
//   'pending_lock_review'               → amber pending banner
//                                          (state = 'pending_lock_review';
//                                           shows Approve/Reject for
//                                           approvers, status copy for
//                                           non-approvers)
//   'locked_no_request'                 → green/amber locked banner
//                                          (state = 'locked';
//                                           unlock_requested = false)
//   'locked_awaiting_final_approval'    → amber unlock-pending banner
//                                          (state = 'locked';
//                                           unlock_requested = true)
//
// Returns null when the scenario isn't in any banner-worthy state.
export function getLockBannerState(scenario) {
  if (!scenario) return null
  if (scenario.state === 'pending_lock_review') return 'pending_lock_review'
  if (scenario.state !== 'locked') return null
  if (!scenario.unlock_requested) return 'locked_no_request'
  return 'locked_awaiting_final_approval'
}

// Permission-and-state gate for the "Submit for Lock Review" button.
// Returns {ok, reason} same shape as canRequestUnlock etc.
//
// The button is enabled when ALL of:
//   - scenario exists
//   - state = 'drafting'
//   - user has submit_lock permission
//   - is_recommended = true
//   - no sibling locked in this (AYE, stage)
//
// The validator (validateScenarioForLock) covers the same ground
// plus the "all zeros" content check. This wrapper is for the simple
// affordance-gating case (button enabled/disabled); the modal uses
// the validator for the full pre-flight including "all zeros".
export function canSubmitForLockReview({
  scenario,
  hasSubmitLock,
  lockedSibling,
}) {
  if (!scenario) return { ok: false, reason: 'no_scenario' }
  if (!hasSubmitLock) return { ok: false, reason: 'permission_insufficient' }
  if (scenario.state !== 'drafting') {
    return { ok: false, reason: 'wrong_state' }
  }
  if (!scenario.is_recommended) {
    return { ok: false, reason: 'not_recommended' }
  }
  if (lockedSibling) {
    return { ok: false, reason: 'sibling_locked' }
  }
  return { ok: true }
}

// Permission gate for approving a pending lock review (the green
// "Approve and Lock" button on the pending banner).
//
// Mirrors lock_tuition_scenario's caller checks: scenario state must
// be 'pending_lock_review', is_recommended must be true, caller must
// hold approve_lock.
export function canApproveLock({ scenario, hasApproveLock }) {
  if (!scenario) return { ok: false, reason: 'no_scenario' }
  if (!hasApproveLock) return { ok: false, reason: 'permission_insufficient' }
  if (scenario.state !== 'pending_lock_review') {
    return { ok: false, reason: 'wrong_state' }
  }
  if (!scenario.is_recommended) {
    return { ok: false, reason: 'not_recommended' }
  }
  return { ok: true }
}

// Permission gate for rejecting a pending lock review.
//
// Same gates as approve. The rejection requires a non-empty reason
// (the modal enforces text content; the RPC does too); this gate
// only handles permission-and-state.
export function canRejectLock({ scenario, hasApproveLock }) {
  if (!scenario) return { ok: false, reason: 'no_scenario' }
  if (!hasApproveLock) return { ok: false, reason: 'permission_insufficient' }
  if (scenario.state !== 'pending_lock_review') {
    return { ok: false, reason: 'wrong_state' }
  }
  return { ok: true }
}

// ---- Lock workflow RPC wrappers ----------------------------------------
//
// Tuition uses dedicated RPCs for all three lock transitions (submit,
// approve, reject). These thin wrappers normalize the call shape so
// the UI components don't need to know the parameter names.

export async function submitTuitionScenarioForLockReview({ scenarioId }) {
  const { error } = await supabase.rpc('submit_tuition_scenario_for_lock_review', {
    p_scenario_id: scenarioId,
  })
  if (error) throw error
}

export async function approveAndLockTuitionScenario({
  scenarioId,
  lockedVia = 'cascade',
  overrideJustification = null,
}) {
  const { data, error } = await supabase.rpc('lock_tuition_scenario', {
    p_scenario_id: scenarioId,
    p_locked_via: lockedVia,
    p_override_justification: overrideJustification,
  })
  if (error) throw error
  return data  // snapshot id (uuid)
}

export async function rejectTuitionScenarioLock({ scenarioId, reason }) {
  const { error } = await supabase.rpc('reject_tuition_scenario_lock', {
    p_scenario_id: scenarioId,
    p_reason: reason,
  })
  if (error) throw error
}

// ============================================================================
// UNLOCK WORKFLOW
// ============================================================================

// Can this user request an unlock on this locked scenario?
//
// v3.7 two-identity model: permission gate is approve_unlock (not
// submit_lock or a separate request_unlock perm). Submitting the
// request counts as approval_1, so the request gate matches the
// approve gate.
//
// Mirrors the DB rules in request_tuition_scenario_unlock:
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

// Can this user record approval_2 on the pending unlock?
//
// Mirrors approve_tuition_scenario_unlock:
//   - scenario state = 'locked' (it stays locked throughout the
//     unlock-in-progress window — §8.13)
//   - unlock_requested = true
//   - caller has approve_unlock or higher
//   - caller is NOT the requester (initiator separation; the requester
//     already counted as approval_1)
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
// housekeeping action, not a governance one.
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

// ---- Validators that combine permission gates with content checks ------

// Minimum length for justification (request) and reason (reject /
// withdraw) text fields. Matches Budget's UNLOCK_TEXT_MIN_LENGTH so
// the user experience is consistent across modules.
const MIN_TEXT_LENGTH = 10

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

export function validateUnlockApproval(scenario, currentUser, hasApproveUnlock) {
  return canApproveUnlock(scenario, currentUser, hasApproveUnlock)
}

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

// Human-readable copy for each reason code. Single source of truth
// for end-user copy — UI components reference these by reason code
// rather than hardcoding strings.
export const TUITION_LOCK_REASON_COPY = {
  // permission gates
  no_user:                    'You must be signed in.',
  no_scenario:                'No active scenario.',
  permission_insufficient:    'You do not have the required Tuition permission for this action.',
  // state gates
  wrong_state:                'Action not available in the scenario’s current state.',
  state_not_locked:           'This scenario is not currently locked.',
  unlock_already_requested:   'An unlock request is already in progress.',
  no_unlock_requested:        'No unlock request is pending on this scenario.',
  // lock submit specific
  not_recommended:            'Scenario must be marked as recommended before it can be locked.',
  sibling_locked:             'Another scenario in this (AYE, stage) is currently locked. Unlock it before submitting this one for lock review.',
  // initiator separation
  is_initiator:               'The unlock requester (whose submission counts as the first approval) cannot also record the second approval. A different approver is required.',
  not_initiator:              'Only the original requester can withdraw this request.',
  // content
  justification_empty:        'Justification is required.',
  justification_too_short:    `Justification must be at least ${MIN_TEXT_LENGTH} characters.`,
  reason_empty:               'A reason is required.',
  reason_too_short:           `Reason must be at least ${MIN_TEXT_LENGTH} characters.`,
}
