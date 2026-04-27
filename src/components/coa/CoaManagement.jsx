import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import Card from '../Card'
import Badge from '../Badge'
import SectionLabel from '../SectionLabel'
import FieldLabel from '../FieldLabel'

const inputCls =
  'w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none'

const navyBtnCls =
  'inline-block bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed'

// ---- Pure helpers --------------------------------------------------------

// Build a tree of nodes (each with .children) from a flat account list.
function buildTree(accounts) {
  const map = new Map()
  for (const a of accounts) map.set(a.id, { ...a, children: [] })

  const roots = []
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id).children.push(node)
    } else {
      roots.push(node)
    }
  }

  function sortNodes(nodes) {
    nodes.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
      const ac = a.code || ''
      const bc = b.code || ''
      if (ac && bc && ac !== bc) return ac.localeCompare(bc)
      return a.name.localeCompare(b.name)
    })
    nodes.forEach((n) => sortNodes(n.children))
  }
  sortNodes(roots)
  return roots
}

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

// ---- Small visual helpers -------------------------------------------------

function FlagPill({ label }) {
  return (
    <span className="inline-block bg-cream-highlight text-muted px-1.5 py-0.5 rounded text-[10px] tracking-wide">
      {label}
    </span>
  )
}

function FlagDisplay({ account }) {
  // Flags are only ever true on posting accounts (DB-enforced), so no
  // posting/summary check needed here — just show whichever are true.
  return (
    <span className="space-x-1">
      {account.is_pass_thru && <FlagPill label="PASS-THRU" />}
      {account.is_ed_program_dollars && <FlagPill label="ED $" />}
      {account.is_contribution && <FlagPill label="CONTRIB" />}
    </span>
  )
}

// "summary" tag rendered inline after a summary account's name in the tree,
// preceded by a middot separator. Italic muted text reads as descriptive
// metadata — kind, not status — so no colored badge.
function SummaryIndicator() {
  return (
    <>
      <span className="text-muted/60 text-[13px]" aria-hidden="true">·</span>
      <span className="text-[12px] text-muted italic">summary</span>
    </>
  )
}

// ---- Tree view -----------------------------------------------------------

function TreeNode({ node, depth, expanded, onToggle, onAdd, onEdit, onDeactivate, onReactivate, canEdit, canApprove }) {
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.id)

  return (
    <>
      <div
        className={`flex items-center gap-2 py-2 pr-3 border-b-[0.5px] border-card-border hover:bg-cream-highlight ${!node.is_active ? 'opacity-50' : ''}`}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        <button
          type="button"
          onClick={() => hasChildren && onToggle(node.id)}
          className={`w-4 text-muted ${!hasChildren ? 'invisible' : ''}`}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
        >
          {isOpen ? '▾' : '▸'}
        </button>

        {node.code ? (
          <span className="font-body text-[12px] text-muted tabular-nums w-12 flex-shrink-0">
            {node.code}
          </span>
        ) : (
          <span className="w-12 flex-shrink-0" />
        )}

        <span className="font-body text-body flex-1 min-w-0 truncate">{node.name}</span>

        {!node.posts_directly && <SummaryIndicator />}

        <FlagDisplay account={node} />

        <Badge variant={node.account_type === 'income' ? 'navy' : 'amber'}>
          {node.account_type === 'income' ? 'Income' : 'Expense'}
        </Badge>

        {!node.is_active && <Badge variant="red">Inactive</Badge>}

        <div className="flex gap-3 text-[12px] flex-shrink-0">
          {canEdit && node.is_active && (
            <>
              <button onClick={() => onAdd(node.id)} className="text-status-blue hover:underline">+ Child</button>
              <button onClick={() => onEdit(node)} className="text-status-blue hover:underline">Edit</button>
            </>
          )}
          {canEdit && !node.is_active && (
            <button onClick={() => onEdit(node)} className="text-status-blue hover:underline">Edit</button>
          )}
          {canApprove && (
            node.is_active ? (
              <button onClick={() => onDeactivate(node)} className="text-status-red hover:underline">Deactivate</button>
            ) : (
              <button onClick={() => onReactivate(node)} className="text-status-blue hover:underline">Reactivate</button>
            )
          )}
        </div>
      </div>

      {isOpen && hasChildren && node.children.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          onAdd={onAdd}
          onEdit={onEdit}
          onDeactivate={onDeactivate}
          onReactivate={onReactivate}
          canEdit={canEdit}
          canApprove={canApprove}
        />
      ))}
    </>
  )
}

