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
function Row({ node, depth, editing, setEditing, readOnly, onSaveAmount, editableSeq, onShowLineHistory }) {
  const isPosting = node.posts_directly
  const hasLine = node.line !== null
  const amount = hasLine ? node.line.amount : 0
  const isLinked = node.line && node.line.source_type !== 'manual'
  const isInactive = !node.is_active

  // When this row is being edited, render the editor; otherwise render
  // the value (clickable when editable).
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

  return (
    <>
      <div
        className={`flex items-center gap-3 py-1.5 pr-3 border-b-[0.5px] border-card-border ${
          isInactive ? 'opacity-50' : ''
        } ${isPosting ? 'hover:bg-cream-highlight/60' : 'bg-cream-highlight/40'}`}
        style={{ paddingLeft: `${indentPx}px` }}
      >
        {/* Caret column for summary rows. Posting rows get a fixed-width
            spacer so amounts line up vertically across types. */}
        {!isPosting && (
          <span className="w-3 text-muted/60 text-[10px]" aria-hidden="true">▾</span>
        )}
        {isPosting && <span className="w-3" aria-hidden="true" />}

        {node.code && (
          <span className="font-body text-[12px] text-muted tabular-nums w-12 flex-shrink-0">
            {node.code}
          </span>
        )}
        {!node.code && <span className="w-12 flex-shrink-0" />}

        <span
          className={`font-body flex-1 min-w-0 truncate ${
            isPosting ? 'text-body text-[14px]' : 'text-navy text-[14px] tracking-[0.04em]'
          }`}
        >
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
            print routes don't pass one) or no line yet. */}
        {isPosting && hasLine && onShowLineHistory && (
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
            obvious at a glance which fields the user can adjust. */}
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
              className={`text-right tabular-nums px-2 py-1 font-body text-[14px] w-32 flex-shrink-0 ${
                amount < 0 ? 'text-status-red' : 'text-body'
              }`}
            >
              {fmtUsd(amount)}
            </span>
          ) : (
            // Editable: render as a ghost input. Visible 0.5px border
            // and white fill make the field-shape unmistakable; hover
            // intensifies the border so the click target is obvious.
            <button
              type="button"
              onClick={handleClick}
              className={`text-right tabular-nums px-2 py-1 rounded font-body text-[14px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/50 hover:bg-cream-highlight/40 transition-colors ${
                amount < 0 ? 'text-status-red' : 'text-body'
              }`}
              aria-label={`Edit amount for ${node.name}`}
              title="Click to edit"
            >
              {fmtUsd(amount)}
            </button>
          )
        ) : (
          <span
            className={`text-right tabular-nums font-body text-[14px] w-32 flex-shrink-0 ${
              node.rollup < 0 ? 'text-status-red' : 'text-navy font-medium'
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

// Synthetic top-level group (INCOME / EXPENSES). The label is rendered
// in a heading-like band; the rolled-up total sits at the right.
function TopGroup({ group, editing, setEditing, readOnly, onSaveAmount, editableSeq, onShowLineHistory }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-3 px-2 py-2 border-b-[0.5px] border-navy/30">
        <span className="w-3 text-navy text-[10px]" aria-hidden="true">▾</span>
        <span className="w-12 flex-shrink-0" />
        <span className="font-display text-navy text-[15px] tracking-[0.10em] uppercase flex-1">
          {group.label}
        </span>
        <span
          className={`text-right tabular-nums font-display text-[15px] w-32 flex-shrink-0 ${
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
      />
      <TopGroup
        group={tree.expense}
        editing={editing}
        setEditing={setEditing}
        readOnly={readOnly}
        onSaveAmount={onSaveAmount}
        editableSeq={editableSeq}
        onShowLineHistory={onShowLineHistory}
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
