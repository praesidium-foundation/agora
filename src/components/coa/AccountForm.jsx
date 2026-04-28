import { useEffect, useMemo, useState } from 'react'
import Card from '../Card'
import FieldLabel from '../FieldLabel'

// Add / edit form for a Chart of Accounts row.
//
// Extracted from CoaManagement so the Preliminary Budget module's
// inline-add-account flow (Pattern 1) can render the same form. The two
// callers differ only in what they do with the saved account afterward.
//
// Props:
//   accounts            — full COA list, used for the "subaccount of"
//                          dropdown options and depth display
//   mode                — 'add' | 'edit'
//   account             — the account being edited (mode='edit') or null
//   initialParentId     — preselect this parent in the dropdown (mode='add')
//   onSubmit(values)    — async; values shape matches the row insert
//   onCancel()
//   error               — string to surface above the buttons
//   submitting          — boolean; disables submit
//
// Notes:
//   - Vocabulary: "Subaccount of" not "Parent" (CLAUDE.md COA vocabulary).
//   - Flag enablement: ed_program / contribution only when type=income
//     and not pass_thru. Summary accounts hide the flags entirely.
//   - Cycle prevention: descendants of the editing account are filtered
//     from the parent dropdown (the trigger would catch a cycle anyway,
//     but the UI surface should never offer the option).

const inputCls =
  'w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none'

const navyBtnCls =
  'inline-block bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed'

// Set of ids that are descendants of the given account.
function getDescendantIds(accountId, accounts) {
  const result = new Set()
  const childrenOf = new Map()
  for (const a of accounts) {
    if (a.parent_id) {
      const list = childrenOf.get(a.parent_id) || []
      list.push(a.id)
      childrenOf.set(a.parent_id, list)
    }
  }
  function walk(id) {
    for (const k of childrenOf.get(id) || []) {
      if (!result.has(k)) {
        result.add(k)
        walk(k)
      }
    }
  }
  walk(accountId)
  return result
}

