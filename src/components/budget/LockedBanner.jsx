// Banner shown above the budget detail when the active scenario is
// locked. Surfaces the lock metadata (when, by whom, override or
// not) so the user understands the state of the budget at a glance.
//
// Architecture Section 2.6: locked outputs carry an approved-by
// indicator. This banner is the on-screen equivalent of the PDF
// approved-by footer.
//
// Props:
//   scenario   — active scenario object (state = 'locked')
//   lockedByName — display name of the user who locked it (resolved
//                  by parent from auth metadata or user_profiles)

function LockedBanner({ scenario, lockedByName }) {
  const dateStr = scenario.locked_at
    ? new Date(scenario.locked_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '—'

  const isOverride = scenario.locked_via === 'override'

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
        <div className="flex-1">
          <p className={`font-display text-[13px] tracking-[0.06em] uppercase mb-0.5 ${
            isOverride ? 'text-status-amber' : 'text-status-green'
          }`}>
            Locked {isOverride && '— with override'}
          </p>
          <p className="text-sm text-body leading-relaxed">
            <strong className="font-medium">{scenario.scenario_label}</strong>{' '}
            was locked on <strong className="font-medium">{dateStr}</strong>
            {lockedByName ? <> by <strong className="font-medium">{lockedByName}</strong></> : null}.
            To edit, request unlock from the Treasurer.
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
      </div>
    </div>
  )
}

export default LockedBanner
