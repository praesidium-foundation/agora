import { useEffect, useRef, useState } from 'react'

// Lightweight modal for renaming a scenario or editing its description.
// One mode per invocation — the parent passes `field` to indicate
// which is being edited; the other field stays read-only.
//
// Splitting rename from edit-description into separate kebab actions
// (per the build spec) lets the modal focus the right field on open
// and present a clean single-purpose UX.
//
// Props:
//   scenario   — { id, scenario_label, description }
//   field      — 'label' | 'description'
//   onClose    — () => void
//   onSave     — async ({ label, description }) => void; parent owns
//                the supabase update + state refresh

function ScenarioSettingsModal({ scenario, field, onClose, onSave }) {
  const [label, setLabel] = useState(scenario.scenario_label || '')
  const [description, setDescription] = useState(scenario.description || '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const focusRef = useRef(null)
  useEffect(() => {
    focusRef.current?.focus()
    focusRef.current?.select?.()
  }, [field])

  async function handleSave() {
    if (field === 'label' && !label.trim()) {
      setError('Label is required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSave({
        label: label.trim(),
        description: description.trim() || null,
      })
    } catch (e) {
      setError(e.message || String(e))
      setSubmitting(false)
    }
    // On success, parent calls onClose; no need to flip submitting back.
  }

  const isLabelMode = field === 'label'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
      onClick={() => !submitting && onClose()}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-md w-full p-6 shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scenario-settings-title"
      >
        <h3
          id="scenario-settings-title"
          className="font-display text-navy text-[18px] mb-4 leading-tight"
        >
          {isLabelMode ? 'Rename scenario' : 'Edit description'}
        </h3>

        {error && (
          <p className="text-status-red text-sm mb-3" role="alert">
            {error}
          </p>
        )}

        {isLabelMode ? (
          <div>
            <label
              htmlFor="scenario-label"
              className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5"
            >
              Label
            </label>
            <input
              ref={focusRef}
              id="scenario-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave()
              }}
              className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none"
            />
          </div>
        ) : (
          <div>
            <label
              htmlFor="scenario-description"
              className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5"
            >
              Description (optional)
            </label>
            <textarea
              ref={focusRef}
              id="scenario-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="One-line context for the board"
              className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none"
            />
          </div>
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
            onClick={handleSave}
            disabled={submitting}
            className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ScenarioSettingsModal
