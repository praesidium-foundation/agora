import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { getCanonicalLockedArtifactName } from '../../lib/scenarioName'
import FieldLabel from '../FieldLabel'

// Confirmation modal that drives create_scenario_from_snapshot.
//
// Architecture §8.14. Opens when the user picks a locked predecessor
// card on the non-first-stage setup view. Surfaces what is about to
// happen (one-line summary), captures an optional scenario name
// (defaulted to "Scenario 1"), and on confirm calls the RPC.
//
// Why a modal: setting up a new working stage from a predecessor is a
// deliberate action, and the confirmation pause matches the modal
// pattern used elsewhere for governance-weight actions (lock submit,
// unlock request). The modal also gives space for the explanatory copy
// that explains the locked predecessor stays untouched — important
// because users need to understand they are not modifying the
// approved snapshot.
//
// Props:
//   targetStage     — { id, display_name } of the stage being seeded
//   sourceSnapshot  — { id, scenario_label, stage_display_name_at_lock,
//                        locked_at, kpi_total_income, ... }
//                     The locked predecessor's snapshot row.
//   sourceAye       — { id, label } the AYE this is happening in
//   defaultName     — optional default scenario name; falls back to
//                     "Scenario 1"
//   onCancel        — () => void
//   onSuccess       — (newScenarioId) => void; parent navigates into
//                     the new scenario after refetch

export default function SeedFromPredecessorModal({
  targetStage,
  sourceSnapshot,
  sourceAye,
  defaultName,
  onCancel,
  onSuccess,
}) {
  const [scenarioName, setScenarioName] = useState(defaultName || 'Scenario 1')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, submitting])

  const trimmed = scenarioName.trim()
  const canSubmit = trimmed.length > 0 && !submitting

  // Predecessor identity — uses canonical naming because the snapshot
  // IS the locked artifact (the official approved version of the
  // predecessor stage).
  const predecessorCanonical = getCanonicalLockedArtifactName(
    sourceAye,
    { display_name: sourceSnapshot.stage_display_name_at_lock },
    null,
  )

  async function handleConfirm() {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const { data, error } = await supabase.rpc('create_scenario_from_snapshot', {
        p_target_stage_id: targetStage.id,
        p_source_snapshot_id: sourceSnapshot.id,
        p_scenario_name: trimmed,
      })
      if (error) throw error
      onSuccess?.(data)
    } catch (e) {
      setSubmitError(e.message || String(e))
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
      onClick={() => !submitting && onCancel()}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-xl w-full p-0 shadow-lg max-h-[90vh] overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="seed-from-predecessor-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="seed-from-predecessor-title"
            className="font-display text-navy text-[18px] leading-tight"
          >
            Set up {targetStage.display_name}
          </h3>
          <button
            type="button"
            onClick={() => !submitting && onCancel()}
            disabled={submitting}
            aria-label="Close"
            className="text-muted hover:text-navy text-[18px] leading-none disabled:opacity-30"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto">
          <p className="font-body text-sm text-body leading-relaxed mb-4">
            This will create a new scenario in{' '}
            <strong className="font-medium">{targetStage.display_name}</strong>{' '}
            using{' '}
            <strong className="font-medium">{predecessorCanonical}</strong>{' '}
            as its starting point. The lines will be copied; you can edit
            them in the new stage. The original locked{' '}
            {sourceSnapshot.stage_display_name_at_lock} is unaffected — it
            remains in audit history exactly as approved.
          </p>

          <FieldLabel htmlFor="seed-scenario-name">
            Scenario name
          </FieldLabel>
          <input
            id="seed-scenario-name"
            type="text"
            value={scenarioName}
            onChange={(e) => setScenarioName(e.target.value)}
            className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none"
          />
          <p className="font-body text-[11px] text-muted italic mt-1.5">
            You can rename later from the scenario tab menu.
          </p>

          {submitError && (
            <p className="text-status-red text-sm mt-4" role="alert">
              {submitError}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-4 px-6 py-4 border-t-[0.5px] border-card-border">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="font-body text-muted hover:text-navy text-sm disabled:opacity-30"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canSubmit}
            className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Creating…' : 'Create scenario'}
          </button>
        </div>
      </div>
    </div>
  )
}
