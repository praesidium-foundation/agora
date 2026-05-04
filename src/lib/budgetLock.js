// Lock-workflow helpers for the Budget module's stage scenarios.
//
// Migration 011 generalized Budget to support configurable workflow
// stages. The lock workflow is stage-agnostic: every stage in every
// workflow uses the same submit / approve / reject transitions.
//
// Three transitions:
//
//   drafting → pending_lock_review     ("Submit for Lock Review")
//     - Pre-flight validation (validateScenarioForLock + checkCascadeRules)
//     - On any failure, admin may override with required justification
//     - Client-side UPDATE to budget_stage_scenarios.state
//
//   pending_lock_review → locked       ("Approve and Lock")
//     - Approver clicks; we call the RPC
//       lock_budget_stage_scenario(scenario_id, locked_via,
//                                  override_justification)
//       which atomically inserts the snapshot and flips state.
//
//   pending_lock_review → drafting     ("Reject and return to drafting")
//     - Approver rejects; client-side UPDATE.
//
// Permissions are enforced at the DB layer for approve+lock (the RPC
// is SECURITY DEFINER and checks current_user_has_module_perm). Submit
// and Reject rely on the existing RLS edit-perm gate plus UI gating;
// see Appendix D for the trust-model note.

import { supabase } from './supabase'

// Find a sibling scenario (same AYE + stage) that's currently locked.
// Returns the sibling row or null. Pure / sync; takes the in-memory
// scenarios array from the page so it doesn't need a DB roundtrip.
//
// Used by:
//   - ScenarioTabs to gate the "Mark as recommended" menu item
//   - SubmitLockModal to add a hardBlock failure on submit
//   - BudgetStage to render the informational banner
//
// Schema-level safety net: Migration 015's triggers reject the same
// transitions even if a malicious caller bypasses these UI checks.
export function findLockedSibling(scenarios, currentScenarioId) {
  if (!Array.isArray(scenarios)) return null
  return scenarios.find(
    (s) => s.id !== currentScenarioId && s.state === 'locked'
  ) || null
}

// Pure validation over scenario + lines + (optional) locked sibling.
//
// Failures may carry a `hardBlock: true` flag indicating the failure
// can NOT be overridden at the application layer (it'd be rejected by
// the DB trigger anyway). The override checkbox in SubmitLockModal is
// hidden when any hardBlock failure is present.
export function validateScenarioForLock(scenario, lines, lockedSibling = null) {
  const failures = []

  if (!scenario) {
    failures.push({ kind: 'missing_scenario', message: 'No active scenario.' })
    return failures
  }

  // Sibling-lock guard. Hard block — the DB trigger from Migration 015
  // rejects the transition even with admin "override" set, so we don't
  // expose an override path the database would refuse.
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

  const hasNonZero = (lines || []).some((l) => Number(l.amount) !== 0)
  if (!hasNonZero) {
    failures.push({
      kind: 'all_zero',
      message:
        'At least one budget line must have a non-zero amount. A budget of all zeros is unlikely to be intentional.',
    })
  }

  return failures
}

// Cascade-rule check. Looks up school_lock_cascade_rules for
// module_being_locked = 'budget' and verifies each required upstream
// module is in the required state for the AYE.
//
// v3.8.10 (Tuition-D): when `scenarioStageType === 'preliminary'`,
// also injects a cross-module cascade failure for Tuition Stage 1.
// Per architecture §7.5, a Preliminary Budget for AYE N cannot be
// locked until the Tuition Stage 1 (Tuition Planning) for the same
// AYE is locked — the locked tuition schedule is a key revenue
// input the Preliminary Budget should reflect. This is a HARD BLOCK
// (hardBlock: true on the failure) because the rule is enforceable
// only at submit time; we don't want to expose an override path
// when the upstream resolution is straightforward (lock the Tuition
// Planning, then submit).
//
// Prospective enforcement note: this rule is enforced at the
// application layer only (no DB trigger added in v3.8.10), and only
// fires on NEW lock submissions. AYE 2026's Preliminary Budget is
// already locked at v3.8.10 ship time and predates this rule; the
// historical artifact is preserved as-is. The cascade fires the
// next time anyone goes through the lock flow on a Preliminary
// Budget — for AYE 2026 that means after an unlock + re-lock cycle,
// or when AYE 2027 ships.
//
// Returns { failures: [{kind, required_module, required_state,
//                       actual_state, is_required, message,
//                       hardBlock?}] }.
//
// "actual_state" is 'not started' when no module_instance row exists
// for that (module, aye).
//
// Note: cascade rules in school_lock_cascade_rules are per-MODULE,
// not per-stage. The Tuition→Budget cross-module rule introduced
// here IS per-stage (only Preliminary Budget gates on Tuition);
// rather than extending the rules table schema (an avoidable
// migration), v3.8.10 hardcodes this single rule alongside the
// table-driven generic rules. When the catalog of cross-module
// per-stage rules grows, we can hoist it into a `_per_stage` rules
// table.
export async function checkCascadeRules(ayeId, { scenarioStageType = null } = {}) {
  const [rulesResult, instancesResult] = await Promise.all([
    supabase
      .from('school_lock_cascade_rules')
      .select('module_being_locked, required_module, required_state, is_required')
      .eq('module_being_locked', 'budget'),
    supabase
      .from('module_instances')
      .select('state, modules(code)')
      .eq('aye_id', ayeId),
  ])

  if (rulesResult.error) throw rulesResult.error
  if (instancesResult.error) throw instancesResult.error

  const stateByCode = new Map()
  for (const mi of instancesResult.data || []) {
    if (mi.modules?.code) stateByCode.set(mi.modules.code, mi.state)
  }

  const failures = []
  for (const rule of rulesResult.data || []) {
    const actualState = stateByCode.get(rule.required_module) || 'not started'
    if (actualState !== rule.required_state) {
      failures.push({
        kind: 'cascade_rule',
        required_module: rule.required_module,
        required_state: rule.required_state,
        actual_state: actualState,
        is_required: rule.is_required,
        message: `${humanModuleLabel(rule.required_module)} must be ${rule.required_state} (currently: ${actualState}).`,
      })
    }
  }

  // v3.8.10 (Tuition-D) cross-module per-stage cascade: Preliminary
  // Budget gates on a locked Tuition Stage 1 in the same AYE.
  if (scenarioStageType === 'preliminary') {
    const tuitionState = await getTuitionStage1LockState(ayeId)
    if (!tuitionState.locked) {
      failures.push({
        kind: 'tuition_stage_1_not_locked',
        hardBlock: true,
        is_required: true,
        message:
          'Tuition Planning must be locked for this AYE before the Preliminary Budget can be locked. ' +
          'The locked tuition schedule is a key revenue input the Preliminary Budget should reflect.',
      })
    }
  }

  return { failures }
}