function AccountForm({ accounts, mode, account, initialParentId, onSubmit, onCancel, error, submitting }) {
  const isEdit = mode === 'edit'

  const initialParent = initialParentId ? accounts.find((a) => a.id === initialParentId) : null

  const [parentId, setParentId] = useState(
    isEdit ? (account?.parent_id ?? '') : (initialParentId ?? '')
  )
  const [accountType, setAccountType] = useState(
    isEdit
      ? account?.account_type
      : (initialParent ? initialParent.account_type : 'income')
  )
  const [postsDirectly, setPostsDirectly] = useState(
    isEdit ? (account?.posts_directly ?? true) : true
  )
  const [code, setCode] = useState(isEdit ? (account?.code ?? '') : '')
  const [name, setName] = useState(isEdit ? account?.name : '')
  const [sortOrder, setSortOrder] = useState(isEdit ? (account?.sort_order ?? 0) : 0)
  const [isPassThru, setIsPassThru] = useState(isEdit ? account?.is_pass_thru : false)
  const [isEdProgramDollars, setIsEdProgramDollars] = useState(isEdit ? account?.is_ed_program_dollars : false)
  const [isContribution, setIsContribution] = useState(isEdit ? account?.is_contribution : false)
  const [notes, setNotes] = useState(isEdit ? (account?.notes ?? '') : '')

  // Clear governance flags when the user toggles to summary so the UI state
  // matches what'll be persisted (the DB trigger would reject a flagged
  // summary account anyway).
  useEffect(() => {
    if (!postsDirectly) {
      setIsPassThru(false)
      setIsEdProgramDollars(false)
      setIsContribution(false)
    }
  }, [postsDirectly])

  // Parent dropdown options. Exclude self, descendants (cycle prevention),
  // and inactive accounts. Any active account — posting or summary — can be
  // a parent under the new model.
  const descendants = useMemo(() => {
    if (!isEdit || !account) return new Set()
    return getDescendantIds(account.id, accounts)
  }, [accounts, account, isEdit])

  const accountById = useMemo(() => {
    const m = new Map()
    for (const a of accounts) m.set(a.id, a)
    return m
  }, [accounts])

  function getDepth(a) {
    let depth = 0
    let cur = a
    while (cur?.parent_id && depth < 20) {
      cur = accountById.get(cur.parent_id)
      if (!cur) break
      depth += 1
    }
    return depth
  }

  const parentOptions = accounts.filter((a) => {
    if (isEdit && a.id === account?.id) return false
    if (descendants.has(a.id)) return false
    if (!a.is_active) return false
    return true
  })

  function handleParentChange(newParentId) {
    setParentId(newParentId)
    if (newParentId) {
      const parent = accountById.get(newParentId)
      if (parent) setAccountType(parent.account_type)
    }
  }

  // Type radio is editable only when no parent (top-level).
  const typeEditable = !parentId

  // Flag enablement (only relevant when posting; the section is hidden
  // entirely for summary accounts).
  const edProgramDisabled = accountType !== 'income' || isPassThru
  const contributionDisabled = accountType !== 'income' || isPassThru

  function handleSubmit(e) {
    e.preventDefault()
    onSubmit({
      parent_id: parentId || null,
      account_type: accountType,
      posts_directly: postsDirectly,
      code: code.trim() || null,
      name: name.trim(),
      sort_order: parseInt(sortOrder, 10) || 0,
      // Flags only set when posting; UI keeps them cleared via useEffect for summary.
      is_pass_thru: postsDirectly && isPassThru,
      is_ed_program_dollars: postsDirectly && isEdProgramDollars && !edProgramDisabled,
      is_contribution: postsDirectly && isContribution && !contributionDisabled,
      notes: notes.trim() || null,
    })
  }

  return (
    <Card title={isEdit ? `Edit ${account?.name || 'account'}` : 'Add account'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <FieldLabel htmlFor="coa-parent">Subaccount of</FieldLabel>
          <select
            id="coa-parent"
            value={parentId}
            onChange={(e) => handleParentChange(e.target.value)}
            className={inputCls}
          >
            <option value="">(none — top-level account)</option>
            {parentOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {'– '.repeat(getDepth(a))}{a.code ? `${a.code} · ` : ''}{a.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <FieldLabel>Account Type</FieldLabel>
          <div className="flex gap-6 text-sm">
            <label className={`flex items-center gap-2 ${typeEditable ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}>
              <input type="radio" name="coa-type" value="income" checked={accountType === 'income'} onChange={() => setAccountType('income')} disabled={!typeEditable} className="accent-navy" />
              Income
            </label>
            <label className={`flex items-center gap-2 ${typeEditable ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}>
              <input type="radio" name="coa-type" value="expense" checked={accountType === 'expense'} onChange={() => setAccountType('expense')} disabled={!typeEditable} className="accent-navy" />
              Expense
            </label>
          </div>
          {!typeEditable && (
            <p className="text-muted text-xs italic mt-1.5">
              Type is inherited from the primary account.
            </p>
          )}
        </div>

        <div>
          <FieldLabel>Account Kind</FieldLabel>
          <div className="space-y-1.5 text-sm">
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" name="coa-kind" checked={postsDirectly} onChange={() => setPostsDirectly(true)} className="accent-navy mt-0.5" />
              <span>
                <span className="font-medium text-body">Posting account</span>
                <span className="text-muted ml-2">— money posts here directly</span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="radio" name="coa-kind" checked={!postsDirectly} onChange={() => setPostsDirectly(false)} className="accent-navy mt-0.5" />
              <span>
                <span className="font-medium text-body">Summary account</span>
                <span className="text-muted ml-2">— rollup of subaccounts only</span>
              </span>
            </label>
          </div>
          <div className="text-muted text-xs italic mt-1.5 leading-relaxed space-y-1">
            <p>
              <strong className="font-medium not-italic">Posting</strong> — transactions post directly to this account (e.g., individual discount accounts, individual donation accounts).
            </p>
            <p>
              <strong className="font-medium not-italic">Summary</strong> — pure rollup; value comes from subaccounts (e.g., "Tuition Discounts" as a header that sums its subaccounts).
            </p>
            <p>
              A posting account can also have subaccounts — its rollup is its direct posts plus subaccount totals.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <FieldLabel htmlFor="coa-code">Code (optional)</FieldLabel>
            <input id="coa-code" type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. 4192" className={inputCls} />
          </div>
          <div className="md:col-span-2">
            <FieldLabel htmlFor="coa-name">Name</FieldLabel>
            <input id="coa-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} />
          </div>
        </div>

        <div>
          <FieldLabel htmlFor="coa-sort">Sort Order</FieldLabel>
          <input id="coa-sort" type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className={`${inputCls} max-w-[140px]`} />
        </div>

        {postsDirectly ? (
          <fieldset className="border-t-[0.5px] border-card-border pt-4 space-y-2.5">
            <legend className="font-body text-[11px] text-muted uppercase tracking-wider mb-2">
              Governance Flags
            </legend>

            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={isPassThru}
                onChange={(e) => setIsPassThru(e.target.checked)}
                className="accent-navy mt-0.5"
              />
              <span>
                <span className="font-medium text-body">Pass-Thru</span>
                <span className="text-muted ml-2">— excluded from operating budget totals</span>
              </span>
            </label>

            <label className={`flex items-start gap-2 text-sm ${edProgramDisabled ? 'opacity-50' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={isEdProgramDollars}
                onChange={(e) => setIsEdProgramDollars(e.target.checked)}
                disabled={edProgramDisabled}
                className="accent-navy mt-0.5"
              />
              <span>
                <span className="font-medium text-body">Ed Program Dollars</span>
                <span className="text-muted ml-2">— counts toward the Ed Program $ ratio</span>
                {accountType !== 'income' && (
                  <span className="block text-[11px] text-status-amber italic">Only applies to income accounts.</span>
                )}
                {accountType === 'income' && isPassThru && (
                  <span className="block text-[11px] text-status-amber italic">Not meaningful when Pass-Thru is checked.</span>
                )}
              </span>
            </label>

            <label className={`flex items-start gap-2 text-sm ${contributionDisabled ? 'opacity-50' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={isContribution}
                onChange={(e) => setIsContribution(e.target.checked)}
                disabled={contributionDisabled}
                className="accent-navy mt-0.5"
              />
              <span>
                <span className="font-medium text-body">Contribution</span>
                <span className="text-muted ml-2">— donor / fundraising income</span>
                {accountType !== 'income' && (
                  <span className="block text-[11px] text-status-amber italic">Only applies to income accounts.</span>
                )}
                {accountType === 'income' && isPassThru && (
                  <span className="block text-[11px] text-status-amber italic">Not meaningful when Pass-Thru is checked.</span>
                )}
              </span>
            </label>
          </fieldset>
        ) : (
          <div className="border-t-[0.5px] border-card-border pt-4">
            <p className="font-body text-[11px] text-muted uppercase tracking-wider mb-2">
              Governance Flags
            </p>
            <p className="text-muted text-sm italic">
              Governance flags apply to posting accounts only. Change Account Kind to Posting to set flags.
            </p>
          </div>
        )}

        <div>
          <FieldLabel htmlFor="coa-notes">Notes (optional)</FieldLabel>
          <textarea id="coa-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputCls} />
        </div>

        {error && (
          <p className="text-status-red text-sm" role="alert">{error}</p>
        )}

        <div className="flex items-center gap-4">
          <button type="submit" disabled={submitting} className={navyBtnCls}>
            {submitting ? (isEdit ? 'Saving…' : 'Adding…') : (isEdit ? 'Save changes' : 'Add account')}
          </button>
          <button type="button" onClick={onCancel} className="font-body text-muted hover:text-navy text-sm">
            Cancel
          </button>
        </div>
      </form>
    </Card>
  )
}

export default AccountForm
