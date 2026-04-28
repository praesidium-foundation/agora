// Lock-workflow helpers for the Preliminary Budget module.
//
// Three transitions need orchestration:
//
//   drafting → pending_lock_review     ("Submit for Lock Review")
//     - Pre-flight validation:
//         * scenario.is_recommended = true
//         * at least one non-zero budget line
//         * cascade rules satisfied (school_lock_cascade_rules vs.
//           module_instances state for the current AYE)
//     - On any failure, admin may override with required justification.
//     - Client-side UPDATE to scenarios.state.
//
//   pending_lock_review → locked       ("Approve and Lock")
//     - Approver clicks; we call the RPC
//       lock_preliminary_budget_scenario(scenario_id, locked_via,
//                                        override_justification)
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

// Pure validation over scenario + lines. Returns array of failure
// objects each shaped { kind, message }. kind values are stable strings
// callers can branch on for custom rendering.
export function validateScenarioForLock(scenario, lines) {
  const failures = []

  if (!scenario) {
    failures.push({
      kind: 'missing_scenario',
      message: 'No active scenario.',
    })
    return failures
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
// module_being_locked = 'preliminary_budget' and verifies each required
// module is in the required state for the AYE.
//
// Returns { failures: [{required_module, required_state, actual_state,
//                       is_required, message}] }.
//
// "actual_state" is 'not started' when no module_instance row exists for
// that (module, aye) — typical during phased rollout where the upstream
// module hasn't been built yet.
export async function checkCascadeRules(ayeId) {
  const [rulesResult, instancesResult] = await Promise.all([
    supabase
      .from('school_lock_cascade_rules')
      .select('module_being_locked, required_module, required_state, is_required')
      .eq('module_being_locked', 'preliminary_budget'),
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
  return { failures }
}

// Human-readable module label for validation messages. Falls back to
// the raw code if no friendly mapping exists. Could be replaced by a
// query against modules.display_name when it's worth the round-trip.
function humanModuleLabel(code) {
  return ({
    enrollment_estimator: 'Enrollment Estimator',
    tuition_worksheet:    'Tuition Worksheet',
    staffing:             'Staffing',
    preliminary_budget:   'Preliminary Budget',
    enrollment_audit:     'Enrollment Audit',
    final_budget:         'Final Budget',
    chart_of_accounts:    'Chart of Accounts',
  })[code] || code
}

// Submit transition. Caller has already run validation and either
// passed or has an override + justification. We just UPDATE the row.
//
// locked_via and override_justification are saved on the scenarios row
// here so they're carried into the eventual snapshot at approve time.
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
    .from('preliminary_budget_scenarios')
    .update(updates)
    .eq('id', scenarioId)
  if (error) throw error
}

// Reject transition. Returns scenario to drafting; clears locked_via
// and override_justification (a fresh override needs a fresh
// justification on resubmit).
export async function rejectScenarioLock({ scenarioId, userId }) {
  const { error } = await supabase
    .from('preliminary_budget_scenarios')
    .update({
      state: 'drafting',
      locked_via: null,
      override_justification: null,
      updated_by: userId ?? null,
    })
    .eq('id', scenarioId)
  if (error) throw error
}

// Approve + lock. Calls the SECURITY DEFINER RPC which atomically:
//   1. Validates state and is_recommended at the DB layer
//   2. Computes KPIs at lock time
//   3. Inserts budget_snapshots header
//   4. Inserts budget_snapshot_lines for every line with captured
//      account state (code, name, hierarchy path, flags)
//   5. Updates scenarios.state to 'locked'
//
// If any step fails, the whole transaction rolls back — there is no
// scenario where the row says 'locked' but the snapshot is missing.
//
// Reads the scenario's saved locked_via / override_justification (set
// by submitScenarioForLockReview) and forwards them to the RPC so the
// snapshot captures the override trail.
export async function approveAndLockScenario({ scenarioId }) {
  // Read the in-flight override metadata that submit saved.
  const { data: scenario, error: readErr } = await supabase
    .from('preliminary_budget_scenarios')
    .select('locked_via, override_justification')
    .eq('id', scenarioId)
    .single()
  if (readErr) throw readErr

  const { data, error } = await supabase.rpc(
    'lock_preliminary_budget_scenario',
    {
      p_scenario_id: scenarioId,
      p_locked_via: scenario?.locked_via || 'normal',
      p_override_justification: scenario?.override_justification || null,
    }
  )
  if (error) throw error
  // RPC returns a single uuid (the snapshot id).
  return Array.isArray(data) ? data[0] : data
}
