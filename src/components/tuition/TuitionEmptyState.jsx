import Card from '../Card'
import AYESelector from '../AYESelector'

// First-page prompt rendered inside the tuition detail zone when an
// (AYE, Stage) has no scenario yet.
//
// Tuition deviates from the universal three-option setup gateway
// pattern (CLAUDE.md "Module workflows and stages"):
//
//   - Bootstrap-from-prior is deferred until AYE 2027 (no prior
//     locked Tuition Planning snapshot exists yet — AYE 2026 is the
//     first cycle in which Tuition runs).
//   - CSV import is permanently skipped. Tuition's data shape — four
//     tier rows + three fees + N family-distribution rows — does not
//     warrant a CSV format. Module authors of future modules with
//     similarly small data shapes should consider this precedent.
//
// Single primary action: "Create first scenario." Click seeds a
// scenario with sensible defaults and routes the user into the
// configuration view.
//
// Props:
//   ayeId             uuid       — the active AYE id
//   ayeLabel          string     — the active AYE label (display)
//   stageDisplayName  string     — e.g., "Tuition Planning"; read from
//                                   module_workflow_stages.display_name
//                                   per CLAUDE.md "Module workflows
//                                   and stages" (never hardcoded)
//   onAyeChange(id)              — switch the active AYE
//   onCreate          ()         — seed and switch to a new scenario
//   creating          boolean    — true while creation is in flight;
//                                   disables the primary button
//   error             string?    — error text to surface above the button

function TuitionEmptyState({
  ayeId,
  ayeLabel,
  stageDisplayName,
  onAyeChange,
  onCreate,
  creating = false,
  error,
}) {
  const stageLabel = stageDisplayName || 'Tuition'

  return (
    <div className="flex items-center justify-center min-h-[60vh] py-6">
      <Card className="max-w-2xl w-full">
        <h2 className="font-display text-navy text-[22px] mb-1 leading-tight">
          Set up your {stageLabel}
        </h2>
        <p className="font-body italic text-muted text-sm mb-6">
          One quick step. You can rename, edit, or delete later.
        </p>

        {/* Step 1: AYE selection. Prominent so first-time users see
            exactly which year they are targeting before they create. */}
        <section className="mb-6 pb-5 border-b-[0.5px] border-card-border">
          <p className="font-display text-[12px] text-navy/70 tracking-[0.10em] uppercase mb-2">
            Step 1 — Confirm the academic year
          </p>
          <AYESelector value={ayeId} onChange={onAyeChange} />
        </section>

        {/* Step 2: create. Single fresh-start path — no bootstrap
            options. */}
        <section>
          <p className="font-display text-[12px] text-navy/70 tracking-[0.10em] uppercase mb-2">
            Step 2 — Start your tuition planning
          </p>

          {error && (
            <p className="text-status-red text-sm mb-4" role="alert">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={onCreate}
            disabled={creating || !ayeId}
            className="bg-navy text-gold border-[0.5px] border-navy px-5 py-2.5 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? 'Creating…' : 'Create first scenario'}
          </button>

          <p className="font-body italic text-muted text-xs leading-relaxed mt-4">
            A fresh scenario is created with four tier rows (1 / 2 / 3 / 4+
            students per family), a 50% faculty discount rule by default, and
            zeroed envelopes / fees / projected families. Fill the values in
            from there.
          </p>
          <p className="font-body italic text-muted text-xs leading-relaxed mt-2">
            Bootstrapping from a prior AYE is not available yet — this is the
            first cycle in which Tuition runs. Next year, the locked Tuition
            Planning snapshot will be available as a starting point.
          </p>
        </section>
      </Card>
    </div>
  )
}

export default TuitionEmptyState
