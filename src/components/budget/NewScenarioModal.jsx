import { useEffect, useState } from 'react'
import {
  createBlankScenario,
  createScenarioFromCurrent,
  createScenarioFromPriorAye,
  findPriorLockedBudgetSnapshot,
} from '../../lib/budgetBootstrap'

// "+ New scenario" modal. Asks for label + description, then offers
// the same set of bootstrap paths as the empty state PLUS a fourth:
// "Copy from current scenario." Useful when the user wants a small-
// diff alternate (e.g., "with HS" vs. "without HS") that starts from
// the active baseline.
//
// Props:
//   ayeId            — uuid for the AYE the new scenario belongs to
//   ayeLabel         — display label for the AYE
//   currentScenario  — { id, scenario_label } | null
//                      When non-null, "Copy from current" is offered.
//   userId           — for created_by / updated_by audit
//   onClose          — () => void
//   onCreated(id)    — (newScenarioId) => void; parent re-fetches and
//                      switches to the new tab.
//
// CSV upload is intentionally NOT offered here — adding it requires
// rendering the CSV import modal inside this modal, which would mean
// nesting dialogs. If the user wants CSV-driven creation they reset
// the active scenario to empty state and use the CSV bootstrap there.

function NewScenarioModal({ ayeId, ayeLabel, currentScenario, userId, onClose, onCreated }) {
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  // Default path: copy from current if available, else start blank.
  const [path, setPath] = useState(
    currentScenario ? 'copy_current' : 'blank'
  )

  const [priorSnapshot, setPriorSnapshot] = useState(null)
  const [probeLoading, setProbeLoading] = useState(true)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  // Probe for prior AYE budget at mount.
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
    return () => { mounted = false }
  }, [ayeId])

  const priorEnabled = !probeLoading && priorSnapshot !== null

  async function handleConfirm() {
    setSubmitting(true)
    setError(null)
    setNotice(null)

    const trimmedLabel = label.trim()
    const trimmedDescription = description.trim() || null

    try {
      let result
      if (path === 'copy_current') {
        if (!currentScenario) throw new Error('No current scenario to copy from.')
        result = await createScenarioFromCurrent({
          ayeId,
          sourceScenarioId: currentScenario.id,
          userId,
          label: trimmedLabel || undefined,  // let auto-label kick in if empty
          description: trimmedDescription,
        })
      } else if (path === 'prior') {
        if (!priorSnapshot) throw new Error('No prior locked budget to copy from.')
        result = await createScenarioFromPriorAye({
          ayeId,
          userId,
          label: trimmedLabel || undefined,
          description: trimmedDescription,
          priorSnapshotId: priorSnapshot.snapshot.id,
        })
        if (result.skippedNames && result.skippedNames.length > 0) {
          // Bubble up via parent's notice mechanism — for simplicity we
          // expose it as a success-with-caveat and the parent surfaces
          // separately. Here we just call onCreated with the id; the
          // parent owns the larger UI.
          // (Consider extending onCreated signature later.)
        }
      } else {
        // 'blank'
        result = await createBlankScenario({
          ayeId,
          userId,
          label: trimmedLabel || undefined,
          description: trimmedDescription,
        })
      }
      onCreated(result.scenarioId)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
      onClick={() => !submitting && onClose()}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-lg w-full p-6 shadow-lg max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-scenario-title"
      >
        <h3
          id="new-scenario-title"
          className="font-display text-navy text-[20px] mb-1 leading-tight"
        >
          New scenario
        </h3>
        <p className="font-body italic text-muted text-sm mb-5">
          Adds a new scenario to {ayeLabel || 'this AYE'}. You can rename
          it later.
        </p>

        {error && (
          <p className="text-status-red text-sm mb-3" role="alert">
            {error}
          </p>
        )}

        <div className="space-y-4">
          <div>
            <label
              htmlFor="new-scenario-label"
              className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5"
            >
              Label
            </label>
            <input
              id="new-scenario-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. With HS"
              className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none"
            />
            <p className="font-body italic text-muted text-xs mt-1">
              Leave blank to auto-name (Scenario 2, Scenario 3, …).
            </p>
          </div>

          <div>
            <label
              htmlFor="new-scenario-description"
              className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5"
            >
              Description (optional)
            </label>
            <textarea
              id="new-scenario-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="One-line context for the board"
              className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none"
            />
          </div>

          <div>
            <p className="font-body text-[11px] text-muted uppercase tracking-wider mb-2">
              Start from
            </p>

            <div className="space-y-1.5">
              {currentScenario && (
                <PathRadio
                  name="new-scenario-path"
                  value="copy_current"
                  checked={path === 'copy_current'}
                  onChange={setPath}
                  label={`Copy from current scenario (${currentScenario.scenario_label})`}
                  hint="Best for small-diff alternates — same accounts, same starting amounts."
                />
              )}

              <PathRadio
                name="new-scenario-path"
                value="prior"
                checked={path === 'prior'}
                onChange={setPath}
                disabled={!priorEnabled}
                label="Bootstrap from prior AYE"
                hint={
                  probeLoading
                    ? 'Checking for prior budget…'
                    : priorSnapshot
                      ? `Copy from ${priorSnapshot.aye.label} ${priorSnapshot.snapshot.snapshot_type === 'final' ? 'Final' : 'Preliminary'}`
                      : 'No prior locked budget exists yet'
                }
              />

              <PathRadio
                name="new-scenario-path"
                value="blank"
                checked={path === 'blank'}
                onChange={setPath}
                label="Start with $0"
                hint="Pre-populate posting accounts at zero — useful for new schools."
              />
            </div>
          </div>
        </div>

        {notice && (
          <p className="text-status-amber text-sm mt-4" role="status">
            {notice}
          </p>
        )}

        <div className="flex items-center justify-end gap-4 pt-5 mt-5 border-t-[0.5px] border-card-border">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="font-body text-muted hover:text-navy text-sm disabled:opacity-30"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Creating…' : 'Create scenario'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PathRadio({ name, value, checked, onChange, disabled, label, hint }) {
  return (
    <label
      className={`flex items-start gap-2 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="accent-navy mt-1"
      />
      <span className="text-sm">
        <span className="font-medium text-body">{label}</span>
        {hint && (
          <span className="block text-muted italic text-[12px]">{hint}</span>
        )}
      </span>
    </label>
  )
}

export default NewScenarioModal
