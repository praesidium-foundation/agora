import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import Card from '../Card'
import Badge from '../Badge'
import SectionLabel from '../SectionLabel'
import FieldLabel from '../FieldLabel'
import ImportExportPanel from './ImportExportPanel'

// Trigger error messages still use older "parent / child / cycle" wording.
// Translate at the UI surface so user-facing copy stays consistent with the
// QuickBooks-aligned vocabulary. Database column names (parent_id) are
// unchanged — see CLAUDE.md "COA vocabulary" note.
function translateError(msg) {
  if (!msg) return msg
  return msg
    .replace(/Reparenting "([^"]+)" would create a cycle\b[^.]*\./i,
      'Moving "$1" here would create a loop (it would end up nested under itself).')
    .replace(/Cannot add a child under a flagged account\./gi,
      'Cannot add a subaccount under a flagged account.')
    .replace(/its primary "([^"]+)"/gi, 'its primary account "$1"')
    .replace(/parent's type/gi, 'primary account type')
    .replace(/parent type/gi, 'primary account type')
}

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

function TreeNode({ node, depth, expanded, onToggle, onAdd, onEdit, onDeactivate, onReactivate, onDelete, canEdit, canApprove, canAdmin }) {
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.id)
  // Hard-delete is offered when the user has admin perm AND nothing else
  // references this account. Today the only check is "no subaccounts" —
  // the DB function `chart_of_accounts_can_hard_delete` is the source of
  // truth and gets called server-side at click time as a safety net for
  // future FK references.
  const showDelete = canAdmin && !hasChildren
  const showCannotDeleteHint = canAdmin && hasChildren

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
              <button onClick={() => onAdd(node.id)} className="text-status-blue hover:underline">+ Subaccount</button>
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
          {showCannotDeleteHint && (
            <span
              title={`Cannot delete: Account has ${node.children.length} subaccount(s). Delete or move subaccounts first, or deactivate this account.`}
              aria-label="Why can't I delete this?"
              className="text-muted/70 text-[12px] cursor-help select-none"
            >
              (i)
            </span>
          )}
          {showDelete && (
            <button
              onClick={() => onDelete(node)}
              className="text-status-red hover:underline"
            >
              Delete…
            </button>
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
          onDelete={onDelete}
          canEdit={canEdit}
          canApprove={canApprove}
          canAdmin={canAdmin}
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

function FlatTable({ accounts, parentNameById, parentsWithChildren, onAdd, onEdit, onDeactivate, onReactivate, onDelete, canEdit, canApprove, canAdmin }) {
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
        className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80 cursor-pointer select-none"
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
          <tr>
            <SortableHeader col="code" label="Code" />
            <SortableHeader col="name" label="Name" />
            <SortableHeader col="account_type" label="Type" />
            <SortableHeader col="posts_directly" label="Kind" />
            <th className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Subaccount of</th>
            <th className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Flags</th>
            <th className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Active</th>
            <th className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Actions</th>
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
                    <button onClick={() => onAdd(a.id)} className="text-status-blue hover:underline">+ Subaccount</button>
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
                {canAdmin && parentsWithChildren.has(a.id) && (
                  <span
                    title={`Cannot delete: Account has subaccount(s). Delete or move subaccounts first, or deactivate this account.`}
                    aria-label="Why can't I delete this?"
                    className="text-muted/70 text-[12px] cursor-help select-none"
                  >
                    (i)
                  </span>
                )}
                {canAdmin && !parentsWithChildren.has(a.id) && (
                  <button onClick={() => onDelete(a)} className="text-status-red hover:underline">
                    Delete…
                  </button>
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

// ---- Main component ------------------------------------------------------

function CoaManagement() {
  const { user } = useAuth()
  const { allowed, loading: permLoading } = useModulePermission('chart_of_accounts', 'view')
  const { allowed: canEdit } = useModulePermission('chart_of_accounts', 'edit')
  const { allowed: canApprove } = useModulePermission('chart_of_accounts', 'approve_lock')
  const { allowed: canAdmin } = useModulePermission('chart_of_accounts', 'admin')

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

  const [showImportExport, setShowImportExport] = useState(false)

  // Hard-delete confirmation state. deleteTarget is the account pending
  // confirmation; deleteVerifying covers the RPC safety check before the
  // dialog opens; deleting covers the actual DELETE call.
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteVerifying, setDeleteVerifying] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  async function loadAccounts() {
    setDataLoading(true)
    setDataError(null)
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
    if (error) {
      setDataError(translateError(error.message))
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

  // Set of ids that have at least one subaccount. Used by the FlatTable to
  // decide whether to show the Delete button or the cannot-delete (i) hint
  // per row. TreeNode has the same info via node.children.length.
  const parentsWithChildren = useMemo(() => {
    const s = new Set()
    for (const a of accounts) {
      if (a.parent_id) s.add(a.parent_id)
    }
    return s
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
      setFormError(translateError(result.error.message))
      return
    }

    setSuccess(formMode === 'add' ? `Added ${values.name}.` : `Updated ${values.name}.`)
    closeForm()
    loadAccounts()
  }

  async function handleDeactivate(account) {
    const ok = window.confirm(
      `Deactivate "${account.name}"? It will be hidden from selection lists but historical references will be preserved. Subaccounts of this account will remain active independently.`
    )
    if (!ok) return

    setSuccess(null)
    setDataError(null)
    const { error } = await supabase
      .from('chart_of_accounts')
      .update({ is_active: false, updated_by: user?.id })
      .eq('id', account.id)

    if (error) {
      setDataError(translateError(error.message))
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
      setDataError(translateError(error.message))
    } else {
      setSuccess(`Reactivated ${account.name}.`)
      loadAccounts()
    }
  }

  // Hard-delete: two-step. The button only renders when the client-side
  // check (no subaccounts) passes, but on click we still hit the DB
  // function as a safety net for future FK references that the client
  // doesn't know about.
  async function handleHardDeleteClick(account) {
    setDeleteVerifying(true)
    setDataError(null)
    setDeleteError(null)

    const { data, error } = await supabase.rpc(
      'chart_of_accounts_can_hard_delete',
      { p_account_id: account.id }
    )

    setDeleteVerifying(false)

    if (error) {
      setDataError(translateError(error.message))
      return
    }

    // RPC returns a table — single row in this shape.
    const result = Array.isArray(data) ? data[0] : data
    if (!result?.can_delete) {
      setDataError(
        result?.blocking_reason ||
          'This account cannot be hard-deleted. Try Deactivate instead.'
      )
      return
    }

    setDeleteTarget(account)
  }

  async function handleConfirmHardDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)

    const { error } = await supabase
      .from('chart_of_accounts')
      .delete()
      .eq('id', deleteTarget.id)

    setDeleting(false)

    if (error) {
      setDeleteError(translateError(error.message))
      return
    }

    setSuccess(`Deleted ${deleteTarget.name}.`)
    setDeleteTarget(null)
    loadAccounts()
  }

  function handleCancelHardDelete() {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteError(null)
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

        <div className="flex items-center gap-3">
          {!formMode && !showImportExport && (
            <button
              type="button"
              onClick={() => setShowImportExport(true)}
              className="font-body text-sm text-status-blue hover:underline"
            >
              Import / Export
            </button>
          )}
          {canEdit && !formMode && (
            <button type="button" onClick={() => openAdd()} className={navyBtnCls}>
              + Add Account
            </button>
          )}
        </div>
      </div>

      {showImportExport && (
        <div className="mb-6">
          <ImportExportPanel
            accounts={accounts}
            onClose={() => setShowImportExport(false)}
            onImported={loadAccounts}
          />
        </div>
      )}

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
          onDelete={handleHardDeleteClick}
          canEdit={canEdit}
          canApprove={canApprove}
          canAdmin={canAdmin}
        />
      ) : (
        <FlatTable
          accounts={accounts}
          parentNameById={parentNameById}
          parentsWithChildren={parentsWithChildren}
          onAdd={openAdd}
          onEdit={openEdit}
          onDeactivate={handleDeactivate}
          onReactivate={handleReactivate}
          onDelete={handleHardDeleteClick}
          canEdit={canEdit}
          canApprove={canApprove}
          canAdmin={canAdmin}
        />
      )}

      {/* Hard-delete confirmation dialog. Modal-style overlay; close on
          backdrop click except while a delete is in flight. */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
          onClick={handleCancelHardDelete}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white border-[0.5px] border-card-border rounded-[10px] max-w-md w-full p-6 shadow-lg"
            role="dialog"
            aria-modal="true"
            aria-labelledby="coa-delete-dialog-title"
          >
            <h3
              id="coa-delete-dialog-title"
              className="font-display text-navy text-[18px] mb-3 leading-tight"
            >
              Delete account "{deleteTarget.name}"?
            </h3>
            <p className="text-body text-sm mb-3 leading-relaxed">
              This permanently removes the account from the Chart of Accounts.{' '}
              <strong className="font-medium">
                The action cannot be undone.
              </strong>
            </p>
            <p className="text-muted text-sm italic mb-6 leading-relaxed">
              Account references checked: this account has no subaccounts and is
              not used by any other module.
            </p>

            {deleteError && (
              <p className="text-status-red text-sm mb-4" role="alert">
                {deleteError}
              </p>
            )}

            <div className="flex items-center justify-end gap-4">
              <button
                type="button"
                onClick={handleCancelHardDelete}
                disabled={deleting}
                className="font-body text-muted hover:text-navy text-sm disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmHardDelete}
                disabled={deleting}
                className="bg-status-red text-white border-[0.5px] border-status-red px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default CoaManagement
