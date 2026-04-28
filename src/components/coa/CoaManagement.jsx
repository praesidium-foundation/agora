import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import { useToast } from '../../lib/Toast'
import Card from '../Card'
import Badge from '../Badge'
import SectionLabel from '../SectionLabel'
import CoaAccountModal from './CoaAccountModal'
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

// "summary" tag — italic muted text reads as descriptive metadata
// (kind, not status), so no colored badge.
function SummaryIndicator() {
  return (
    <span className="text-[12px] text-muted italic">summary</span>
  )
}

// Tree-row metadata zone. Shows ONE indicator (whichever applies) so
// the right-side column reads cleanly across 100+ rows. Priority:
// pass-thru → ed program → contribution; falls back to "summary" tag
// for summary accounts; empty for plain posting accounts so the column
// width is preserved without visual clutter.
function TreeMetadataCell({ account }) {
  const flagCount =
    (account.is_pass_thru ? 1 : 0) +
    (account.is_ed_program_dollars ? 1 : 0) +
    (account.is_contribution ? 1 : 0)
  const primary = account.is_pass_thru
    ? 'PASS-THRU'
    : account.is_ed_program_dollars
      ? 'ED $'
      : account.is_contribution
        ? 'CONTRIB'
        : null
  // Tooltip lists every set flag when more than one is set, so the
  // user can hover to see what was elided.
  const tooltip = flagCount > 1
    ? [
        account.is_pass_thru ? 'Pass-Thru' : null,
        account.is_ed_program_dollars ? 'Ed Program $' : null,
        account.is_contribution ? 'Contribution' : null,
      ].filter(Boolean).join(', ')
    : undefined
  return (
    <div
      className="w-[100px] flex items-center justify-end gap-1 flex-shrink-0"
      title={tooltip}
    >
      {!account.posts_directly ? (
        <SummaryIndicator />
      ) : primary ? (
        <>
          <FlagPill label={primary} />
          {flagCount > 1 && (
            <span className="text-muted/70 text-[10px]">+{flagCount - 1}</span>
          )}
        </>
      ) : null}
    </div>
  )
}

// Tree-row "type + active" zone. Income/Expense badge on every row;
// Inactive badge stacks on inactive accounts. Fixed width preserves
// alignment whether or not the inactive badge renders.
function TreeTypeCell({ account }) {
  return (
    <div className="w-[110px] flex items-center gap-1.5 flex-shrink-0">
      <Badge variant={account.account_type === 'income' ? 'navy' : 'amber'}>
        {account.account_type === 'income' ? 'Income' : 'Expense'}
      </Badge>
      {!account.is_active && <Badge variant="red">Inactive</Badge>}
    </div>
  )
}

