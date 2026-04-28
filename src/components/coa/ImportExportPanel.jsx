import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import {
  parseAndNormalize,
  validateRows,
  generateExportCsv,
  generateExportFilename,
  generateTemplateCsv,
  runImport,
} from '../../lib/coaImportExport'
import { downloadCsv } from '../../lib/csv'
import Card from '../Card'
import FieldLabel from '../FieldLabel'

const navyBtnCls =
  'inline-block bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed'

const inputCls =
  'w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none'

// Stages: 'idle' | 'previewing' | 'confirming' | 'importing' | 'done' | 'flag-review'
//
//   idle        — file picker and export button visible
//   previewing  — file uploaded + parsed; shows format banner, errors,
//                 preview tree. If errors, user fixes file and retries.
//                 If clean, user proceeds to confirming.
//   confirming  — append/replace radio (if COA non-empty); confirm button
//   importing   — spinner; insert in progress
//   done        — success toast + offer "Review imported accounts"
//   flag-review — bulk grid for setting posting/summary + governance flags

function PreviewRow({ row, depth }) {
  return (
    <div
      className="py-1 flex items-center gap-2 text-sm"
      style={{ paddingLeft: `${depth * 20}px` }}
    >
      <span className="font-body text-muted text-[12px] w-12 tabular-nums flex-shrink-0">
        {row.code || ''}
      </span>
      <span className="text-body flex-1 min-w-0 truncate">{row.name}</span>
      <span className="text-muted text-xs">{row.account_type}</span>
      {!row.posts_directly && (
        <span className="text-muted italic text-xs">summary</span>
      )}
      {row.is_ed_program_dollars && (
        <span className="bg-cream-highlight text-muted px-1.5 py-0.5 rounded text-[10px]">
          ED $
        </span>
      )}
      {row.is_pass_thru && (
        <span className="bg-cream-highlight text-muted px-1.5 py-0.5 rounded text-[10px]">
          PASS-THRU
        </span>
      )}
      {row.is_contribution && (
        <span className="bg-cream-highlight text-muted px-1.5 py-0.5 rounded text-[10px]">
          CONTRIB
        </span>
      )}
    </div>
  )
}

