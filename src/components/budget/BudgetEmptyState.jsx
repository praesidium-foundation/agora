import { useEffect, useState } from 'react'
import Card from '../Card'
import { findPriorLockedBudgetSnapshot } from '../../lib/budgetBootstrap'

// The "How would you like to start your Preliminary Budget?" prompt that
// renders inside the budget detail zone when an AYE has no scenarios yet.
//
// Three options. Two are always available; the third (Bootstrap from
// prior AYE) is enabled only when a prior AYE has a locked snapshot
// (preliminary or final). The probe runs on mount.
//
// Each button calls one of three callbacks. The parent owns the actual
// scenario-creation logic; this component is purely presentational.
//
// Props:
//   ayeId            uuid       — the AYE the new scenario belongs to
//   ayeLabel         string     — display label (e.g. "AYE 2027")
//   onStartBlank     ()         — Start with $0 path
//   onUploadCsv      ()         — Open CSV import modal path
//   onBootstrapPrior (snapshot) — Bootstrap from prior AYE path; receives
//                                  the resolved {snapshot, aye} so the
//                                  parent doesn't have to reload
//   creating         boolean    — true while a creation is in flight;
//                                  disables all buttons
//   error            string?    — error text to surface above the buttons

function BudgetEmptyState({
  ayeId,
  ayeLabel,
  onStartBlank,
  onUploadCsv,
  onBootstrapPrior,
  creating = false,
  error,
}) {
  const [priorSnapshot, setPriorSnapshot] = useState(null)
  const [probeLoading, setProbeLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    async function probe() {
      try {
        const result = await findPriorLockedBudgetSnapshot(ayeId)
        if (mounted) setPriorSnapshot(result)
      } catch {
        if (mounted) setPriorSnapshot(null)
      } finally {
        if (mounted) setProbeLoading(false)
      }
    }
    probe()
    return () => {
      mounted = false
    }
  }, [ayeId])

  const priorEnabled = !probeLoading && priorSnapshot !== null

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="max-w-2xl w-full">
        <h2 className="font-display text-navy text-[22px] mb-2 leading-tight">
          How would you like to start your{' '}
          {ayeLabel ? `${ayeLabel} ` : ''}Preliminary Budget?
        </h2>
        <p className="font-body text-muted text-sm mb-6 leading-relaxed">
          Pick a starting point. You can rename, edit, or reset the scenario at
          any time.
        </p>

        {error && (
          <p className="text-status-red text-sm mb-4" role="alert">
            {error}
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {/* Bootstrap from prior AYE */}
          <BootstrapButton
            primary
            label="Bootstrap from prior AYE"
            disabled={!priorEnabled || creating}
            onClick={() => priorEnabled && onBootstrapPrior(priorSnapshot)}
            subtitle={
              probeLoading
                ? 'Checking for prior budget…'
                : priorSnapshot
                  ? `Copy from ${priorSnapshot.aye.label} ${priorSnapshot.snapshot.snapshot_type === 'final' ? 'Final' : 'Preliminary'}`
                  : 'No prior locked budget exists yet'
            }
          />

          {/* Upload prior budget CSV */}
          <BootstrapButton
            label="Upload prior budget CSV"
            disabled={creating}
            onClick={onUploadCsv}
            subtitle="Import last year's actuals from your accounting software"
          />

          {/* Start with $0 */}
          <BootstrapButton
            label="Start with $0"
            disabled={creating}
            onClick={onStartBlank}
            subtitle="Pre-populate posting accounts at zero — useful for new schools"
          />
        </div>

        <p className="font-body italic text-muted text-xs leading-relaxed">
          Bootstrapping from a prior AYE copies last year's locked Final or
          Preliminary Budget as a starting point. Uploading a CSV imports
          last year's actuals from your accounting software (or any other
          source). Starting at $0 pre-populates posting accounts at zero so
          you can fill them in fresh.
        </p>
      </Card>
    </div>
  )
}

// Single bootstrap-option button. Visual treatment matches the project's
// inline button library — primary (gold underline) for the recommended
// path when available, secondary (subtle border) otherwise.
function BootstrapButton({ label, subtitle, primary, disabled, onClick }) {
  const base =
    'flex flex-col items-start gap-1 px-4 py-3 rounded-[8px] border-[0.5px] text-left transition-colors min-h-[88px]'
  const enabledCls = primary
    ? 'border-gold bg-gold/[0.06] text-navy hover:bg-gold/[0.10] cursor-pointer'
    : 'border-card-border bg-white text-navy hover:bg-cream-highlight cursor-pointer'
  const disabledCls =
    'border-card-border bg-white/40 text-muted/60 cursor-not-allowed'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${disabled ? disabledCls : enabledCls}`}
    >
      <span className="font-display text-[14px] tracking-[0.04em] leading-tight">
        {label}
      </span>
      <span className="font-body text-[11px] italic leading-snug">
        {subtitle}
      </span>
    </button>
  )
}

export default BudgetEmptyState
