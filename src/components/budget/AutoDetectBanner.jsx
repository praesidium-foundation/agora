import { useState } from 'react'
import Badge from '../Badge'

// "Accounts in your COA but not in this Budget" notification.
//
// Renders a slim banner at the top of the detail zone when the
// scenario is missing one or more posting non-pass-thru active
// accounts. Click "Review" → modal with a checklist (default all
// checked). Confirming inserts those accounts as new lines at $0
// (source_type = 'manual') in the active scenario.
//
// Dismiss persists for the session only — next page load the banner
// reappears as long as the gap exists, by design.
//
// Props:
//   missing   — array of account rows {id, code, name, account_type}
//   onAdd     — async (accountIds) => void; parent owns the actual insert
//   sessionDismiss — () => void; parent flips a session flag

function AutoDetectBanner({ missing, onAdd, sessionDismiss }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(() => new Set(missing.map((a) => a.id)))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  function toggleAll() {
    if (selected.size === missing.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(missing.map((a) => a.id)))
    }
  }

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleConfirm() {
    if (selected.size === 0) return
    setSubmitting(true)
    setError(null)
    try {
      await onAdd([...selected])
      setOpen(false)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div
        className="mb-4 px-4 py-2.5 bg-status-blue-bg border-[0.5px] border-status-blue/25 rounded flex items-center justify-between gap-3"
        role="status"
      >
        <p className="font-body text-status-blue text-sm">
          <strong>{missing.length}</strong> new account
          {missing.length === 1 ? '' : 's'} available in your Chart of
          Accounts but not in this Budget.
        </p>
        <div className="flex items-center gap-3 flex-shrink-0">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="font-body text-status-blue text-sm hover:underline"
          >
            Review
          </button>
          <button
            type="button"
            onClick={sessionDismiss}
            aria-label="Dismiss for this session"
            className="font-body text-status-blue/60 hover:text-status-blue text-[14px] leading-none"
          >
            ×
          </button>
        </div>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
          onClick={() => !submitting && setOpen(false)}
          role="presentation"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white border-[0.5px] border-card-border rounded-[10px] max-w-lg w-full p-6 shadow-lg"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auto-detect-title"
          >
            <h3
              id="auto-detect-title"
              className="font-display text-navy text-[18px] mb-2 leading-tight"
            >
              Accounts in your Chart of Accounts but not in this Budget
            </h3>
            <p className="font-body text-muted text-sm mb-3 leading-relaxed">
              These accounts will be added at $0 to the current scenario.
              Uncheck any you don't want to include.
            </p>

            <div className="mb-3 flex items-center justify-between">
              <button
                type="button"
                onClick={toggleAll}
                className="font-body text-status-blue text-sm hover:underline"
              >
                {selected.size === missing.length ? 'Deselect all' : 'Select all'}
              </button>
              <span className="font-body text-muted text-xs">
                {selected.size} of {missing.length} selected
              </span>
            </div>

            <ul className="border-[0.5px] border-card-border rounded-[8px] divide-y-[0.5px] divide-card-border max-h-72 overflow-y-auto">
              {missing.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-cream-highlight/50"
                >
                  <input
                    type="checkbox"
                    id={`auto-${a.id}`}
                    checked={selected.has(a.id)}
                    onChange={() => toggleOne(a.id)}
                    className="accent-navy"
                  />
                  <label
                    htmlFor={`auto-${a.id}`}
                    className="flex-1 font-body text-sm cursor-pointer flex items-center gap-2"
                  >
                    {a.code && (
                      <span className="text-muted tabular-nums text-[12px] w-12">
                        {a.code}
                      </span>
                    )}
                    <span className="text-body">{a.name}</span>
                  </label>
                  <Badge variant={a.account_type === 'income' ? 'navy' : 'amber'}>
                    {a.account_type === 'income' ? 'Income' : 'Expense'}
                  </Badge>
                </li>
              ))}
            </ul>

            {error && (
              <p className="text-status-red text-sm mt-3" role="alert">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-4 pt-4 mt-4 border-t-[0.5px] border-card-border">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={submitting}
                className="font-body text-muted hover:text-navy text-sm disabled:opacity-30"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={submitting || selected.size === 0}
                className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Adding…' : `Add ${selected.size} to Budget`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default AutoDetectBanner
