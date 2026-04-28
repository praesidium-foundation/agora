import { useEffect, useState } from 'react'
import { checkCascadeRules, validateScenarioForLock } from '../../lib/budgetLock'

// Modal that runs the pre-flight validation for submit-for-lock-review
// and either confirms the submit (clean pass) or surfaces failures and
// offers the override path (admin only).
//
// Validation produces failures in two layers:
//   - in-memory checks (validateScenarioForLock): is_recommended,
//     non-zero lines, scenario state
//   - cascade rules (checkCascadeRules): module_instances state for
//     every required upstream module per school_lock_cascade_rules
//
// Both lists render together; the user sees the full set in one shot.
//
// Override flow: when admin checks "override and submit anyway", a
// justification textarea appears (required, non-empty). Submit
// re-enables only when the textarea has content.
//
// Props:
//   scenario      — active scenario object
//   lines         — current line list (validation reads non-zero count)
//   ayeId         — for cascade rules check
//   isAdmin       — boolean; gates override option
//   onCancel      — () => void
//   onConfirm     — async ({lockedVia, overrideJustification}) => void;
//                    parent calls submitScenarioForLockReview

function SubmitLockModal({ scenario, lines, ayeId, isAdmin, onCancel, onConfirm }) {
  const [validating, setValidating] = useState(true)
  const [inMemoryFailures, setInMemoryFailures] = useState([])
  const [cascadeFailures, setCascadeFailures] = useState([])
  const [validationError, setValidationError] = useState(null)

  const [overrideMode, setOverrideMode] = useState(false)
  const [justification, setJustification] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    let mounted = true
    async function run() {
      setValidating(true)
      setValidationError(null)
      try {
        const inMem = validateScenarioForLock(scenario, lines)
        if (!mounted) return
        setInMemoryFailures(inMem)

        const { failures: cascadeFailing } = await checkCascadeRules(ayeId)
        if (!mounted) return
        setCascadeFailures(cascadeFailing)
      } catch (e) {
        if (mounted) setValidationError(e.message || String(e))
      } finally {
        if (mounted) setValidating(false)
      }
    }
    run()
    return () => { mounted = false }
  }, [scenario, lines, ayeId])

  // Escape-to-close.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, submitting])

  const totalFailures = inMemoryFailures.length + cascadeFailures.length
  const hardFailuresExist = totalFailures > 0
  const onlyWarnings =
    inMemoryFailures.length === 0 &&
    cascadeFailures.length > 0 &&
    cascadeFailures.every((f) => !f.is_required)

  // Submit affordance gating:
  // - clean pass (no failures): "Submit for Lock Review" enabled
  // - failures present + admin + override-mode + justification text:
  //     "Override and submit" enabled
  // - failures present + admin + NOT override-mode: show override
  //     toggle; submit disabled
  // - failures present + non-admin: submit disabled, no override option
  const canCleanSubmit = !hardFailuresExist
  const canOverrideSubmit =
    isAdmin && hardFailuresExist && overrideMode && justification.trim().length > 0

  async function handleConfirm() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (canCleanSubmit) {
        await onConfirm({ lockedVia: 'normal', overrideJustification: null })
      } else if (canOverrideSubmit) {
        await onConfirm({
          lockedVia: 'override',
          overrideJustification: justification.trim(),
        })
      }
    } catch (e) {
      setSubmitError(e.message || String(e))
      setSubmitting(false)
    }
    // On success the parent closes the modal; no need to reset submitting.
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
        aria-labelledby="submit-lock-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="submit-lock-title"
            className="font-display text-navy text-[18px] leading-tight"
          >
            Submit for Lock Review
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
          {validating ? (
            <p className="text-muted italic">Running validation…</p>
          ) : validationError ? (
            <p className="text-status-red text-sm" role="alert">
              {validationError}
            </p>
          ) : !hardFailuresExist ? (
            <CleanPassBody scenario={scenario} lines={lines} onlyWarnings={onlyWarnings} cascadeFailures={cascadeFailures} />
          ) : (
            <FailuresBody
              inMemoryFailures={inMemoryFailures}
              cascadeFailures={cascadeFailures}
              isAdmin={isAdmin}
              overrideMode={overrideMode}
              setOverrideMode={setOverrideMode}
              justification={justification}
              setJustification={setJustification}
            />
          )}

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
            disabled={submitting || (!canCleanSubmit && !canOverrideSubmit)}
            className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting
              ? 'Submitting…'
              : canCleanSubmit
                ? 'Submit for Lock Review'
                : 'Override and submit'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CleanPassBody({ scenario, lines, onlyWarnings, cascadeFailures }) {
  const nonZeroCount = lines.filter((l) => Number(l.amount) !== 0).length
  return (
    <>
      <p className="text-body text-sm mb-3 leading-relaxed">
        All validation checks passed. Submitting will move{' '}
        <strong className="font-medium">{scenario.scenario_label}</strong> to{' '}
        <strong className="font-medium">PENDING LOCK REVIEW</strong>. From
        there, an approver can lock it (creating an immutable snapshot)
        or reject it back to drafting.
      </p>
      <ul className="space-y-1 text-sm text-muted">
        <li>✓ Scenario is marked as recommended.</li>
        <li>✓ {nonZeroCount} line{nonZeroCount === 1 ? '' : 's'} have non-zero amounts.</li>
      </ul>
      {onlyWarnings && cascadeFailures.length > 0 && (
        <div className="mt-4 px-3 py-2 bg-status-amber-bg border-[0.5px] border-status-amber/30 rounded">
          <p className="text-status-amber text-sm font-medium mb-1">
            Cascade warnings (non-blocking):
          </p>
          <ul className="text-status-amber text-sm list-disc pl-5 space-y-0.5">
            {cascadeFailures.map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function FailuresBody({
  inMemoryFailures, cascadeFailures, isAdmin,
  overrideMode, setOverrideMode, justification, setJustification,
}) {
  return (
    <>
      <p className="text-body text-sm mb-3 leading-relaxed">
        Validation found{' '}
        {inMemoryFailures.length + cascadeFailures.length} issue
        {(inMemoryFailures.length + cascadeFailures.length) === 1 ? '' : 's'} that
        normally block submission:
      </p>

      {inMemoryFailures.length > 0 && (
        <div className="mb-3 px-3 py-2 bg-status-red-bg border-[0.5px] border-status-red/25 rounded">
          <ul className="text-status-red text-sm list-disc pl-5 space-y-0.5">
            {inMemoryFailures.map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
        </div>
      )}

      {cascadeFailures.length > 0 && (
        <div className="mb-3 px-3 py-2 bg-status-amber-bg border-[0.5px] border-status-amber/30 rounded">
          <p className="text-status-amber text-sm font-medium mb-1">
            Cascade rules:
          </p>
          <ul className="text-status-amber text-sm list-disc pl-5 space-y-0.5">
            {cascadeFailures.map((f, i) => (
              <li key={i}>
                {f.message}
                {!f.is_required && (
                  <span className="italic text-muted"> (warning only)</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!isAdmin ? (
        <p className="text-muted italic text-sm">
          You can't override these checks. Resolve them and try again, or
          ask a system admin to submit with override.
        </p>
      ) : (
        <div className="mt-4 pt-4 border-t-[0.5px] border-card-border">
          <label className="flex items-start gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={overrideMode}
              onChange={(e) => setOverrideMode(e.target.checked)}
              className="accent-navy mt-0.5"
            />
            <span>
              <span className="font-medium text-body">
                Override these checks and submit anyway
              </span>
              <span className="block text-muted italic text-xs leading-snug mt-0.5">
                Override is logged with your justification (required)
                and surfaces in the audit history. Use sparingly.
              </span>
            </span>
          </label>

          {overrideMode && (
            <div className="mt-3">
              <label
                htmlFor="override-justification"
                className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5"
              >
                Justification (required)
              </label>
              <textarea
                id="override-justification"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                rows={3}
                placeholder="e.g. Tuition Worksheet not yet available in the platform; locking with current scenario data."
                className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none"
                required
              />
            </div>
          )}
        </div>
      )}
    </>
  )
}

export default SubmitLockModal