function PreviewTree({ rows }) {
  // Build path map and tree
  const byPath = new Map()
  for (const r of rows) {
    const fullPath = r.subaccount_of ? `${r.subaccount_of}:${r.name}` : r.name
    byPath.set(fullPath, { ...r, fullPath, children: [] })
  }
  const roots = []
  for (const node of byPath.values()) {
    if (node.subaccount_of) {
      const parent = byPath.get(node.subaccount_of)
      if (parent) parent.children.push(node)
      else roots.push(node) // orphan; shouldn't happen if validated
    } else {
      roots.push(node)
    }
  }

  // Sort each level
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

  function renderNode(node, depth) {
    return (
      <div key={node.fullPath}>
        <PreviewRow row={node} depth={depth} />
        {node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className="text-sm font-body bg-white border-[0.5px] border-card-border rounded-[10px] p-4 max-h-[400px] overflow-y-auto">
      {roots.map((r) => renderNode(r, 0))}
    </div>
  )
}

function FlagReviewGrid({ accounts, onSave, onCancel, saving, error }) {
  // Sort accounts in tree (depth-first) order and compute depth-by-id so
  // the Name column can indent to show hierarchy at a glance.
  const { sortedAccounts, depthById } = useMemo(() => {
    const byId = new Map()
    for (const a of accounts) byId.set(a.id, a)

    // Children grouping
    const childrenOf = new Map()
    for (const a of accounts) {
      if (a.parent_id && byId.has(a.parent_id)) {
        const list = childrenOf.get(a.parent_id) || []
        list.push(a)
        childrenOf.set(a.parent_id, list)
      }
    }
    const sortNodes = (list) =>
      list.sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
        const ac = a.code || ''
        const bc = b.code || ''
        if (ac && bc && ac !== bc) return ac.localeCompare(bc)
        return a.name.localeCompare(b.name)
      })
    for (const list of childrenOf.values()) sortNodes(list)

    // Roots: any account whose parent isn't in this batch is a root for
    // display purposes (handles the case where the imported batch is a
    // subset rooted at multiple top-level accounts).
    const roots = accounts.filter(
      (a) => !a.parent_id || !byId.has(a.parent_id)
    )
    sortNodes(roots)

    // DFS traversal collects display order; depth tracked alongside.
    const sortedAccounts = []
    const depthById = new Map()
    function visit(a, depth) {
      depthById.set(a.id, depth)
      sortedAccounts.push(a)
      const kids = childrenOf.get(a.id) || []
      for (const k of kids) visit(k, depth + 1)
    }
    for (const r of roots) visit(r, 0)

    return { sortedAccounts, depthById }
  }, [accounts])

  // Smart defaults: account with subaccounts → summary, else posting. All
  // other flags start false.
  const [edits, setEdits] = useState(() => {
    const childrenOf = new Set()
    for (const a of accounts) {
      if (a.parent_id) childrenOf.add(a.parent_id)
    }
    const m = new Map()
    for (const a of accounts) {
      const hasChildren = childrenOf.has(a.id)
      m.set(a.id, {
        posts_directly: !hasChildren,
        is_pass_thru: false,
        is_ed_program_dollars: false,
        is_contribution: false,
      })
    }
    return m
  })

  function update(id, field, value) {
    setEdits((prev) => {
      const next = new Map(prev)
      const current = next.get(id) || {}
      const updated = { ...current, [field]: value }

      // Switching to summary clears all flags (DB trigger would reject otherwise).
      if (field === 'posts_directly' && !value) {
        updated.is_pass_thru = false
        updated.is_ed_program_dollars = false
        updated.is_contribution = false
      }
      // Pass-Thru and (Ed Program $ / Contribution) are mutually exclusive.
      // Whichever the user just checked wins; the others auto-clear.
      if (field === 'is_pass_thru' && value) {
        updated.is_ed_program_dollars = false
        updated.is_contribution = false
      }
      if ((field === 'is_ed_program_dollars' || field === 'is_contribution') && value) {
        updated.is_pass_thru = false
      }

      next.set(id, updated)
      return next
    })
  }

  function handleSave() {
    onSave(edits)
  }

  return (
    <div className="space-y-4">
      <div className="bg-cream-highlight border-[0.5px] border-card-border rounded p-4 text-sm space-y-1">
        <p className="text-body">
          Review the imported accounts. Set each as a <strong className="font-medium">Posting</strong> account
          (where transactions actually post in your books) or <strong className="font-medium">Summary</strong> account
          (pure rollup of subaccounts that doesn't receive direct posts). For
          posting income accounts, mark which count toward Ed Program Dollars or
          Contributions for KPI reporting. Pass-thru accounts (money collected
          on behalf of others — e.g., field-trip fees that pass to a vendor)
          should be marked Pass-Thru and are excluded from operating budget
          totals.
        </p>
        <p className="text-muted italic text-xs">
          Defaults are pre-filled — accounts with no subaccounts default to posting,
          others to summary. Override as needed.
        </p>
      </div>

      <Card className="!p-0 overflow-hidden">
        {/* Inner scroll container so sticky headers stick relative to this
            box (the Card's overflow-hidden would otherwise prevent sticky
            from finding a vertical scroll context). max-h-[65vh] gives ~15
            visible rows on a typical desktop and lets the rest scroll
            within the grid while the column headers stay pinned. */}
        <div className="overflow-auto max-h-[65vh]">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-3 py-2 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-muted">
                  Code
                </th>
                <th className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-3 py-2 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-muted">
                  Name
                </th>
                <th className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-3 py-2 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-muted">
                  Type
                </th>
                <th className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-3 py-2 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-muted">
                  Kind
                </th>
                <th className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-3 py-2 text-center font-display text-[13px] tracking-[0.08em] uppercase font-normal text-muted">
                  Pass-Thru
                </th>
                <th className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-3 py-2 text-center font-display text-[13px] tracking-[0.08em] uppercase font-normal text-muted">
                  Ed Program $
                </th>
                <th className="sticky top-0 z-10 bg-cream-highlight border-b-[0.5px] border-card-border px-3 py-2 text-center font-display text-[13px] tracking-[0.08em] uppercase font-normal text-muted">
                  Contribution
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedAccounts.map((a, i) => {
                const e = edits.get(a.id) || {}
                const depth = depthById.get(a.id) || 0
                const isIncome = a.account_type === 'income'
                const summaryDisabledFlags = !e.posts_directly
                // Pass-Thru and (Ed Program $ / Contribution) are mutually
                // exclusive. Disable Pass-Thru if either of those is checked,
                // and vice versa.
                const passThruDisabled =
                  summaryDisabledFlags ||
                  e.is_ed_program_dollars ||
                  e.is_contribution
                const edContribDisabled =
                  summaryDisabledFlags || !isIncome || e.is_pass_thru
                return (
                  <tr
                    key={a.id}
                    className={`border-t-[0.5px] border-card-border font-body text-body ${i % 2 === 1 ? 'bg-alt-row' : 'bg-white'}`}
                  >
                    <td className="px-3 py-2 tabular-nums text-muted">
                      {a.code || ''}
                    </td>
                    <td className="px-3 py-2 text-navy">
                      <span style={{ paddingLeft: `${depth * 16}px` }}>
                        {a.name}
                      </span>
                    </td>
                    <td className="px-3 py-2 capitalize">{a.account_type}</td>
                    <td className="px-3 py-2">
                      <select
                        value={e.posts_directly ? 'posting' : 'summary'}
                        onChange={(ev) =>
                          update(a.id, 'posts_directly', ev.target.value === 'posting')
                        }
                        className="bg-white border-[0.5px] border-card-border text-body px-2 py-1 rounded text-xs focus:border-navy focus:outline-none cursor-pointer"
                      >
                        <option value="posting">Posting</option>
                        <option value="summary">Summary</option>
                      </select>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={e.is_pass_thru}
                        disabled={passThruDisabled}
                        onChange={(ev) =>
                          update(a.id, 'is_pass_thru', ev.target.checked)
                        }
                        className="accent-navy"
                      />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={e.is_ed_program_dollars}
                        disabled={edContribDisabled}
                        onChange={(ev) =>
                          update(a.id, 'is_ed_program_dollars', ev.target.checked)
                        }
                        className="accent-navy"
                      />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={e.is_contribution}
                        disabled={edContribDisabled}
                        onChange={(ev) =>
                          update(a.id, 'is_contribution', ev.target.checked)
                        }
                        className="accent-navy"
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {error && (
        <p className="text-status-red text-sm" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className={navyBtnCls}
        >
          {saving ? 'Saving…' : 'Save all'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-muted hover:text-navy text-sm"
        >
          Skip for now
        </button>
      </div>
    </div>
  )
}

function ImportExportPanel({ accounts, onClose, onImported }) {
  const { user } = useAuth()
  const { allowed: canImport } = useModulePermission(
    'chart_of_accounts',
    'admin'
  )

  const [stage, setStage] = useState('idle')
  const [parseError, setParseError] = useState(null) // 'unrecognized-format' | 'empty-file' | string
  const [parseFoundColumns, setParseFoundColumns] = useState([])
  const [parsed, setParsed] = useState(null) // { format, rows, rejected }
  const [acknowledgedRejected, setAcknowledgedRejected] = useState(false)
  const [validation, setValidation] = useState(null) // { errors, warnings }
  const [mode, setMode] = useState('append')
  const [replaceConfirmed, setReplaceConfirmed] = useState(false)
  const [importError, setImportError] = useState(null)
  const [importSummary, setImportSummary] = useState(null) // { insertedCount, format, insertedIds }
  const [savingFlags, setSavingFlags] = useState(false)

  const hasExistingAccounts = accounts.length > 0

  // ---- Export -----------------------------------------------------------
  function handleExport() {
    const csv = generateExportCsv(accounts)
    downloadCsv(generateExportFilename(), csv)
  }

  function handleDownloadTemplate() {
    downloadCsv('agora_coa_template.csv', generateTemplateCsv())
  }

  // ---- Import: file upload ----------------------------------------------
  async function handleFile(file) {
    if (!file) return
    setParseError(null)
    setParseFoundColumns([])
    setParsed(null)
    setAcknowledgedRejected(false)
    setValidation(null)
    setImportError(null)
    setImportSummary(null)

    const text = await file.text()
    const result = parseAndNormalize(text)
    if (result.error) {
      setParseError(result.error)
      setParseFoundColumns(result.foundColumns || [])
      return
    }
    if (result.rows.length === 0 && result.rejected.length === 0) {
      setParseError('No importable rows found in the file.')
      return
    }
    const v = validateRows(result.rows)
    setParsed(result)
    setValidation(v)
    setStage('previewing')
  }

  function resetUpload() {
    setStage('idle')
    setParseError(null)
    setParseFoundColumns([])
    setParsed(null)
    setAcknowledgedRejected(false)
    setValidation(null)
    setMode('append')
    setReplaceConfirmed(false)
    setImportError(null)
    setImportSummary(null)
  }

  function proceedFromPreview() {
    if (validation?.errors?.length > 0) return
    if (parsed?.rejected?.length > 0 && !acknowledgedRejected) return
    setStage('confirming')
  }

  async function loadAccountsByIds(ids) {
    if (!ids || ids.length === 0) return []
    const { data } = await supabase
      .from('chart_of_accounts')
      .select('*')
      .in('id', ids)
      .order('sort_order', { ascending: true })
    return data || []
  }

  async function handleConfirmImport() {
    if (mode === 'replace' && !replaceConfirmed) return
    setImportError(null)
    setStage('importing')

    // For replace mode, auto-download backup first
    if (mode === 'replace' && hasExistingAccounts) {
      const backup = generateExportCsv(accounts)
      downloadCsv(`backup_${generateExportFilename()}`, backup)
    }

    try {
      const result = await runImport({
        rows: parsed.rows,
        mode: hasExistingAccounts ? mode : 'append',
        existingAccounts: accounts,
        supabase,
        userId: user?.id,
      })
      setImportSummary({ ...result, format: parsed.format })
      onImported?.()

      // QBO format imports auto-route to the guided flag review grid:
      // QBO files don't carry posting/summary or governance flags, so
      // configuring those is mandatory next-step work. For generic-format
      // imports the flags came in via the CSV, so we land on the success
      // page with an optional review button.
      if (parsed.format === 'quickbooks' && result.insertedCount > 0) {
        const acc = await loadAccountsByIds(result.insertedIds)
        setFlagReviewAccounts(acc)
        setStage('flag-review')
      } else {
        setStage('done')
      }
    } catch (err) {
      setImportError(err.message || String(err))
      setStage('previewing')
    }
  }

  const [flagReviewAccounts, setFlagReviewAccounts] = useState([])
  async function openFlagReview() {
    // Manual entry from the success page (generic-format path).
    const acc = await loadAccountsByIds(importSummary?.insertedIds)
    setFlagReviewAccounts(acc)
    setStage('flag-review')
  }

  async function handleSaveFlags(edits) {
    setSavingFlags(true)
    setImportError(null)
    try {
      // Apply each edit. Could parallelize, but keeping sequential for
      // clearer error attribution if any one fails.
      for (const [id, e] of edits.entries()) {
        const original = flagReviewAccounts.find((a) => a.id === id)
        if (!original) continue
        const changed =
          original.posts_directly !== e.posts_directly ||
          original.is_pass_thru !== e.is_pass_thru ||
          original.is_ed_program_dollars !== e.is_ed_program_dollars ||
          original.is_contribution !== e.is_contribution
        if (!changed) continue
        const { error } = await supabase
          .from('chart_of_accounts')
          .update({
            posts_directly: e.posts_directly,
            is_pass_thru: e.is_pass_thru,
            is_ed_program_dollars: e.is_ed_program_dollars,
            is_contribution: e.is_contribution,
            updated_by: user?.id,
          })
          .eq('id', id)
        if (error) throw error
      }
      onImported?.()
      // Close the panel — return to the financial settings page with the
      // populated and now-flagged tree.
      onClose?.()
    } catch (err) {
      setImportError(err.message || String(err))
    } finally {
      setSavingFlags(false)
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-[13px] text-navy tracking-[0.08em] uppercase font-normal">
          Import / Export
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-navy text-sm"
        >
          Close
        </button>
      </div>

      {stage === 'idle' && (
        <div className="space-y-6">
          {/* Export */}
          <section>
            <FieldLabel>Export current COA</FieldLabel>
            <p className="text-body text-sm mb-3">
              Backs up the current Chart of Accounts. Can be re-imported into
              this or another instance.
            </p>
            <button
              type="button"
              onClick={handleExport}
              disabled={accounts.length === 0}
              className={navyBtnCls}
            >
              Download COA as CSV
            </button>
            {accounts.length === 0 && (
              <p className="text-muted text-xs italic mt-2">
                No accounts to export yet.
              </p>
            )}
          </section>

          {/* Import */}
          {canImport && (
            <section className="border-t-[0.5px] border-card-border pt-6">
              <FieldLabel>Import COA from CSV</FieldLabel>
              <p className="text-body text-sm mb-3 leading-relaxed">
                Upload an account list exported from your accounting software,
                or an Agora generic CSV. Format is auto-detected. Need a
                starting point? Download the template below.
              </p>

              {/* Template download */}
              <div className="mb-4 flex items-center gap-3 text-sm">
                <button
                  type="button"
                  onClick={handleDownloadTemplate}
                  className="text-status-blue hover:underline"
                >
                  ↓ Download CSV template
                </button>
                <span className="text-muted text-xs italic">
                  Example rows showing the expected format. Replace them with your real Chart of Accounts before uploading.
                </span>
              </div>

              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => handleFile(e.target.files?.[0])}
                className="text-sm"
              />

              {parseError === 'unrecognized-format' ? (
                <div
                  className="mt-3 bg-status-red-bg border-[0.5px] border-status-red rounded p-3 text-sm space-y-2"
                  role="alert"
                >
                  <p className="font-medium text-status-red">
                    Format not recognized.
                  </p>
                  {parseFoundColumns.length > 0 && (
                    <div>
                      <p className="text-muted text-xs uppercase tracking-wider">
                        Found columns:
                      </p>
                      <p className="font-body text-body text-xs mt-0.5">
                        {parseFoundColumns.slice(0, 8).join(', ')}
                        {parseFoundColumns.length > 8 &&
                          ` (and ${parseFoundColumns.length - 8} more)`}
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="text-muted text-xs uppercase tracking-wider mb-1">
                      Expected one of:
                    </p>
                    <ul className="list-disc list-inside text-body text-xs space-y-0.5">
                      <li>
                        <strong className="font-medium">Standard account list format</strong> — columns: Account #, Full name, Type, Detail type
                      </li>
                      <li>
                        <strong className="font-medium">Agora generic format</strong> — columns: code, subaccount_of, name, account_type, posts_directly, is_pass_thru, is_ed_program_dollars, is_contribution, sort_order, is_active, notes
                      </li>
                    </ul>
                  </div>
                  <p className="text-xs text-body">
                    To see the Agora generic format,{' '}
                    <button
                      type="button"
                      onClick={handleDownloadTemplate}
                      className="text-status-blue underline"
                    >
                      download the template
                    </button>
                    .
                  </p>
                </div>
              ) : parseError === 'empty-file' ? (
                <p className="text-status-red text-sm mt-3" role="alert">
                  The file is empty.
                </p>
              ) : parseError ? (
                <p className="text-status-red text-sm mt-3" role="alert">
                  {parseError}
                </p>
              ) : null}
            </section>
          )}
        </div>
      )}

      {stage === 'previewing' && parsed && validation && (
        <div className="space-y-4">
          <div className="bg-cream-highlight border-[0.5px] border-card-border rounded p-3 text-sm">
            <p className="text-body">
              Detected:{' '}
              <strong className="font-medium">
                {parsed.format === 'quickbooks'
                  ? 'QuickBooks Account List'
                  : 'Generic Agora format'}
              </strong>
              . {parsed.rows.length} account{parsed.rows.length === 1 ? '' : 's'} ready to import.
            </p>
          </div>

          {validation.errors.length > 0 && (
            <div className="bg-status-red-bg border-[0.5px] border-status-red rounded p-3 text-sm">
              <p className="font-medium text-status-red mb-2">
                {validation.errors.length} error
                {validation.errors.length === 1 ? '' : 's'} — fix the file and
                re-upload:
              </p>
              <ul className="list-disc list-inside text-body space-y-1">
                {validation.errors.slice(0, 10).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
              {validation.errors.length > 10 && (
                <p className="text-muted italic text-xs mt-2">
                  …and {validation.errors.length - 10} more.
                </p>
              )}
            </div>
          )}

          {parsed.rejected.length > 0 && (
            <div className="bg-status-amber-bg border-[0.5px] border-status-amber rounded p-3 text-sm">
              <p className="font-medium text-status-amber mb-2">
                {parsed.rejected.length} row
                {parsed.rejected.length === 1 ? '' : 's'} cannot be imported
                (balance-sheet accounts, not used for budgeting):
              </p>
              <ul className="list-disc list-inside text-body space-y-1 mb-3">
                {parsed.rejected.slice(0, 10).map((r, i) => (
                  <li key={i}>
                    Row {r.lineNo}: <strong className="font-medium">{r.name}</strong> ({r.type})
                  </li>
                ))}
              </ul>
              {parsed.rejected.length > 10 && (
                <p className="text-muted italic text-xs mb-2">
                  …and {parsed.rejected.length - 10} more.
                </p>
              )}
              <p className="text-body text-xs italic">
                Agora is a budgeting tool — only Income and Expense accounts are imported.
                Skip these rows to proceed with the {parsed.rows.length} valid account
                {parsed.rows.length === 1 ? '' : 's'}, or cancel to filter your CSV first.
              </p>
            </div>
          )}

          {validation.warnings.length > 0 && (
            <div className="bg-cream-highlight border-[0.5px] border-card-border rounded p-3 text-sm">
              <ul className="list-disc list-inside text-body space-y-1">
                {validation.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {validation.errors.length === 0 && parsed.rows.length > 0 && (
            <>
              <FieldLabel>Preview</FieldLabel>
              <PreviewTree rows={parsed.rows} />
            </>
          )}

          {importError && (
            <p className="text-status-red text-sm" role="alert">
              {importError}
            </p>
          )}

          <div className="flex items-center gap-4">
            {validation.errors.length === 0 && parsed.rows.length > 0 && (
              <>
                {parsed.rejected.length > 0 && !acknowledgedRejected ? (
                  <button
                    type="button"
                    onClick={() => {
                      setAcknowledgedRejected(true)
                      setStage('confirming')
                    }}
                    className={navyBtnCls}
                  >
                    Skip {parsed.rejected.length} row{parsed.rejected.length === 1 ? '' : 's'} and continue
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={proceedFromPreview}
                    className={navyBtnCls}
                  >
                    Continue
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              onClick={resetUpload}
              className="text-muted hover:text-navy text-sm"
            >
              {parsed.rejected.length > 0 ? 'Cancel and edit the CSV' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {stage === 'confirming' && (
        <div className="space-y-4">
          {hasExistingAccounts ? (
            <>
              <FieldLabel>Conflict mode</FieldLabel>
              <div className="space-y-3 text-sm">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === 'append'}
                    onChange={() => setMode('append')}
                    className="accent-navy mt-0.5"
                  />
                  <span>
                    <strong className="font-medium">Append</strong>
                    <span className="text-muted ml-2">
                      — Add new accounts to the existing COA. The import will
                      fail if any imported account's code or path conflicts
                      with an existing one.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === 'replace'}
                    onChange={() => setMode('replace')}
                    className="accent-navy mt-0.5"
                  />
                  <span>
                    <strong className="font-medium">Replace</strong>
                    <span className="text-muted ml-2">
                      — Delete all existing accounts and replace with imported.
                      <strong className="text-status-red font-medium ml-1">
                        Caution: this is destructive and cannot be undone.
                      </strong>{' '}
                      Your current COA will be auto-downloaded as a backup
                      before deletion.
                    </span>
                  </span>
                </label>
                {mode === 'replace' && (
                  <label className="flex items-start gap-2 cursor-pointer pl-6">
                    <input
                      type="checkbox"
                      checked={replaceConfirmed}
                      onChange={(e) => setReplaceConfirmed(e.target.checked)}
                      className="accent-navy mt-0.5"
                    />
                    <span className="text-status-red text-sm">
                      I understand this will delete all existing accounts.
                    </span>
                  </label>
                )}
              </div>
            </>
          ) : (
            <p className="text-body text-sm">
              The COA is empty. {parsed.rows.length} account
              {parsed.rows.length === 1 ? '' : 's'} will be imported.
            </p>
          )}

          {importError && (
            <p className="text-status-red text-sm" role="alert">
              {importError}
            </p>
          )}

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={handleConfirmImport}
              disabled={mode === 'replace' && !replaceConfirmed}
              className={navyBtnCls}
            >
              Import
            </button>
            <button
              type="button"
              onClick={() => setStage('previewing')}
              className="text-muted hover:text-navy text-sm"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {stage === 'importing' && (
        <p className="text-muted text-sm">Importing accounts…</p>
      )}

      {stage === 'done' && importSummary && (
        <div className="space-y-4">
          <div className="bg-status-green-bg border-[0.5px] border-status-green rounded p-3 text-sm">
            <p className="text-body">
              <strong className="font-medium">Imported {importSummary.insertedCount} account
              {importSummary.insertedCount === 1 ? '' : 's'}.</strong>
              {importSummary.format === 'quickbooks' && (
                <span className="text-muted italic">
                  {' '}Account list exports from accounting software don't
                  carry posting/summary or governance flags — review them next.
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={openFlagReview}
              className={navyBtnCls}
            >
              Review imported accounts
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-muted hover:text-navy text-sm"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {stage === 'flag-review' && flagReviewAccounts.length > 0 && (
        <FlagReviewGrid
          accounts={flagReviewAccounts}
          saving={savingFlags}
          error={importError}
          onSave={handleSaveFlags}
          onCancel={onClose}
        />
      )}
    </Card>
  )
}

export default ImportExportPanel