// Probe whether a Tuition Stage 1 (preliminary) lock exists for the
// given AYE. Used by checkCascadeRules's cross-module rule and
// directly by any UI surface that wants to gate on "is the upstream
// Tuition piece ready?" without running the full cascade check.
//
// Returns { locked: boolean, stageDisplayName: string|null }. The
// stage display name is captured-by-value from
// tuition_worksheet_snapshots when present, else read from the live
// stages table — useful for surfacing "you need to lock Tuition
// Planning first" with the school's actual configured stage label.
//
// One round-trip: a lookup against tuition_worksheet_snapshots
// joined to the workflow stage row. Returns locked=true iff at least
// one snapshot row exists for the (AYE, preliminary stage).
export async function getTuitionStage1LockState(ayeId) {
  // Resolve the preliminary-typed stage of the tuition workflow.
  const { data: stages, error: stageErr } = await supabase
    .from('module_workflow_stages')
    .select('id, display_name, module_workflows!inner(modules!inner(code))')
    .eq('module_workflows.modules.code', 'tuition')
    .eq('stage_type', 'preliminary')
    .limit(1)
  if (stageErr) throw stageErr
  const stage = stages?.[0]
  if (!stage) {
    // Tuition workflow not configured in this school. Treat as
    // "locked" semantically — there's no tuition module to gate on.
    return { locked: true, stageDisplayName: null }
  }

  const { data: snaps, error: snapErr } = await supabase
    .from('tuition_worksheet_snapshots')
    .select('id, stage_display_name_at_lock')
    .eq('aye_id', ayeId)
    .eq('stage_id', stage.id)
    .limit(1)
  if (snapErr) throw snapErr

  const snap = snaps?.[0]
  return {
    locked: Boolean(snap),
    stageDisplayName: snap?.stage_display_name_at_lock || stage.display_name,
  }
}

function humanModuleLabel(code) {
  return ({
    enrollment_estimator: 'Enrollment Estimator',
    tuition:              'Tuition',
    staffing:             'Staffing',
    budget:               'Budget',
    chart_of_accounts:    'Chart of Accounts',
  })[code] || code
}

// Submit transition.
export async function submitScenarioForLockReview({
  scenarioId,
  lockedVia = 'normal',
  overrideJustification = null,
  userId,
}) {
  const updates = {
    state: 'pending_lock_review',
    locked_via: lockedVia,
    override_justification:
      lockedVia === 'override'
        ? (overrideJustification ? overrideJustification.trim() : null)
        : null,
    updated_by: userId ?? null,
  }
  const { error } = await supabase
    .from('budget_stage_scenarios')
    .update(updates)
    .eq('id', scenarioId)
  if (error) throw error
}

// Reject transition.
export async function rejectScenarioLock({ scenarioId, userId }) {
  const { error } = await supabase
    .from('budget_stage_scenarios')
    .update({
      state: 'drafting',
      locked_via: null,
      override_justification: null,
      updated_by: userId ?? null,
    })
    .eq('id', scenarioId)
  if (error) throw error
}

// Approve + lock. Calls the stage-aware SECURITY DEFINER RPC.
//
// The RPC reads the scenario's stage_id internally and captures stage
// metadata at lock time, so callers don't need to pass it.
export async function approveAndLockScenario({ scenarioId }) {
  const { data: scenario, error: readErr } = await supabase
    .from('budget_stage_scenarios')
    .select('locked_via, override_justification')
    .eq('id', scenarioId)
    .single()
  if (readErr) throw readErr

  const { data, error } = await supabase.rpc(
    'lock_budget_stage_scenario',
    {
      p_scenario_id: scenarioId,
      p_locked_via: scenario?.locked_via || 'normal',
      p_override_justification: scenario?.override_justification || null,
    }
  )
  if (error) throw error
  return Array.isArray(data) ? data[0] : data
}
