import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import AccountForm from './AccountForm'

// Modal wrapper around AccountForm for COA management's Add / Edit /
// "+ Subaccount" entry paths. Mirrors the Budget module's
// AddAccountModal — same form component, same modal frame conventions
// (backdrop, Escape close, X button, click-outside-to-close).
//
// Pattern: actions on list rows that require a form open a modal,
// not an inline expand. Inline expand pulls the user away from their
// scroll position; modals anchor focus where the user is already
// looking. (See architecture Section 10.)
//
// Props:
//   accounts          — full COA list (parent dropdown + depth display)
//   mode              — 'add' | 'edit'
//   account           — row being edited (mode='edit') or null
//   initialParentId   — preselect this parent (mode='add')
//   parentLocked      — true when the parent is implied by context
//                        ("+ Subaccount" path); the dropdown renders
//                        disabled with a context line
//   userId            — for created_by / updated_by audit
//   onClose           — () => void; close without save
//   onSuccess(account, mode) — fired after a successful save; parent
//                              reloads + shows toast
//   translateError    — optional formatter for trigger error messages
//                        (matches CoaManagement's translateError)

function CoaAccountModal({
  accounts,
  mode,
  account,
  initialParentId,
  parentLocked = false,
  userId,
  onClose,
  onSuccess,
  translateError = (m) => m,
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Escape-to-close. Modal frame also handles backdrop click and X
  // button below; this keyboard listener covers the third path.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, submitting])

  async function handleSubmit(values) {
    setSubmitting(true)
    setError(null)

    let result
    if (mode === 'add') {
      result = await supabase
        .from('chart_of_accounts')
        .insert({ ...values, created_by: userId, updated_by: userId })
        .select()
        .single()
    } else {
      result = await supabase
        .from('chart_of_accounts')
        .update({ ...values, updated_by: userId })
        .eq('id', account.id)
        .select()
        .single()
    }

    setSubmitting(false)

    if (result.error) {
      setError(translateError(result.error.message))
      return
    }

    onSuccess(result.data, mode)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
      onClick={() => !submitting && onClose()}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-2xl w-full p-0 shadow-lg max-h-[90vh] overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="coa-account-modal-title"
      >
        {/* Modal header: title + X close. The X is its own affordance
            so users who don't reach for Escape or click the backdrop
            still have an obvious close target. */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="coa-account-modal-title"
            className="font-display text-navy text-[18px] leading-tight"
          >
            {mode === 'edit'
              ? `Edit ${account?.name || 'account'}`
              : parentLocked
                ? 'Add subaccount'
                : 'Add account'}
          </h3>
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
            aria-label="Close"
            className="text-muted hover:text-navy text-[18px] leading-none disabled:opacity-30"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto">
          <AccountForm
            accounts={accounts}
            mode={mode}
            account={account}
            initialParentId={initialParentId}
            parentLocked={parentLocked}
            onSubmit={handleSubmit}
            onCancel={onClose}
            error={error}
            submitting={submitting}
          />
        </div>
      </div>
    </div>
  )
}

export default CoaAccountModal
