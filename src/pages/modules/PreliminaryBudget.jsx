import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import {
  createBlankScenario,
  createScenarioFromCsvRows,
  createScenarioFromPriorAye,
} from '../../lib/budgetBootstrap'
import {
  buildBudgetTree,
  computeKpis,
  findUnbudgetedAccounts,
} from '../../lib/budgetTree'
import AppShell from '../../components/AppShell'
import AYESelector from '../../components/AYESelector'
import Breadcrumb from '../../components/Breadcrumb'
import Badge from '../../components/Badge'
import KpiSidebar from '../../components/budget/KpiSidebar'
import BudgetEmptyState from '../../components/budget/BudgetEmptyState'
import CsvImportModal from '../../components/budget/CsvImportModal'
import BudgetDetailZone from '../../components/budget/BudgetDetailZone'
import AutoDetectBanner from '../../components/budget/AutoDetectBanner'
import AddAccountModal from '../../components/budget/AddAccountModal'

// Preliminary Budget — three-zone shell (header + KPI sidebar + detail).
//
// Commit B shipped: bootstrap flow (Start with $0 / Upload CSV /
// Bootstrap from prior AYE), the three-zone shell, KPI sidebar
// scaffold, and a placeholder detail card.
//
// Commit C (this commit) wires:
//   - real KPI computation in the sidebar
//   - hierarchical Display Style A render in the detail zone with
//     direct-edit-with-undo on amount cells (Tab/Shift+Tab/Esc/Cmd+Z)
//   - auto-detect banner: accounts in COA but not in this budget
//   - inline add-account (Pattern 1): same AccountForm as COA mgmt
//
// Commit D adds multi-scenario tabs; for now the page assumes one
// scenario per AYE.

const STATE_BADGES = {
  drafting: { label: 'DRAFTING', variant: 'navy' },
  pending_lock_review: { label: 'PENDING LOCK REVIEW', variant: 'amber' },
  locked: { label: 'LOCKED', variant: 'green' },
  pending_unlock_review: { label: 'PENDING UNLOCK REVIEW', variant: 'amber' },
}

function StateBadge({ state }) {
  const cfg = STATE_BADGES[state]
  if (!cfg) return null
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>
}