// Collect ids of every node that has children — i.e. every node whose
// expand/collapse state is meaningful. Used for "expand all" + initial state.
function collectAllParentIds(nodes) {
  const ids = new Set()
  function walk(n) {
    if (n.children.length > 0) {
      ids.add(n.id)
      n.children.forEach(walk)
    }
  }
  nodes.forEach(walk)
  return ids
}

function TreeView({ tree, ...handlers }) {
  const [expanded, setExpanded] = useState(() => new Set())
  const [initialized, setInitialized] = useState(false)

  // On first non-empty tree (per mount), expand every parent so the whole
  // chart is visible. After that, user toggles control the state — adding a
  // new account doesn't auto-re-expand things the user explicitly collapsed.
  // Switching tabs or navigating away unmounts TreeView; coming back resets
  // initialized so the tree reopens fully expanded.
  useEffect(() => {
    if (!initialized && tree.length > 0) {
      setExpanded(collectAllParentIds(tree))
      setInitialized(true)
    }
  }, [tree, initialized])

  function toggle(id) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function expandAll() {
    setExpanded(collectAllParentIds(tree))
  }

  function collapseAll() {
    setExpanded(new Set())
  }

  if (tree.length === 0) {
    return (
      <Card>
        <p className="font-body italic text-muted text-sm py-4 text-center">
          No accounts yet. Add the first account to get started.
        </p>
      </Card>
    )
  }

  return (
    <>
      <div className="flex items-center justify-end mb-2 gap-3 text-[12px]">
        <button
          type="button"
          onClick={expandAll}
          className="text-status-blue hover:underline"
        >
          Expand all
        </button>
        <span className="text-muted/40">|</span>
        <button
          type="button"
          onClick={collapseAll}
          className="text-status-blue hover:underline"
        >
          Collapse all
        </button>
      </div>
      <Card className="!p-0 overflow-hidden">
        <div>
          {tree.map((node) => (
            <TreeNode key={node.id} node={node} depth={0} expanded={expanded} onToggle={toggle} {...handlers} />
          ))}
        </div>
      </Card>
    </>
  )
}

// ---- Flat view -----------------------------------------------------------

