import { useEffect, useState } from 'react'
import Card from '../Card'
import AYESelector from '../AYESelector'
import { findPriorLockedBudgetSnapshot } from '../../lib/budgetBootstrap'

// First-page prompt rendered inside the budget detail zone when an
// AYE has no scenario yet. Two clear sections:
//
//   1. Confirm academic year — prominent AYESelector so first-time
//      users see explicitly which year they're budgeting for. Defaults
//      to current AYE; user can switch before picking a bootstrap
//      path.
//
//   2. Pick a bootstrap path — three options. "Bootstrap from prior
//      AYE" is greyed out until a prior locked snapshot exists. The
//      probe runs whenever the AYE selection changes (the prior-AYE
//      relationship is AYE-relative).
//
// Props:
//   ayeId            uuid       — the active AYE id
//   ayeLabel         string     — the active AYE label (display)
//   onAyeChange(id)  ()         — switch the active AYE
//   onStartBlank     ()         — Start with $0 path
//   onUploadCsv      ()         — Open CSV import modal path
//   onBootstrapPrior (snapshot) — Bootstrap from prior AYE path; the
//                                  parent receives the resolved
//                                  {snapshot, aye} so it doesn't have
//                                  to reload
//   creating         boolean    — true while a creation is in flight;
//                                  disables all buttons
//   error            string?    — error text to surface above the buttons

function BudgetEmptyState({
  ayeId,
  ayeLabel,
  onAyeChange,
  onStartBlank,
  onUploadCsv,
  onBootstrapPrior,
  creating = false,
  error,
}) {
  const [priorSnapshot, setPriorSnapshot] = useState(null)
  const [probeLoading, setProbeLoading] = useState(true)

  // Re-probe whenever the AYE changes — switching years can flip
  // "no prior budget" to "prior available" (or vice versa) instantly.
  useEffect(() => {
    if (!ayeId) {
      setPriorSnapshot(null)
      setProbeLoading(false)
      return
    }
    let mounted = true
    setProbeLoading(true)
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
    <div className="flex items-center justify-center min-h-[60vh] py-6">
      <Card className="max-w-2xl w-full">
        <h2 className="font-display text-navy text-[22px] mb-1 leading-tight">
          Set up your Preliminary Budget
        </h2>
        <p className="font-body italic text-muted text-sm mb-6">
          Two quick steps. You can rename, edit, or reset later.
        </p>

        {/* Step 1: AYE selection. Prominent so first-time users see
            exactly which year they're targeting before they pick a
            bootstrap path. */}
        <section className="mb-6 pb-5 border-b-[0.5px] border-card-border">
          <p className="font-display text-[12px] text-navy/70 tracking-[0.10em] uppercase mb-2">
            Step 1 — Confirm the academic year
          </p>
          <div className="flex items-end gap-4 flex-wrap">
            <AYESelector value={ayeId} onChange={onAyeChange} />
            {ayeLabel && (
              <p className="font-body italic text-muted text-xs pb-2">
                You're working on <strong className="not-italic font-medium text-body">{ayeLabel}</strong>.
                Switch above if this isn't the right year.
              </p>
            )}
          </div>
        </section>

        {/* Step 2: bootstrap path. */}
        <section>
          <p className="font-display text-[12px] text-navy/70 tracking-[0.10em] uppercase mb-2">
            Step 2 — How would you like to start?
          </p>

          {error && (
            <p className="text-status-red text-sm mb-4" role="alert">
              {error}
            </p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
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

            <BootstrapButton
              label="Upload prior budget CSV"
              disabled={creating}
              onClick={onUploadCsv}
              subtitle="Import last year's actuals from your accounting software"
            />

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
        </section>
      </Card>
    </div>
  )
}

// Single bootstrap-option button.
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