function ActionButton({ label, disabled, primary, onClick }) {
  const base =
    'border-[0.5px] px-3.5 py-2 rounded text-sm font-body transition-colors'
  const cls = disabled
    ? 'border-card-border bg-white/50 text-muted/60 cursor-not-allowed'
    : primary
      ? 'border-navy bg-navy text-gold hover:opacity-90 cursor-pointer'
      : 'border-card-border bg-white text-navy hover:bg-cream-highlight cursor-pointer'
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${cls}`}>
      {label}
    </button>
  )
}

function HeaderZone({
  ayeLabel,
  selectedAyeId,
  onAyeChange,
  scenario,
  onResetClick,
  onAddAccountClick,
  resetting,
  canEdit,
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    function close() { setMenuOpen(false) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuOpen])

  return (
    <header className="sticky top-0 z-20 bg-cream pt-1 pb-3 -mt-1 border-b-[0.5px] border-card-border">
      <Breadcrumb items={[{ label: 'Budget' }, { label: 'Preliminary Budget' }]} />

      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="font-display text-navy text-[26px] leading-tight">
            {ayeLabel ? `${ayeLabel} Preliminary Budget` : 'Preliminary Budget'}
          </h1>
          {scenario && <StateBadge state={scenario.state} />}
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <AYESelector value={selectedAyeId} onChange={onAyeChange} />

          <div className="flex items-center gap-2">
            {scenario && canEdit && (
              <ActionButton label="+ Add Account" onClick={onAddAccountClick} />
            )}
            <ActionButton disabled label="Save" />
            <ActionButton disabled label="View PDF" />
            <ActionButton disabled label="Submit for Lock Review" primary />

            {scenario && (
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen((v) => !v)
                  }}
                  aria-label="Scenario actions"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className="bg-white border-[0.5px] border-card-border text-navy px-2.5 py-2 rounded text-sm hover:bg-cream-highlight transition-colors cursor-pointer"
                >
                  ⋮
                </button>
                {menuOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    role="menu"
                    className="absolute right-0 mt-1 w-56 bg-white border-[0.5px] border-card-border rounded-[8px] shadow-lg z-30 py-1"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        onResetClick()
                      }}
                      disabled={resetting || scenario.state !== 'drafting'}
                      className="w-full text-left px-4 py-2 font-body text-sm text-status-red hover:bg-status-red-bg disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Reset scenario…
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}

function PreliminaryBudget() {
  const { user } = useAuth()
  const { allowed: canView, loading: permLoading } = useModulePermission(
    'preliminary_budget',
    'view'
  )
  const { allowed: canEdit } = useModulePermission(
    'preliminary_budget',
    'edit'
  )
  const { allowed: canEditCoa } = useModulePermission(
    'chart_of_accounts',
    'edit'
  )

  const [selectedAyeId, setSelectedAyeId] = useState(null)
  const [aye, setAye] = useState(null)

  // Live scenario + line + account state. accounts is the full COA;
  // lines are scoped to the active scenario.
  const [scenario, setScenario] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [lines, setLines] = useState([])

  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError] = useState(null)

  // Bootstrap-flow state.
  const [creating, setCreating] = useState(false)
  const [bootstrapError, setBootstrapError] = useState(null)
  const [bootstrapNotice, setBootstrapNotice] = useState(null)
  const [csvOpen, setCsvOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  // Add-account modal state.
  const [addAccountOpen, setAddAccountOpen] = useState(false)

  // Auto-detect banner: per-session dismiss flag (resets on reload).
  const [autoDetectDismissed, setAutoDetectDismissed] = useState(false)

  // In-session undo stack for amount edits. Each entry:
  //   { accountId, prevAmount }
  // Cmd+Z pops the latest and writes prevAmount back.
  const [undoStack, setUndoStack] = useState([])

  // Toast-style success message that fades out (handled by clearing on
  // next action). Used for inline-add success feedback.
  const [toast, setToast] = useState(null)

  // ---- data load -------------------------------------------------------

  const loadAll = useCallback(async (ayeId) => {
    setDataLoading(true)
    setDataError(null)
    setBootstrapError(null)
    setBootstrapNotice(null)

    const [ayeResult, scenarioResult, accountsResult] = await Promise.all([
      supabase
        .from('academic_years')
        .select('id, label')
        .eq('id', ayeId)
        .single(),
      supabase
        .from('preliminary_budget_scenarios')
        .select('id, scenario_label, description, is_recommended, state, narrative, show_narrative_in_pdf')
        .eq('aye_id', ayeId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('chart_of_accounts')
        .select('id, code, name, parent_id, account_type, posts_directly, is_pass_thru, is_active, is_ed_program_dollars, is_contribution, sort_order')
        .order('sort_order', { ascending: true })
        .order('code', { ascending: true }),
    ])

    if (ayeResult.error)      { setDataError(ayeResult.error.message);      setDataLoading(false); return }
    if (scenarioResult.error) { setDataError(scenarioResult.error.message); setDataLoading(false); return }
    if (accountsResult.error) { setDataError(accountsResult.error.message); setDataLoading(false); return }

    setAye(ayeResult.data)
    setScenario(scenarioResult.data || null)
    setAccounts(accountsResult.data || [])

    if (scenarioResult.data) {
      const { data: lineRows, error: linesErr } = await supabase
        .from('preliminary_budget_lines')
        .select('id, scenario_id, account_id, amount, source_type, notes')
        .eq('scenario_id', scenarioResult.data.id)
      if (linesErr) {
        setDataError(linesErr.message)
        setDataLoading(false)
        return
      }
      setLines(lineRows || [])
    } else {
      setLines([])
    }

    setDataLoading(false)
  }, [])

  useEffect(() => {
    if (!selectedAyeId || !canView) return
    let mounted = true
    ;(async () => {
      await loadAll(selectedAyeId)
      if (!mounted) return
    })()
    return () => { mounted = false }
  }, [selectedAyeId, canView, loadAll])

  // ---- derived values --------------------------------------------------

  const tree = useMemo(
    () => buildBudgetTree(accounts, lines),
    [accounts, lines]
  )

  const kpis = useMemo(() => {
    if (!scenario) return null
    return computeKpis(accounts, lines)
  }, [accounts, lines, scenario])

  const unbudgeted = useMemo(() => {
    if (!scenario || autoDetectDismissed) return []
    return findUnbudgetedAccounts(accounts, lines)
  }, [accounts, lines, scenario, autoDetectDismissed])

  // ---- bootstrap handlers ----------------------------------------------

  async function handleStartBlank() {
    setCreating(true)
    setBootstrapError(null)
    setBootstrapNotice(null)
    try {
      await createBlankScenario({ ayeId: selectedAyeId, userId: user?.id })
      await loadAll(selectedAyeId)
    } catch (e) {
      setBootstrapError(e.message || String(e))
    } finally {
      setCreating(false)
    }
  }

  async function handleBootstrapPrior(probeResult) {
    setCreating(true)
    setBootstrapError(null)
    setBootstrapNotice(null)
    try {
      const result = await createScenarioFromPriorAye({
        ayeId: selectedAyeId,
        userId: user?.id,
        priorSnapshotId: probeResult.snapshot.id,
      })
      if (result.skippedNames && result.skippedNames.length > 0) {
        const list = result.skippedNames.slice(0, 6).join(', ')
        const more =
          result.skippedNames.length > 6
            ? ` and ${result.skippedNames.length - 6} more`
            : ''
        setBootstrapNotice(
          `${result.skippedNames.length} account(s) from the prior budget are no longer in your Chart of Accounts and were skipped: ${list}${more}.`
        )
      }
      await loadAll(selectedAyeId)
    } catch (e) {
      setBootstrapError(e.message || String(e))
    } finally {
      setCreating(false)
    }
  }

  async function handleCsvConfirm(rows) {
    setBootstrapError(null)
    setBootstrapNotice(null)
    await createScenarioFromCsvRows({
      ayeId: selectedAyeId,
      userId: user?.id,
      rows,
    })
    setCsvOpen(false)
    await loadAll(selectedAyeId)
  }

  async function handleResetScenario() {
    if (!scenario) return
    if (!window.confirm(
      `Reset "${scenario.scenario_label}"? All ${lines.length} line(s) will be deleted ` +
      `and the scenario will return to the empty start prompt.`
    )) {
      return
    }
    setResetting(true)
    setDataError(null)
    try {
      // Delete lines first (cascade also handles this if we drop the
      // scenario, but explicit delete makes the audit-log clearer).
      const { error: linesErr } = await supabase
        .from('preliminary_budget_lines')
        .delete()
        .eq('scenario_id', scenario.id)
      if (linesErr) throw linesErr
      const { error: scenarioErr } = await supabase
        .from('preliminary_budget_scenarios')
        .delete()
        .eq('id', scenario.id)
      if (scenarioErr) throw scenarioErr
      setScenario(null)
      setLines([])
      setUndoStack([])
    } catch (e) {
      setDataError(e.message || String(e))
    } finally {
      setResetting(false)
    }
  }

  // ---- editing ---------------------------------------------------------

  // Persist a single amount edit. Optimistic UI: update local state
  // immediately, then push to DB. On DB error, revert + surface message.
  // Called from BudgetDetailZone's onSaveAmount and from undo.
  const handleSaveAmount = useCallback(
    async (accountId, newAmount, prevAmount, { skipUndoPush = false } = {}) => {
      // If unchanged, skip the round-trip entirely.
      if (newAmount === prevAmount) return

      const targetLine = lines.find((l) => l.account_id === accountId)
      if (!targetLine) {
        setDataError(`No budget line found for account ${accountId}`)
        return
      }

      // Optimistic local update
      setLines((prev) =>
        prev.map((l) =>
          l.id === targetLine.id ? { ...l, amount: newAmount } : l
        )
      )

      const { error } = await supabase
        .from('preliminary_budget_lines')
        .update({ amount: newAmount, updated_by: user?.id })
        .eq('id', targetLine.id)

      if (error) {
        // Revert
        setLines((prev) =>
          prev.map((l) =>
            l.id === targetLine.id ? { ...l, amount: prevAmount } : l
          )
        )
        setDataError(error.message)
        return
      }

      if (!skipUndoPush) {
        setUndoStack((prev) => [...prev, { accountId, prevAmount }])
      }
    },
    [lines, user?.id]
  )

  const handleUndo = useCallback(async () => {
    if (undoStack.length === 0) return
    const last = undoStack[undoStack.length - 1]
    setUndoStack((prev) => prev.slice(0, -1))
    const targetLine = lines.find((l) => l.account_id === last.accountId)
    const currentAmount = targetLine ? Number(targetLine.amount) || 0 : 0
    await handleSaveAmount(last.accountId, last.prevAmount, currentAmount, {
      skipUndoPush: true,
    })
  }, [undoStack, lines, handleSaveAmount])

  // ---- auto-detect: add selected unbudgeted accounts at $0 -------------

  async function handleAddUnbudgeted(accountIds) {
    if (!scenario) return
    const newLines = accountIds.map((id) => ({
      scenario_id: scenario.id,
      account_id: id,
      amount: 0,
      source_type: 'manual',
      created_by: user?.id,
      updated_by: user?.id,
    }))
    const { error } = await supabase
      .from('preliminary_budget_lines')
      .insert(newLines)
    if (error) throw error
    await loadAll(selectedAyeId)
  }

  // ---- add-account success ---------------------------------------------

  async function handleAddAccountSuccess(message) {
    setToast(message)
    // Clear toast after a few seconds; keep the auto-clear simple.
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 5000)
    await loadAll(selectedAyeId)
  }
  const toastTimer = useRef(null)
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  // ------- render branches ----------------------------------------------

  if (permLoading) {
    return (
      <AppShell>
        <p className="text-muted">Loading…</p>
      </AppShell>
    )
  }

  if (!canView) {
    return (
      <AppShell>
        <Breadcrumb items={[{ label: 'Budget' }, { label: 'Preliminary Budget' }]} />
        <h1 className="font-display text-navy text-[28px] mb-3 leading-tight">
          You don't have access to this module.
        </h1>
        <p className="text-body mb-6">
          Preliminary Budget access requires the appropriate module permission.
        </p>
        <Link
          to="/dashboard"
          className="inline-block bg-navy text-gold px-4 py-2 rounded text-sm hover:opacity-90 transition-opacity"
        >
          Back to Dashboard
        </Link>
      </AppShell>
    )
  }

  const readOnly = !canEdit || (scenario && scenario.state !== 'drafting')

  return (
    <AppShell>
      <div className="-mx-6 -my-6 flex flex-col h-[calc(100vh-3.5rem)]">
        <div className="px-6">
          <HeaderZone
            ayeLabel={aye?.label}
            selectedAyeId={selectedAyeId}
            onAyeChange={setSelectedAyeId}
            scenario={scenario}
            onResetClick={handleResetScenario}
            onAddAccountClick={() => setAddAccountOpen(true)}
            resetting={resetting}
            canEdit={canEdit && canEditCoa}
          />
        </div>

        <div className="flex-1 flex overflow-hidden">
          <KpiSidebar kpis={kpis} />

          <div className="flex-1 overflow-y-auto px-6 py-2">
            {dataError && (
              <p className="text-status-red text-sm mb-4" role="alert">
                {dataError}
              </p>
            )}

            {bootstrapNotice && (
              <div
                className="mb-4 px-3 py-2 bg-status-amber-bg border-[0.5px] border-status-amber/30 rounded text-status-amber text-sm"
                role="status"
              >
                {bootstrapNotice}
              </div>
            )}

            {toast && (
              <div
                className="mb-4 px-3 py-2 bg-status-green-bg border-[0.5px] border-status-green/30 rounded text-status-green text-sm"
                role="status"
              >
                {toast}
              </div>
            )}

            {!selectedAyeId ? (
              <p className="text-muted italic mt-8">
                Pick an academic year to begin.
              </p>
            ) : dataLoading ? (
              <p className="text-muted mt-8">Loading…</p>
            ) : !scenario ? (
              canEdit ? (
                <BudgetEmptyState
                  ayeId={selectedAyeId}
                  ayeLabel={aye?.label}
                  onAyeChange={setSelectedAyeId}
                  onStartBlank={handleStartBlank}
                  onUploadCsv={() => setCsvOpen(true)}
                  onBootstrapPrior={handleBootstrapPrior}
                  creating={creating}
                  error={bootstrapError}
                />
              ) : (
                <p className="text-muted italic mt-8">
                  No budget exists for {aye?.label || 'this AYE'} yet. You
                  need <strong>edit</strong> permission to start one.
                </p>
              )
            ) : (
              <>
                {!autoDetectDismissed && unbudgeted.length > 0 && (
                  <AutoDetectBanner
                    missing={unbudgeted}
                    onAdd={handleAddUnbudgeted}
                    sessionDismiss={() => setAutoDetectDismissed(true)}
                  />
                )}

                <BudgetDetailZone
                  tree={tree}
                  readOnly={readOnly}
                  onSaveAmount={(accountId, newAmount, prevAmount) =>
                    handleSaveAmount(accountId, newAmount, prevAmount)
                  }
                  onUndo={handleUndo}
                  undoAvailable={undoStack.length > 0}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {csvOpen && (
        <CsvImportModal
          ayeLabel={aye?.label}
          onCancel={() => setCsvOpen(false)}
          onConfirm={handleCsvConfirm}
        />
      )}

      {addAccountOpen && scenario && (
        <AddAccountModal
          accounts={accounts}
          scenarioId={scenario.id}
          userId={user?.id}
          onClose={() => setAddAccountOpen(false)}
          onSuccess={handleAddAccountSuccess}
        />
      )}
    </AppShell>
  )
}

export default PreliminaryBudget