function FlatTable({ accounts, parentNameById, onAdd, onEdit, onDeactivate, onReactivate, canEdit, canApprove }) {
  const [sortBy, setSortBy] = useState('name')
  const [sortDir, setSortDir] = useState('asc')

  const sorted = useMemo(() => {
    const list = [...accounts]
    list.sort((a, b) => {
      const av = a[sortBy] ?? ''
      const bv = b[sortBy] ?? ''
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
      return sortDir === 'asc' ? cmp : -cmp
    })
    return list
  }, [accounts, sortBy, sortDir])

  function setSort(col) {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(col)
      setSortDir('asc')
    }
  }

  function SortableHeader({ col, label }) {
    const active = sortBy === col
    return (
      <th
        className="px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80 cursor-pointer select-none"
        onClick={() => setSort(col)}
      >
        {label}
        {active && (sortDir === 'asc' ? ' ↑' : ' ↓')}
      </th>
    )
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <p className="font-body italic text-muted text-sm py-4 text-center">
          No accounts yet.
        </p>
      </Card>
    )
  }

  return (
    <Card className="!p-0 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-cream-highlight">
            <SortableHeader col="code" label="Code" />
            <SortableHeader col="name" label="Name" />
            <SortableHeader col="account_type" label="Type" />
            <SortableHeader col="posts_directly" label="Kind" />
            <th className="px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Parent</th>
            <th className="px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Flags</th>
            <th className="px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Active</th>
            <th className="px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a, i) => (
            <tr
              key={a.id}
              className={`border-t-[0.5px] border-card-border font-body text-body hover:bg-cream-highlight ${i % 2 === 1 ? 'bg-alt-row' : 'bg-white'} ${!a.is_active ? 'opacity-50' : ''}`}
            >
              <td className="px-4 py-3 tabular-nums">{a.code || ''}</td>
              <td className="px-4 py-3 text-navy">{a.name}</td>
              <td className="px-4 py-3">
                <Badge variant={a.account_type === 'income' ? 'navy' : 'amber'}>
                  {a.account_type === 'income' ? 'Income' : 'Expense'}
                </Badge>
              </td>
              <td className="px-4 py-3">
                {a.posts_directly ? (
                  <span className="text-body">Posting</span>
                ) : (
                  <span className="text-muted italic">Summary</span>
                )}
              </td>
              <td className="px-4 py-3 text-muted text-sm">
                {parentNameById.get(a.parent_id) || <span className="italic">(top-level)</span>}
              </td>
              <td className="px-4 py-3"><FlagDisplay account={a} /></td>
              <td className="px-4 py-3">{a.is_active ? '✓' : '—'}</td>
              <td className="px-4 py-3 text-[12px] space-x-2 whitespace-nowrap">
                {canEdit && a.is_active && (
                  <>
                    <button onClick={() => onAdd(a.id)} className="text-status-blue hover:underline">+ Child</button>
                    <button onClick={() => onEdit(a)} className="text-status-blue hover:underline">Edit</button>
                  </>
                )}
                {canEdit && !a.is_active && (
                  <button onClick={() => onEdit(a)} className="text-status-blue hover:underline">Edit</button>
                )}
                {canApprove && (
                  a.is_active ? (
                    <button onClick={() => onDeactivate(a)} className="text-status-red hover:underline">Deactivate</button>
                  ) : (
                    <button onClick={() => onReactivate(a)} className="text-status-blue hover:underline">Reactivate</button>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

// ---- Add/Edit form -------------------------------------------------------

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
          <FieldLabel htmlFor="coa-parent">Parent</FieldLabel>
          <select
            id="coa-parent"
            value={parentId}
            onChange={(e) => handleParentChange(e.target.value)}
            className={inputCls}
          >
            <option value="">(top-level)</option>
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
              Type is inherited from the parent account.
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
                <span className="text-muted ml-2">— rollup of children only</span>
              </span>
            </label>
          </div>
          <div className="text-muted text-xs italic mt-1.5 leading-relaxed space-y-1">
            <p>
              <strong className="font-medium not-italic">Posting</strong> — money posts here in QuickBooks (e.g., individual discount accounts, individual donation accounts).
            </p>
            <p>
              <strong className="font-medium not-italic">Summary</strong> — pure rollup; value comes from children (e.g., "Tuition Discounts" as a header that sums its children).
            </p>
            <p>
              A posting account can also have children — its rollup is its direct posts plus children's totals.
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

// ---- Main component ------------------------------------------------------

function CoaManagement() {
  const { user } = useAuth()
  const { allowed, loading: permLoading } = useModulePermission('chart_of_accounts', 'view')
  const { allowed: canEdit } = useModulePermission('chart_of_accounts', 'edit')
  const { allowed: canApprove } = useModulePermission('chart_of_accounts', 'approve_lock')

  const [accounts, setAccounts] = useState([])
  const [dataLoading, setDataLoading] = useState(true)
  const [dataError, setDataError] = useState(null)

  const [view, setView] = useState('tree')

  const [formMode, setFormMode] = useState(null)
  const [formAccount, setFormAccount] = useState(null)
  const [formInitialParentId, setFormInitialParentId] = useState(null)
  const [formError, setFormError] = useState(null)
  const [formSubmitting, setFormSubmitting] = useState(false)

  const [success, setSuccess] = useState(null)

  async function loadAccounts() {
    setDataLoading(true)
    setDataError(null)
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
    if (error) {
      setDataError(error.message)
    } else {
      setAccounts(data || [])
    }
    setDataLoading(false)
  }

  useEffect(() => {
    if (allowed) loadAccounts()
  }, [allowed])

  const tree = useMemo(() => buildTree(accounts), [accounts])
  const parentNameById = useMemo(() => {
    const m = new Map()
    for (const a of accounts) m.set(a.id, a.name)
    return m
  }, [accounts])

  function openAdd(parentId = null) {
    setFormMode('add')
    setFormAccount(null)
    setFormInitialParentId(parentId)
    setFormError(null)
    setSuccess(null)
  }

  function openEdit(account) {
    setFormMode('edit')
    setFormAccount(account)
    setFormInitialParentId(null)
    setFormError(null)
    setSuccess(null)
  }

  function closeForm() {
    setFormMode(null)
    setFormAccount(null)
    setFormInitialParentId(null)
    setFormError(null)
  }

  async function handleSubmit(values) {
    setFormError(null)
    setFormSubmitting(true)

    let result
    if (formMode === 'add') {
      result = await supabase
        .from('chart_of_accounts')
        .insert({ ...values, created_by: user?.id, updated_by: user?.id })
        .select()
        .single()
    } else {
      result = await supabase
        .from('chart_of_accounts')
        .update({ ...values, updated_by: user?.id })
        .eq('id', formAccount.id)
        .select()
        .single()
    }

    setFormSubmitting(false)

    if (result.error) {
      setFormError(result.error.message)
      return
    }

    setSuccess(formMode === 'add' ? `Added ${values.name}.` : `Updated ${values.name}.`)
    closeForm()
    loadAccounts()
  }

  async function handleDeactivate(account) {
    const ok = window.confirm(
      `Deactivate "${account.name}"? It will be hidden from selection lists but historical references will be preserved. Children of this account will remain active independently.`
    )
    if (!ok) return

    setSuccess(null)
    setDataError(null)
    const { error } = await supabase
      .from('chart_of_accounts')
      .update({ is_active: false, updated_by: user?.id })
      .eq('id', account.id)

    if (error) {
      setDataError(error.message)
    } else {
      setSuccess(`Deactivated ${account.name}.`)
      loadAccounts()
    }
  }

  async function handleReactivate(account) {
    setSuccess(null)
    setDataError(null)
    const { error } = await supabase
      .from('chart_of_accounts')
      .update({ is_active: true, updated_by: user?.id })
      .eq('id', account.id)

    if (error) {
      setDataError(error.message)
    } else {
      setSuccess(`Reactivated ${account.name}.`)
      loadAccounts()
    }
  }

  if (permLoading) {
    return <p className="text-muted">Loading…</p>
  }

  if (!allowed) {
    return (
      <Card>
        <h2 className="font-display text-navy text-[20px] mb-2 leading-tight">
          You don't have access to Chart of Accounts.
        </h2>
        <p className="text-body mb-4">
          This module requires at least <strong>view</strong> permission. Contact a system admin if you need access.
        </p>
        <Link to="/dashboard" className={navyBtnCls}>
          Back to Dashboard
        </Link>
      </Card>
    )
  }

  return (
    <>
      <SectionLabel>Chart of Accounts</SectionLabel>

      <div className="flex items-end justify-between mb-4 gap-4">
        <div className="flex border-b-[0.5px] border-card-border">
          <button
            type="button"
            onClick={() => setView('tree')}
            className={`px-4 py-[7px] font-display text-[14px] tracking-[0.04em] cursor-pointer border-b-2 -mb-[0.5px] transition-colors ${view === 'tree' ? 'text-navy border-gold' : 'text-muted border-transparent hover:text-navy/80'}`}
          >
            Tree
          </button>
          <button
            type="button"
            onClick={() => setView('flat')}
            className={`px-4 py-[7px] font-display text-[14px] tracking-[0.04em] cursor-pointer border-b-2 -mb-[0.5px] transition-colors ${view === 'flat' ? 'text-navy border-gold' : 'text-muted border-transparent hover:text-navy/80'}`}
          >
            Flat
          </button>
        </div>

        {canEdit && !formMode && (
          <button type="button" onClick={() => openAdd()} className={navyBtnCls}>
            + Add Account
          </button>
        )}
      </div>

      {formMode && (
        <div className="mb-6">
          <AccountForm
            accounts={accounts}
            mode={formMode}
            account={formAccount}
            initialParentId={formInitialParentId}
            onSubmit={handleSubmit}
            onCancel={closeForm}
            error={formError}
            submitting={formSubmitting}
          />
        </div>
      )}

      {success && <p className="text-status-green text-sm mb-4" role="status">{success}</p>}
      {dataError && <p className="text-status-red text-sm mb-4" role="alert">{dataError}</p>}

      {dataLoading ? (
        <p className="text-muted">Loading accounts…</p>
      ) : view === 'tree' ? (
        <TreeView
          tree={tree}
          onAdd={openAdd}
          onEdit={openEdit}
          onDeactivate={handleDeactivate}
          onReactivate={handleReactivate}
          canEdit={canEdit}
          canApprove={canApprove}
        />
      ) : (
        <FlatTable
          accounts={accounts}
          parentNameById={parentNameById}
          onAdd={openAdd}
          onEdit={openEdit}
          onDeactivate={handleDeactivate}
          onReactivate={handleReactivate}
          canEdit={canEdit}
          canApprove={canApprove}
        />
      )}
    </>
  )
}

export default CoaManagement