// One slot inside the actions zone. Fixed width so the same-named
// action sits in the same position across rows. Accepts children =
// the action button (or null for a placeholder slot).
function ActionSlot({ width, align = 'right', children }) {
  return (
    <div
      className={`flex-shrink-0 ${align === 'right' ? 'text-right' : align === 'left' ? 'text-left' : 'text-center'}`}
      style={{ width }}
    >
      {children}
    </div>
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
        className={`flex items-center gap-3 py-2 pr-3 border-b-[0.5px] border-card-border hover:bg-cream-highlight ${!node.is_active ? 'opacity-50' : ''}`}
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

        {/* Right-side fixed-width zones: metadata, type+status, actions.
            Each zone preserves its width whether or not it has content,
            so the right edge of the tree stays aligned across rows. */}
        <TreeMetadataCell account={node} />

        <TreeTypeCell account={node} />

        {/* Actions zone: fixed-width slots with consistent positions.
            Property indicators (badges) above are visually distinct
            from the action verbs here — buttons use blue/red text
            links, not filled buttons, so the eye doesn't conflate
            "what this row IS" with "what I can DO with it." */}
        <div className="flex items-center justify-end gap-3 text-[12px] flex-shrink-0 w-[280px]">
          <ActionSlot width="84px">
            {canEdit && node.is_active ? (
              <button
                onClick={() => onAdd(node.id)}
                className="text-status-blue hover:underline"
              >
                + Subaccount
              </button>
            ) : null}
          </ActionSlot>
          <ActionSlot width="32px">
            {canEdit ? (
              <button
                onClick={() => onEdit(node)}
                className="text-status-blue hover:underline"
              >
                Edit
              </button>
            ) : null}
          </ActionSlot>
          <ActionSlot width="74px">
            {canApprove ? (
              node.is_active ? (
                <button
                  onClick={() => onDeactivate(node)}
                  className="text-status-red hover:underline"
                >
                  Deactivate
                </button>
              ) : (
                <button
                  onClick={() => onReactivate(node)}
                  className="text-status-blue hover:underline"
                >
                  Reactivate
                </button>
              )
            ) : null}
          </ActionSlot>
          <ActionSlot width="56px">
            {showDelete ? (
              <button
                onClick={() => onDelete(node)}
                className="text-status-red hover:underline"
              >
                Delete
              </button>
            ) : showCannotDeleteHint ? (
              // Info icon — informational, not destructive. Muted navy
              // by default; darkens to full navy on hover. Same icon,
              // same tooltip; just not red.
              <span
                title={`Cannot delete: Account has ${node.children.length} subaccount(s). Delete or move subaccounts first, or deactivate this account.`}
                aria-label="Why can't I delete this?"
                className="text-muted hover:text-navy text-[12px] cursor-help select-none"
              >
                (i)
              </span>
            ) : null}
          </ActionSlot>
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

// Pure presentation component — `expanded` Set and the toggle/expandAll/
// collapseAll callbacks are owned by CoaManagement so the Expand/Collapse
// affordance can live in the sticky controls strip above the tree
// (architecture Section 10's long-list-controls pattern). TreeView renders
// the rows; the controls live with the rest of the section header.
function TreeView({ tree, expanded, onToggle, ...handlers }) {
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
    <Card className="!p-0 overflow-hidden">
      <div>
        {tree.map((node) => (
          <TreeNode key={node.id} node={node} depth={0} expanded={expanded} onToggle={onToggle} {...handlers} />
        ))}
      </div>
    </Card>
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
        className="sticky top-[110px] z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80 cursor-pointer select-none"
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
            <th className="sticky top-[110px] z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Subaccount of</th>
            <th className="sticky top-[110px] z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Flags</th>
            <th className="sticky top-[110px] z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Active</th>
            <th className="sticky top-[110px] z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">Actions</th>
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
                    className="text-muted hover:text-navy text-[12px] cursor-help select-none"
                  >
                    (i)
                  </span>
                )}
                {canAdmin && !parentsWithChildren.has(a.id) && (
                  <button onClick={() => onDelete(a)} className="text-status-red hover:underline">
                    Delete
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

// AccountForm lives in ./AccountForm.jsx and renders inside
// CoaAccountModal here (and inside Budget's AddAccountModal). Add /
// edit / "+ Subaccount" all open the same form in modal context —
// see architecture Section 10 (modal-not-inline-expand pattern).

// ---- Main component ------------------------------------------------------

function CoaManagement() {
  const { user } = useAuth()
  const toast = useToast()
  const { allowed, loading: permLoading } = useModulePermission('chart_of_accounts', 'view')
  const { allowed: canEdit } = useModulePermission('chart_of_accounts', 'edit')
  const { allowed: canApprove } = useModulePermission('chart_of_accounts', 'approve_lock')
  const { allowed: canAdmin } = useModulePermission('chart_of_accounts', 'admin')

  const [accounts, setAccounts] = useState([])
  const [dataLoading, setDataLoading] = useState(true)

  const [view, setView] = useState('tree')

  // Modal state for add / edit / "+ subaccount" flows. CoaAccountModal
  // owns its own submitting + error state internally; we just track
  // mode + context here.
  const [formMode, setFormMode] = useState(null)
  const [formAccount, setFormAccount] = useState(null)
  const [formInitialParentId, setFormInitialParentId] = useState(null)
  const [formParentLocked, setFormParentLocked] = useState(false)

  const [showImportExport, setShowImportExport] = useState(false)

  // Hard-delete confirmation state. deleteTarget is the account pending
  // confirmation; deleteVerifying covers the RPC safety check before the
  // dialog opens; deleting covers the actual DELETE call.
  // The deleteError stays inline INSIDE the confirmation dialog (modal-
  // local feedback, not a top-of-page status). Pre-flight failures from
  // the can_hard_delete RPC route through toast.error() instead.
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteVerifying, setDeleteVerifying] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  async function loadAccounts() {
    setDataLoading(true)
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
    if (error) {
      toast.error(translateError(error.message))
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

  // Expand/collapse state lives at the page level so the Expand all /
  // Collapse all controls can sit in the sticky controls strip alongside
  // the tabs, action buttons, and section header (architecture Section
  // 10.10 long-list pattern). Tree is fully expanded on first non-empty
  // load; user toggles take over from there.
  const [expanded, setExpanded] = useState(() => new Set())
  const [expandedInitialized, setExpandedInitialized] = useState(false)
  useEffect(() => {
    if (!expandedInitialized && tree.length > 0) {
      setExpanded(collectAllParentIds(tree))
      setExpandedInitialized(true)
    }
  }, [tree, expandedInitialized])
  function toggleNode(id) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function expandAll() { setExpanded(collectAllParentIds(tree)) }
  function collapseAll() { setExpanded(new Set()) }

  // Top-level "+ Add Account" button passes no parentId and renders an
  // unlocked parent dropdown. Row-level "+ Subaccount" passes the row's
  // id and locks the parent (the user picked a row deliberately).
  function openAdd(parentId = null) {
    setFormMode('add')
    setFormAccount(null)
    setFormInitialParentId(parentId)
    setFormParentLocked(parentId !== null)
  }

  function openEdit(account) {
    setFormMode('edit')
    setFormAccount(account)
    setFormInitialParentId(null)
    setFormParentLocked(false)
  }

  function closeForm() {
    setFormMode(null)
    setFormAccount(null)
    setFormInitialParentId(null)
    setFormParentLocked(false)
  }

  // Modal calls this after a successful supabase write. The modal owns
  // the submitting state and error display; we just close it, surface
  // the toast, and reload the tree.
  function handleFormSuccess(savedAccount, mode) {
    toast.success(
      mode === 'add'
        ? `Added ${savedAccount.name}.`
        : `Updated ${savedAccount.name}.`
    )
    closeForm()
    loadAccounts()
  }

  async function handleDeactivate(account) {
    const ok = window.confirm(
      `Deactivate "${account.name}"? It will be hidden from selection lists but historical references will be preserved. Subaccounts of this account will remain active independently.`
    )
    if (!ok) return

    const { error } = await supabase
      .from('chart_of_accounts')
      .update({ is_active: false, updated_by: user?.id })
      .eq('id', account.id)

    if (error) {
      toast.error(translateError(error.message))
    } else {
      toast.success(`Deactivated ${account.name}.`)
      loadAccounts()
    }
  }

  async function handleReactivate(account) {
    const { error } = await supabase
      .from('chart_of_accounts')
      .update({ is_active: true, updated_by: user?.id })
      .eq('id', account.id)

    if (error) {
      toast.error(translateError(error.message))
    } else {
      toast.success(`Reactivated ${account.name}.`)
      loadAccounts()
    }
  }

  // Hard-delete: two-step. The button only renders when the client-side
  // check (no subaccounts) passes, but on click we still hit the DB
  // function as a safety net for future FK references that the client
  // doesn't know about.
  async function handleHardDeleteClick(account) {
    setDeleteVerifying(true)
    setDeleteError(null)

    const { data, error } = await supabase.rpc(
      'chart_of_accounts_can_hard_delete',
      { p_account_id: account.id }
    )

    setDeleteVerifying(false)

    if (error) {
      toast.error(translateError(error.message))
      return
    }

    // RPC returns a table — single row in this shape.
    const result = Array.isArray(data) ? data[0] : data
    if (!result?.can_delete) {
      toast.error(
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
      // Stay inside the dialog so the user sees the error in the
      // context of the action they were about to confirm. Toast also
      // fires for sticky visibility once they close.
      setDeleteError(translateError(error.message))
      return
    }

    toast.success(`Deleted ${deleteTarget.name}.`)
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
      {/* Sticky controls strip. The COA section's section label, tab
          strip, action buttons, and Expand/Collapse controls all stay
          pinned at the top of the scroll container so they remain
          reachable from anywhere in a 100+ row tree. Cream background
          + bottom border give clean visual separation from rows
          scrolling underneath. (See architecture Section 10.10 for
          the long-list-controls pattern.) */}
      <div className="sticky top-0 z-30 -mx-6 px-6 bg-cream border-b-[0.5px] border-card-border pt-2 pb-3 mb-4">
        <SectionLabel>Chart of Accounts</SectionLabel>

        <div className="flex items-end justify-between gap-4">
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
            {!showImportExport && (
              <button
                type="button"
                onClick={() => setShowImportExport(true)}
                className="font-body text-sm text-status-blue hover:underline"
              >
                Import / Export
              </button>
            )}
            {canEdit && (
              <button type="button" onClick={() => openAdd()} className={navyBtnCls}>
                + Add Account
              </button>
            )}
          </div>
        </div>

        {/* Expand all / Collapse all controls live with the rest of the
            sticky header in Tree view. Hidden in Flat view (no tree to
            expand) and on the empty-tree state. */}
        {view === 'tree' && tree.length > 0 && (
          <div className="flex items-center justify-end mt-2 gap-3 text-[12px]">
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
        )}
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
        <CoaAccountModal
          accounts={accounts}
          mode={formMode}
          account={formAccount}
          initialParentId={formInitialParentId}
          parentLocked={formParentLocked}
          userId={user?.id}
          onClose={closeForm}
          onSuccess={handleFormSuccess}
          translateError={translateError}
        />
      )}

      {/* Status messages render via the global Toast system
          (top-right of viewport) — see useToast above. Inline status
          rendering at the top of the section is no longer used; on a
          122-row tree the user is rarely scrolled to where it would
          be visible anyway. */}

      {dataLoading ? (
        <p className="text-muted">Loading accounts…</p>
      ) : view === 'tree' ? (
        <TreeView
          tree={tree}
          expanded={expanded}
          onToggle={toggleNode}
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
