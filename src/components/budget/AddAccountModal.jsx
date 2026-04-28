import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import AccountForm from '../coa/AccountForm'

// Inline-add-account flow for the Preliminary Budget (Pattern 1).
//
// Renders the full COA AccountForm in a modal. On save:
//
//   - Inserts the account into chart_of_accounts
//   - If the new account is posting AND not pass-thru → also inserts a
//     preliminary_budget_lines row at amount=0 in the active scenario
//   - Summary or pass-thru → COA insert only; UI surfaces a friendly
//     success message explaining why no budget line was created
//
// Permission gating: parent only renders this modal when the user has
// edit permission on BOTH chart_of_accounts and preliminary_budget. The
// modal itself trusts that and doesn't re-check.
//
// Props:
//   accounts     — full COA list (for parent dropdown)
//   scenarioId   — active scenario the new line attaches to
//   userId       — for created_by / updated_by audit
//   onClose      — () => void; called for both success and cancel
//   onSuccess    — (message) => void; parent surfaces toast + reloads

function AddAccountModal({ accounts, scenarioId, userId, onClose, onSuccess }) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(values) {
    setSubmitting(true)
    setError(null)

    // 1. Insert into chart_of_accounts.
    const { data: created, error: coaError } = await supabase
      .from('chart_of_accounts')
      .insert({ ...values, created_by: userId, updated_by: userId })
      .select('id, name, posts_directly, is_pass_thru')
      .single()
    if (coaError) {
      setError(coaError.message)
      setSubmitting(false)
      return
    }

    // 2. Decide whether this account belongs in the active budget.
    if (!created.posts_directly) {
      setSubmitting(false)
      onSuccess(
        `Summary account "${created.name}" created in Chart of Accounts. Add posting subaccounts to it to budget.`
      )
      onClose()
      return
    }
    if (created.is_pass_thru) {
      setSubmitting(false)
      onSuccess(
        `Pass-thru account "${created.name}" created in Chart of Accounts. Pass-thru accounts are excluded from operating budgets.`
      )
      onClose()
      return
    }

    // 3. Posting non-pass-thru → add a $0 line to the active scenario.
    const { error: lineError } = await supabase
      .from('preliminary_budget_lines')
      .insert({
        scenario_id: scenarioId,
        account_id: created.id,
        amount: 0,
        source_type: 'manual',
        created_by: userId,
        updated_by: userId,
      })

    setSubmitting(false)

    if (lineError) {
      // The COA row landed but the budget line didn't. Surface as a
      // partial-success error so the user knows the COA is correct but
      // they need to manually add the budget line via auto-detect.
      setError(
        `Account "${created.name}" created in Chart of Accounts, but adding it to the budget failed: ${lineError.message}`
      )
      return
    }

    onSuccess(
      `${created.name} added to Chart of Accounts and to the current budget at $0.`
    )
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
      onClick={() => !submitting && onClose()}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-2xl w-full p-6 shadow-lg max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="budget-add-account-title"
      >
        <h3
          id="budget-add-account-title"
          className="font-display text-navy text-[20px] mb-4 leading-tight"
        >
          Add account to Chart of Accounts
        </h3>

        <AccountForm
          accounts={accounts}
          mode="add"
          account={null}
          initialParentId={null}
          onSubmit={handleSubmit}
          onCancel={onClose}
          error={error}
          submitting={submitting}
        />
      </div>
    </div>
  )
}

export default AddAccountModal
