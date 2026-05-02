import { useEffect, useMemo, useRef, useState } from 'react'
import Badge from '../Badge'
import { editableOrder } from '../../lib/budgetTree'

// Hierarchical detail render (Display Style A from architecture Section
// 4.5). Synthetic INCOME and EXPENSES top-level groups; under each, the
// COA's actual top-level accounts of that type, recursing through the
// sub-tree.
//
// Editing model (Section 8.3): direct-edit-with-undo.
//   - Click an amount cell → inline numeric input
//   - Enter or blur saves; Escape cancels and restores previous value
//   - Tab moves to next editable cell; Shift+Tab to previous
//   - Cmd+Z (Ctrl+Z on Windows) undoes the last in-session save
//   - Every save logs through the change_log trigger automatically
//
// Props:
//   tree    — output of buildBudgetTree
//   readOnly — true when scenario is locked or user lacks edit perm
//   onSaveAmount(accountId, newAmount, prevAmount) — called on each save
//   onUndo()                                       — called on Cmd+Z
//   undoAvailable boolean
//   onShowLineHistory(line, account) — optional; when provided, a small
//     "history" icon appears next to each leaf row's amount cell so users
//     can audit edits to that specific line without leaving the page.
//     The handler receives { id, amount, source_type } from the line and
//     { id, code, name } from the account.

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function fmtUsd(n) {
  return usd0.format(n)
}

// Parse user input back to a numeric value. Tolerant of currency-formatted
// strings ("$1,234.56", "(123)" for negative). Returns null when input is
// empty (user clearing → save 0); throws on malformed input.
function parseAmountInput(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return 0
  let working = s
  let isNeg = false
  const parens = /^\(([^)]+)\)$/.exec(working)
  if (parens) {
    isNeg = true
    working = parens[1]
  }
  working = working.replace(/[$,\s]/g, '')
  if (working === '' || working === '-') {
    throw new Error(`"${s}" is not a number`)
  }
  const n = Number(working)
  if (!Number.isFinite(n)) throw new Error(`"${s}" is not a number`)
  return isNeg ? -Math.abs(n) : n
}

// Inline editor for a single amount cell. Manages its own draft state;
// committing the value flows up via onSave.
function AmountEditor({ initial, onSave, onCancel, onTab }) {
  const [draft, setDraft] = useState(
    Number.isFinite(initial) ? String(initial) : ''
  )
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function commit() {
    try {
      const value = parseAmountInput(draft)
      onSave(value)
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          if (error) setError(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          } else if (e.key === 'Tab') {
            e.preventDefault()
            try {
              const value = parseAmountInput(draft)
              onTab(e.shiftKey ? -1 : 1, value)
            } catch (err) {
              setError(err.message)
            }
          }
        }}
        className="w-32 text-right border-[0.5px] border-navy/40 px-2 py-1 rounded text-sm tabular-nums focus:outline-none focus:border-navy bg-white"
        aria-label="Amount"
      />
      {error && (
        <span className="text-status-red text-[11px] italic mt-0.5">
          {error}
        </span>
      )}
    </span>
  )
}

