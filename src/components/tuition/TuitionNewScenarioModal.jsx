import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { defaultTierRates, defaultFamilyDistribution } from '../../lib/tuitionDefaults'

// "+ New scenario" modal for the Tuition module.
//
// Tuition's bootstrap surface is narrower than Budget's. Per the
// v3.8.2 commit-message note, bootstrap-from-prior is deferred and
// CSV import is permanently skipped. That leaves two paths:
//
//   - Start fresh (default; uses tuitionDefaults seed)
//   - Copy from current scenario (small-diff alternates — same tier
//     rates, fees, envelopes; user adjusts what differs)
//
// The "copy from current" path is offered only when an active scenario
// exists (i.e., when this modal is opened from the "+ New scenario"
// affordance on the tab strip rather than the empty-state path).
//
// Props:
//   ayeId             uuid       — the AYE the new scenario belongs to
//   stageId           uuid       — the workflow stage the new scenario
//                                  belongs to (each (AYE, Stage) has its
//                                  own scenario set)
//   ayeLabel          string     — display label for the AYE
//   stageDisplayName  string     — e.g., "Tuition Planning"; read from
//                                  module_workflow_stages.display_name
//   currentScenario   { id, scenario_label, ...config } | null
//                                  When non-null, "Copy from current" is
//                                  offered as a path. The modal copies
//                                  ALL configuration fields by reading
//                                  them from this object (the parent
//                                  must pass the full row).
//   userId            uuid       — for created_by / updated_by audit
//   onClose           ()         — () => void
//   onCreated(id)                — (newScenarioId) => void; parent
//                                   re-fetches and switches to the
//                                   new tab

function TuitionNewScenarioModal({
  ayeId,
  stageId,
  ayeLabel,
  stageDisplayName,
  currentScenario,
  userId,
  onClose,
  onCreated,
}) {
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  // Default: copy from current when available, else start fresh.
  const [path, setPath] = useState(currentScenario ? 'copy_current' : 'fresh')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const labelRef = useRef(null)
  useEffect(() => {
    labelRef.current?.focus()
  }, [])

  // Escape closes (consistent with other modals).
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, submitting])

  async function handleConfirm() {
    setSubmitting(true)
    setError(null)

    const trimmedLabel = label.trim()
    const trimmedDescription = description.trim() || null

    try {
      const isCopy = path === 'copy_current' && currentScenario
      const insert = {
        aye_id: ayeId,
        stage_id: stageId,
        scenario_label: trimmedLabel || null,  // null → DB rejects; we validate below
        description: trimmedDescription,
        is_recommended: false,                  // never auto-recommend a sibling scenario
        state: 'drafting',
        created_by: userId ?? null,
        updated_by: userId ?? null,
        // Configuration: copy from current OR seed fresh defaults.
        // v3.8.2 (B1.1) renames + new fields.
        tier_count:                          isCopy ? currentScenario.tier_count                          : 4,
        tier_rates:                          isCopy ? currentScenario.tier_rates                          : defaultTierRates(),
        faculty_discount_pct:                isCopy ? currentScenario.faculty_discount_pct                : 50.00,
        projected_faculty_discount_amount:   isCopy ? currentScenario.projected_faculty_discount_amount   : 0,
        projected_other_discount:            isCopy ? currentScenario.projected_other_discount            : 0,
        projected_financial_aid:             isCopy ? currentScenario.projected_financial_aid             : 0,
        curriculum_fee_per_student:          isCopy ? currentScenario.curriculum_fee_per_student          : 0,
        enrollment_fee_per_student:          isCopy ? currentScenario.enrollment_fee_per_student          : 0,
        before_after_school_hourly_rate:     isCopy ? currentScenario.before_after_school_hourly_rate     : 0,
        estimated_family_distribution:       isCopy ? currentScenario.estimated_family_distribution       : defaultFamilyDistribution(),
        total_students:                      isCopy ? currentScenario.total_students                      : null,
        total_families:                      isCopy ? currentScenario.total_families                      : null,
        top_tier_avg_students_per_family:    isCopy ? currentScenario.top_tier_avg_students_per_family    : null,
        // v3.8.3 (B1.2): two new columns. Copy carries source's
        // at-save values forward; fresh starts at null. Either way,
        // any subsequent edit on the new scenario goes through
        // persistFields which recomputes projected_multi_student_
        // discount against the post-edit state.
        projected_b_a_hours:                 isCopy ? currentScenario.projected_b_a_hours                 : null,
        projected_multi_student_discount:    isCopy ? currentScenario.projected_multi_student_discount    : null,
      }

      if (!insert.scenario_label) {
        // Auto-name: Scenario N where N is one greater than the
        // current sibling count. Best-effort — we read siblings via
        // a quick count query rather than coordinating with the
        // parent's already-loaded list, since this modal was opened
        // before any reload.
        const { count } = await supabase
          .from('tuition_worksheet_scenarios')
          .select('id', { count: 'exact', head: true })
          .eq('aye_id', ayeId)
          .eq('stage_id', stageId)
        const next = (count ?? 0) + 1
        insert.scenario_label = `Scenario ${next}`
      }

      const { data, error: insertErr } = await supabase
        .from('tuition_worksheet_scenarios')
        .insert(insert)
        .select('id')
        .single()
      if (insertErr) throw insertErr
      onCreated(data.id)
    } catch (e) {
      setError(e.message || String(e))
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
        aria-labelledby="new-tuition-scenario-title"
      >
        <h3
          id="new-tuition-scenario-title"
          className="font-display text-navy text-[20px] mb-1 leading-tight"
        >
          New scenario
        </h3>
        <p className="font-body italic text-muted text-sm mb-5">
          Adds a new scenario to {ayeLabel ? `${ayeLabel} ${stageDisplayName || 'Tuition'}` : (stageDisplayName || 'this stage')}.
          You can rename it later.
        </p>

        {error && (
          <p className="text-status-red text-sm mb-3" role="alert">
            {error}
          </p>
        )}

        <div className="space-y-4">
          <div>
            <label
              htmlFor="new-tuition-scenario-label"
              className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5"
            >
              Label
            </label>
            <input
              ref={labelRef}
              id="new-tuition-scenario-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. With HS, At $11,500"
              className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none"
            />
            <p className="font-body italic text-muted text-xs mt-1">
              Leave blank to auto-name (Scenario 2, Scenario 3, …).
            </p>
          </div>

          <div>
            <label
              htmlFor="new-tuition-scenario-description"
              className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5"
            >
              Description (optional)
            </label>
            <textarea
              id="new-tuition-scenario-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="One-line context for the Tuition Committee"
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
                  name="new-tuition-scenario-path"
                  value="copy_current"
                  checked={path === 'copy_current'}
                  onChange={setPath}
                  label={`Copy from current scenario (${currentScenario.scenario_label})`}
                  hint="Best for small-diff alternates — same tier rates, fees, envelopes; you adjust what differs."
                />
              )}
              <PathRadio
                name="new-tuition-scenario-path"
                value="fresh"
                checked={path === 'fresh'}
                onChange={setPath}
                label="Start fresh"
                hint="Four tier rows seeded at $0, faculty 50%, envelopes / fees zeroed, four projected-family rows zeroed."
              />
            </div>
          </div>
        </div>

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

export default TuitionNewScenarioModal
