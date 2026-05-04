import { useEffect, useState } from 'react'
import { validateScenarioForLock } from '../../lib/tuitionWorksheet'

// Pre-flight modal for submitting a Tuition scenario for lock review.
//
// Mirrors src/components/budget/SubmitLockModal.jsx in shape — runs
// validateScenarioForLock and either confirms a clean submit or
// surfaces failures with an admin-only override path.
//
// Tuition has no cascade-rules check at submit time. Per architecture
// §7.5, Tuition Stage 1 is the upstream module in the cascade chain
// — it gates Preliminary Budget locks, but nothing gates a Tuition
// Stage 1 lock. (Stage 2 is gated by Stage 1 being locked, but that's
// enforced at the Stage 2 setup gateway, not at lock time.) So the
// failures list is purely the in-memory checks from
// validateScenarioForLock.
//
// Override path: when a non-hardBlock failure exists and the user
// holds tuition.admin, an "Override and submit" checkbox appears with
// a required justification textarea. Hard-block failures (sibling
// locked) hide the override path entirely — the DB trigger would
// refuse the transition even with admin set.
//
// Props:
//   scenario        — active scenario object
//   isAdmin         — boolean; gates override option (caller passes
//                     useModulePermission('tuition', 'admin') result)
//   lockedSibling   — sibling locked scenario or null (from
//                     findLockedSibling); needed for the hardBlock
//                     failure
//   onCancel        — () => void
//   onConfirm       — async ({lockedVia, overrideJustification}) =>
//                     void; parent calls submitTuitionScenarioFor
//                     LockReview RPC and refreshes
export default function SubmitForLockReviewModal({
  scenario,
  isAdmin,
  lockedSibling,
  onCancel,
  onConfirm,
}) {
  const [validating, setValidating] = useState(true)
  const [failures, setFailures] = useState([])
  const [validationError, setValidationError] = useState(null)

  const [overrideMode, setOverrideMode] = useState(false)
  const [justification, setJustification] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    let mounted = true
    setValidating(true)
    setValidationError(null)
    try {
      const f = validateScenarioForLock(scenario, lockedSibling)
      if (mounted) setFailures(f)
    } catch (e) {
      if (mounted) setValidationError(e.message || String(e))
    } finally {
      if (mounted) setValidating(false)
    }
    return () => { mounted = false }
  }, [scenario, lockedSibling])

  // Escape-to-close.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, submitting])

  const hardFailuresExist = failures.length > 0
  const hasHardBlock = failures.some((f) => f.hardBlock)

  // Submit affordance gating (parallel to SubmitLockModal):
  // - clean pass: "Submit for Lock Review" enabled
  // - failures + admin + override-mode + justification text:
  //     "Override and submit" enabled (UNLESS hardBlock present)
  // - failures + admin + NOT override-mode: show toggle; submit disabled
  // - hard-block: no override option; submit permanently disabled
  // - failures + non-admin: submit disabled, no override option
  const canCleanSubmit = !hardFailuresExist
  const canOverrideSubmit =
    !hasHardBlock &&
    isAdmin && hardFailuresExist && overrideMode && justification.trim().length > 0

  async function handleConfirm() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (canCleanSubmit) {
        // 'cascade' is the normal Tuition lock path (architecture
        // §7.5 + Migration 024). Tuition has no upstream cascade
        // requirements today, so 'cascade' here is "no override
        // needed" — analogous to Budget's 'normal'.
        await onConfirm({ lockedVia: 'cascade', overrideJustification: null })
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
        aria-labelledby="tuition-submit-lock-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="tuition-submit-lock-title"
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
            <CleanPassBody scenario={scenario} />
          ) : (
            <FailuresBody
              failures={failures}
              isAdmin={isAdmin}
              hasHardBlock={hasHardBlock}
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
            title={
              hasHardBlock
                ? 'A sibling scenario in this (AYE, stage) is locked. Unlock it before submitting this scenario for lock review.'
                : undefined
            }
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

function CleanPassBody({ scenario }) {
  return (
    <>
      <p className="text-body text-sm mb-3 leading-relaxed">
        All validation checks passed. Submitting will move{' '}
        <strong className="font-medium">{scenario.scenario_label}</strong> to{' '}
        <strong className="font-medium">PENDING LOCK REVIEW</strong>. From
        there, an approver can lock it (creating an immutable snapshot
        and tuition schedule for families) or reject it back to drafting.
      </p>
      <ul className="space-y-1 text-sm text-muted">
        <li>✓ Scenario is marked as recommended.</li>
        <li>✓ No sibling scenario is currently locked.</li>
        <li>✓ Tuition inputs are not all zero.</li>
      </ul>
    </>
  )
}

function FailuresBody({
  failures, isAdmin, hasHardBlock,
  overrideMode, setOverrideMode, justification, setJustification,
}) {
  return (
    <>
      <p className="text-body text-sm mb-3 leading-relaxed">
        Validation found{' '}
        {failures.length} issue
        {failures.length === 1 ? '' : 's'} that
        normally block submission:
      </p>

      <div className="mb-3 px-3 py-2 bg-status-red-bg border-[0.5px] border-status-red/25 rounded">
        <ul className="text-status-red text-sm list-disc pl-5 space-y-0.5">
          {failures.map((f, i) => (
            <li key={i}>{f.message}</li>
          ))}
        </ul>
      </div>

      {hasHardBlock ? (
        <p className="text-muted italic text-sm">
          These checks cannot be overridden — they are enforced at the
          database layer. Resolve the upstream condition (e.g. unlock
          the sibling scenario) before submitting for lock review.
        </p>
      ) : !isAdmin ? (
        <p className="text-muted italic text-sm">
          You cannot override these checks. Resolve them and try again, or
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
                htmlFor="tuition-override-justification"
                className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5"
              >
                Justification (required)
              </label>
              <textarea
                id="tuition-override-justification"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                rows={3}
                placeholder="e.g. Tuition Committee approved this scenario verbally; documented in March meeting minutes."
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