// One row in the tree. Posting accounts get the editable treatment;
// summary accounts render as category headers with rollup totals.
//
// Tier mapping (architecture §10.4 — applied in-app from v3.6):
//   - depth = 0, !isPosting   → Tier 2 (top-level summary like
//                                "Educational Program Revenue", "Personnel")
//   - depth ≥ 1, !isPosting   → Tier 3 (mid-level summary like
//                                "Tuition Discounts", "Payroll")
//   - isPosting                → Tier 4 (leaf posting account)
// Tier 1 is the synthetic INCOME / EXPENSES heading rendered by
// TopGroup, not by Row.
//
// Each tier reads strongly enough that the eye can place itself in
// the hierarchy without leaning on indentation alone or on the input
// chrome (which goes away in locked state).
function Row({ node, depth, editing, setEditing, readOnly, onSaveAmount, editableSeq, onShowLineHistory, hideLineHistory }) {
  const isPosting = node.posts_directly
  const hasLine = node.line !== null
  const amount = hasLine ? node.line.amount : 0
  const isLinked = node.line && node.line.source_type !== 'manual'
  const isInactive = !node.is_active

  const tier = isPosting ? 4 : (depth === 0 ? 2 : 3)
  const editingThisRow = editing.accountId === node.id

  function handleClick() {
    if (readOnly) return
    if (!isPosting || !hasLine) return
    setEditing({ accountId: node.id })
  }

  function handleTab(direction, lastValue) {
    // Save the value at the current cell, then move to the next
    // editable cell in tree order.
    onSaveAmount(node.id, lastValue, amount)
    const idx = editableSeq.findIndex((c) => c.accountId === node.id)
    const next =
      direction === 1
        ? editableSeq[idx + 1]
        : editableSeq[idx - 1]
    if (next) setEditing({ accountId: next.accountId })
    else setEditing({ accountId: null })
  }

  // Visual indent: 18px per depth level (excluding the top-level
  // INCOME/EXPENSES heading which is rendered separately).
  const indentPx = 18 * (depth + 1)

  // Per-tier row treatment. Tier 2 carries a thin navy bottom rule
  // (the screen analog of the PDF's "thin navy rule" under top-level
  // summaries). Tier 3 has no rule. Tier 4 has a faint card-border
  // rule for row separation. Vertical padding scales with tier so
  // summaries get breathing room and leaves stay tight.
  const rowFrame =
    tier === 2
      ? 'py-2 pt-3 border-b-[0.5px] border-navy/25 bg-cream-highlight/30'
      : tier === 3
        ? 'py-1.5 pt-2 border-b-[0.5px] border-card-border/60'
        : 'py-1 border-b-[0.5px] border-card-border hover:bg-cream-highlight/40'

  // Per-tier name styling.
  const nameClass =
    tier === 2
      ? 'font-body font-semibold text-navy text-[15px] tracking-[0.02em] flex-1 min-w-0 truncate'
      : tier === 3
        ? 'font-body font-medium text-navy text-[13.5px] flex-1 min-w-0 truncate'
        : 'font-body text-[13px] text-navy/85 flex-1 min-w-0 truncate'

  // Per-tier rollup amount styling. Editable input in Tier 4 keeps
  // its own treatment; Tier 4 read-only and the summary tiers all
  // route through here for the right-aligned amount text.
  const rollupClass =
    tier === 2
      ? 'text-right tabular-nums font-body font-semibold text-[15px] w-32 flex-shrink-0'
      : 'text-right tabular-nums font-body font-medium text-[13.5px] w-32 flex-shrink-0'

  return (
    <>
      <div
        className={`flex items-center gap-3 pr-3 ${rowFrame} ${
          isInactive ? 'opacity-50' : ''
        }`}
        style={{ paddingLeft: `${indentPx}px` }}
      >
        {/* Caret column for summary rows. Posting rows get a fixed-width
            spacer so amounts line up vertically across types. */}
        {!isPosting && (
          <span className="w-3 text-muted/60 text-[10px]" aria-hidden="true">▾</span>
        )}
        {isPosting && <span className="w-3" aria-hidden="true" />}

        {node.code && (
          <span className={`font-body tabular-nums w-12 flex-shrink-0 ${
            tier === 4 ? 'text-[11px] text-navy/55' : 'text-[12px] text-muted'
          }`}>
            {node.code}
          </span>
        )}
        {!node.code && <span className="w-12 flex-shrink-0" />}

        <span className={nameClass}>
          {node.name}
        </span>

        {isInactive && hasLine && (
          <Badge variant="red">Inactive</Badge>
        )}

        {isLinked && (
          <span
            title={`Pulled from ${linkedSourceLabel(node.line.source_type)}. Edit there to change.`}
            aria-label="Auto-pulled value"
            className="text-muted text-[11px]"
          >
            ⛓
          </span>
        )}

        {/* History affordance. Posting accounts with a real backing
            line get a small clock icon to the right of the amount; the
            click hands the line off to the parent which opens the
            LineHistoryModal. Hidden when there's no handler (e.g.,
            print routes don't pass one), no line yet, or hideLineHistory
            is true (locked state — per-line drilldown is editing-mode
            functionality; the activity feed covers locked-state audit
            exploration). */}
        {isPosting && hasLine && onShowLineHistory && !hideLineHistory && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onShowLineHistory(node.line, { id: node.id, code: node.code, name: node.name })
            }}
            aria-label={`View history for ${node.name}`}
            title="View history"
            className="text-muted hover:text-navy text-[12px] leading-none px-1.5 py-1 rounded hover:bg-cream-highlight transition-colors"
          >
            🕓
          </button>
        )}

        {/* Amount cell. Posting accounts: clickable to edit (or editor
            when active). Summary accounts: rollup total, read-only.
            Editable cells render with an input-style outline so it's
            obvious at a glance which fields the user can adjust. The
            input chrome is intentionally quieter than the strengthened
            Tier 2/3 typography around it — hierarchy reads first;
            editability reads second. */}
        {isPosting ? (
          editingThisRow && !readOnly && !isLinked ? (
            <AmountEditor
              initial={amount}
              onSave={(v) => {
                onSaveAmount(node.id, v, amount)
                setEditing({ accountId: null })
              }}
              onCancel={() => setEditing({ accountId: null })}
              onTab={handleTab}
            />
          ) : readOnly || isLinked ? (
            // Non-editable posting amount (locked scenario or auto-pulled
            // upstream value): plain text, no input affordance.
            <span
              className={`text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 ${
                amount < 0 ? 'text-status-red' : 'text-navy/85'
              }`}
            >
              {fmtUsd(amount)}
            </span>
          ) : (
            <button
              type="button"
              onClick={handleClick}
              className={`text-right tabular-nums px-2 py-1 rounded font-body text-[13px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors ${
                amount < 0 ? 'text-status-red' : 'text-navy/85'
              }`}
              aria-label={`Edit amount for ${node.name}`}
              title="Click to edit"
            >
              {fmtUsd(amount)}
            </button>
          )
        ) : (
          <span
            className={`${rollupClass} ${
              node.rollup < 0 ? 'text-status-red' : 'text-navy'
            }`}
          >
            {fmtUsd(node.rollup)}
          </span>
        )}
      </div>

      {node.children.map((child) => (
        <Row
          key={child.id}
          node={child}
          depth={depth + 1}
          editing={editing}
          setEditing={setEditing}
          readOnly={readOnly}
          onSaveAmount={onSaveAmount}
          editableSeq={editableSeq}
          onShowLineHistory={onShowLineHistory}
          hideLineHistory={hideLineHistory}
        />
      ))}
    </>
  )
}

