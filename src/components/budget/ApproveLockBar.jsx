import { useState } from 'react'

// Banner shown above the budget detail when the active scenario is in
// pending_lock_review state and the current user has approve_lock
// permission. Two action buttons:
//
//   - Approve and Lock — calls the lock RPC; the scenario transitions
//                        to 'locked' atomically with snapshot capture
//                        (the parent component handles the call)
//   - Reject and return to drafting — clears the locked_via and
//                        override_justification fields, transitions
//                        back to 'drafting'
//
// Override metadata (locked_via, override_justification) is rendered
// above the buttons when present so the approver sees what they're
// signing off on. SCL accreditation review wants overrides documented;
// this is the surface.
//
// Props:
//   scenario   — active scenario object
//   onApprove  — async; parent calls approveAndLockScenario then reloads
//   onReject   — async; parent calls rejectScenarioLock then reloads

function ApproveLockBar({ scenario, onApprove, onReject }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function run(fn, busyLabel) {
    setBusy(busyLabel)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e.message || String(e))
      setBusy(false)
    }
    // On success the parent re-renders with new scenario state;
    // this component unmounts and busy/error reset implicitly.
  }

  const isOverride = scenario.locked_via === 'override'

  return (
    <div
      className={`mb-4 px-4 py-3 border-[0.5px] rounded ${
        isOverride
          ? 'bg-status-amber-bg border-status-amber/30'
          : 'bg-status-blue-bg border-status-blue/25'
      }`}
      role="region"
      aria-label="Approval pending"
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <p className={`font-display text-[13px] tracking-[0.06em] uppercase mb-1 ${
            isOverride ? 'text-status-amber' : 'text-status-blue'
          }`}>
            Pending lock review {isOverride && '— submitted with override'}
          </p>
          <p className="text-sm text-body">
            <strong className="font-medium">{scenario.scenario_label}</strong> is
            awaiting approval. Approving will lock the scenario and capture
            an immutable snapshot. Rejecting returns it to drafting.
          </p>
          {isOverride && scenario.override_justification && (
            <div className="mt-2 px-3 py-2 bg-white/60 border-[0.5px] border-status-amber/20 rounded text-sm">
              <p className="font-body text-[11px] text-status-amber uppercase tracking-wider mb-1">
                Override justification
              </p>
              <p className="text-body italic leading-relaxed">
                {scenario.override_justification}
              </p>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <button
            type="button"
            onClick={() => run(onReject, 'rejecting')}
            disabled={!!busy}
            className="font-body text-status-red text-sm hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
          >
            {busy === 'rejecting' ? 'Rejecting…' : 'Reject and return to drafting'}
          </button>
          <button
            type="button"
            onClick={() => run(onApprove, 'approving')}
            disabled={!!busy}
            className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'approving' ? 'Locking…' : 'Approve and Lock'}
          </button>
        </div>
      </div>
      {error && (
        <p className="text-status-red text-sm mt-3" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export default ApproveLockBar