function linkedSourceLabel(sourceType) {
  switch (sourceType) {
    case 'linked_tuition':    return 'Tuition Worksheet'
    case 'linked_staffing':   return 'Staffing'
    case 'linked_enrollment': return 'Enrollment Estimator'
    default:                  return 'an upstream module'
  }
}

// Synthetic top-level group (INCOME / EXPENSES). Tier 1 in the
// four-tier hierarchy (architecture §10.4). Cinzel display face, gold
// underline accent — the screen analog of the PDF's gold underline.
// Generous vertical breathing room above and below so the eye reads
// "this is a category" without effort.
function TopGroup({ group, editing, setEditing, readOnly, onSaveAmount, editableSeq, onShowLineHistory, hideLineHistory }) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 px-2 py-3 border-b-2 border-gold/60">
        <span className="w-3 text-navy text-[10px]" aria-hidden="true">▾</span>
        <span className="w-12 flex-shrink-0" />
        <span className="font-display text-navy text-[17px] tracking-[0.08em] uppercase flex-1">
          {group.label}
        </span>
        <span
          className={`text-right tabular-nums font-display text-[17px] w-32 flex-shrink-0 ${
            group.total < 0 ? 'text-status-red' : 'text-navy'
          }`}
        >
          {fmtUsd(group.total)}
        </span>
      </div>

      {group.children.length === 0 ? (
        <p className="font-body italic text-muted text-sm py-3 px-4">
          No {group.account_type} accounts in this scenario yet.
        </p>
      ) : (
        group.children.map((node) => (
          <Row
            key={node.id}
            node={node}
            depth={0}
            editing={editing}
            setEditing={setEditing}
            readOnly={readOnly}
            onSaveAmount={onSaveAmount}
            editableSeq={editableSeq}
            onShowLineHistory={onShowLineHistory}
            hideLineHistory={hideLineHistory}
          />
        ))
      )}
    </div>
  )
}

function BudgetDetailZone({
  tree,
  readOnly,
  onSaveAmount,
  onUndo,
  undoAvailable,
  onShowLineHistory,
  // When true, suppress the per-line clock-icon affordance on every
  // leaf row. Used for locked scenarios — the activity feed remains
  // the comprehensive surface for locked-state audit history; per-
  // line drilldown is editing-mode functionality. Architecture §9.1
  // (extended in v3.6).
  hideLineHistory = false,
}) {
  const [editing, setEditing] = useState({ accountId: null })

  // Recompute editable order whenever the tree changes. Tab navigation
  // walks this sequence.
  const editableSeq = useMemo(() => editableOrder(tree), [tree])

  // Cmd+Z / Ctrl+Z anywhere in the page (when not actively editing) →
  // undo the last save. We attach the listener on window so it works
  // regardless of focus, but skip when the user is typing in an input
  // (the editor's own keyboard handling owns Escape, etc.).
  useEffect(() => {
    function handleKey(e) {
      const k = e.key.toLowerCase()
      const meta = e.metaKey || e.ctrlKey
      if (meta && k === 'z' && !e.shiftKey) {
        const target = e.target
        const isField =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        if (isField) return
        if (!undoAvailable) return
        e.preventDefault()
        onUndo()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [undoAvailable, onUndo])

  return (
    <div className="px-2 py-2">
      <TopGroup
        group={tree.income}
        editing={editing}
        setEditing={setEditing}
        readOnly={readOnly}
        onSaveAmount={onSaveAmount}
        editableSeq={editableSeq}
        onShowLineHistory={onShowLineHistory}
        hideLineHistory={hideLineHistory}
      />
      <TopGroup
        group={tree.expense}
        editing={editing}
        setEditing={setEditing}
        readOnly={readOnly}
        onSaveAmount={onSaveAmount}
        editableSeq={editableSeq}
        onShowLineHistory={onShowLineHistory}
        hideLineHistory={hideLineHistory}
      />

      {readOnly && (
        <div className="mt-4 px-4 py-3 bg-status-amber-bg border-[0.5px] border-status-amber/30 rounded text-status-amber text-sm">
          This scenario is locked. To edit, request unlock from the
          Treasurer.
        </div>
      )}
    </div>
  )
}

export default BudgetDetailZone
