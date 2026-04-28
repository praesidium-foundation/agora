import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
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
import {
  approveAndLockScenario,
  rejectScenarioLock,
  submitScenarioForLockReview,
} from '../../lib/budgetLock'
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
import ScenarioTabs from '../../components/budget/ScenarioTabs'
import NewScenarioModal from '../../components/budget/NewScenarioModal'
import ScenarioSettingsModal from '../../components/budget/ScenarioSettingsModal'
import SubmitLockModal from '../../components/budget/SubmitLockModal'
import ApproveLockBar from '../../components/budget/ApproveLockBar'
import LockedBanner from '../../components/budget/LockedBanner'

// Stage-aware Budget page. The Budget module supports configurable
// workflows (Migration 010 / 011) — Libertas's workflow has two stages
// (Preliminary, Final), but every school's workflow can differ. This
// component is one page with stageId in the URL; it works for any stage
// of any workflow.
//
// URL: /modules/budget/:stageId
//
// Title and breadcrumb are dynamic from the stage's display_name. All
// internal references to "preliminary" or "final" budgets have been
// removed in favor of stage-agnostic language.

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

function ActionButton({ label, disabled, primary, onClick, title }) {
  const base =
    'border-[0.5px] px-3.5 py-2 rounded text-sm font-body transition-colors'
  const cls = disabled
    ? 'border-card-border bg-white/50 text-muted/60 cursor-not-allowed'
    : primary
      ? 'border-navy bg-navy text-gold hover:opacity-90 cursor-pointer'
      : 'border-card-border bg-white text-navy hover:bg-cream-highlight cursor-pointer'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${cls}`}
    >
      {label}
    </button>
  )
}

function HeaderZone({
  stage,
  ayeLabel,
  selectedAyeId,
  onAyeChange,
  scenarios,
  activeScenarioId,
  onSelectScenario,
  onAddScenario,
  onScenarioAction,
  onResetClick,
  onAddAccountClick,
  onSubmitLockClick,
  resetting,
  canEdit,
  canSubmitLock,
  scenarioForActions,
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    function close() { setMenuOpen(false) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuOpen])

  const submitDisabled =
    !scenarioForActions ||
    !canSubmitLock ||
    !scenarioForActions.is_recommended ||
    scenarioForActions.state !== 'drafting'

  const submitTooltip = !scenarioForActions
    ? 'No scenario selected'
    : !canSubmitLock
      ? 'Submit for lock review requires submit_lock permission.'
      : !scenarioForActions.is_recommended
        ? 'Mark this scenario as recommended before submitting for lock review.'
        : scenarioForActions.state !== 'drafting'
          ? `Scenario is ${scenarioForActions.state}; submit not available in this state.`
          : 'Submit for lock review.'

  // Stage display: prefer the configured display_name; short_name in
  // the breadcrumb keeps the trail compact.
  const stageDisplay = stage?.display_name || 'Budget'
  const stageShort   = stage?.short_name   || stageDisplay

  return (
    <header className="sticky top-0 z-20 bg-cream pt-1 pb-3 -mt-1 border-b-[0.5px] border-card-border">
      <Breadcrumb items={[{ label: 'Budget' }, { label: stageShort }]} />

      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="font-display text-navy text-[26px] leading-tight">
            {ayeLabel ? `${ayeLabel} ${stageDisplay}` : stageDisplay}
          </h1>
          {scenarioForActions && <StateBadge state={scenarioForActions.state} />}
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <AYESelector value={selectedAyeId} onChange={onAyeChange} />

          <div className="flex items-center gap-2">
            {scenarioForActions &&
             canEdit &&
             scenarioForActions.state === 'drafting' && (
              <ActionButton label="+ Add Account" onClick={onAddAccountClick} />
            )}
            <ActionButton disabled label="Save" title="Auto-saves on edit; manual Save lands later" />
            <ActionButton disabled label="View PDF" title="PDF lands in Commit F" />
            <ActionButton
              disabled={submitDisabled}
              label="Submit for Lock Review"
              primary
              title={submitTooltip}
              onClick={onSubmitLockClick}
            />

            {scenarioForActions && (
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
                      disabled={resetting || scenarioForActions.state !== 'drafting'}
                      className="w-full text-left px-4 py-2 font-body text-sm text-status-red hover:bg-status-red-bg disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Reset scenario lines…
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {scenarios.length > 0 && (
        <div className="mt-3 -mb-3 border-b-[0.5px] border-card-border">
          <ScenarioTabs
            scenarios={scenarios}
            activeId={activeScenarioId}
            onSelect={onSelectScenario}
            onAdd={onAddScenario}
            onAction={onScenarioAction}
            canEdit={canEdit}
          />
        </div>
      )}
    </header>
  )
}

function BudgetStage() {
  const { stageId } = useParams()
  const { user } = useAuth()
  const { allowed: canView, loading: permLoading } = useModulePermission(
    'budget',
    'view'
  )
  const { allowed: canEdit } = useModulePermission('budget', 'edit')
  const { allowed: canSubmitLock } = useModulePermission(
    'budget',
    'submit_lock'
  )
  const { allowed: canApproveLock } = useModulePermission(
    'budget',
    'approve_lock'
  )
  const { allowed: canPbAdmin } = useModulePermission('budget', 'admin')
  const { allowed: canEditCoa } = useModulePermission(
    'chart_of_accounts',
    'edit'
  )

  // Stage metadata (loaded from module_workflow_stages) — drives title,
  // breadcrumb, and bootstrap-from-prior stage matching.
  const [stage, setStage] = useState(null)
  const [stageError, setStageError] = useState(null)

  const [selectedAyeId, setSelectedAyeId] = useState(null)
  const [aye, setAye] = useState(null)

  const [scenarios, setScenarios] = useState([])
  const [activeScenarioId, setActiveScenarioId] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [lines, setLines] = useState([])

  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError] = useState(null)

  const [creating, setCreating] = useState(false)
  const [bootstrapError, setBootstrapError] = useState(null)
  const [bootstrapNotice, setBootstrapNotice] = useState(null)
  const [csvOpen, setCsvOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const [newScenarioOpen, setNewScenarioOpen] = useState(false)
  const [settingsModal, setSettingsModal] = useState(null)
  const [submitLockOpen, setSubmitLockOpen] = useState(false)

  const [autoDetectDismissed, setAutoDetectDismissed] = useState(false)
  const [undoStack, setUndoStack] = useState([])
  const [toast, setToast] = useState(null)

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) || null,
    [scenarios, activeScenarioId]
  )

  // Load stage metadata when stageId in the URL changes. The stage row
  // is small (label + short label + type) and tells the page what
  // budget stage it represents.
  useEffect(() => {
    if (!stageId) {
      setStage(null)
      return
    }
    let mounted = true
    setStageError(null)
    ;(async () => {
      const { data, error } = await supabase
        .from('module_workflow_stages')
        .select('id, stage_type, display_name, short_name, sort_order, target_month')
        .eq('id', stageId)
        .maybeSingle()
      if (!mounted) return
      if (error) {
        setStageError(error.message)
        setStage(null)
        return
      }
      if (!data) {
        setStageError(`Stage ${stageId} not found.`)
        setStage(null)
        return
      }
      setStage(data)
    })()
    return () => { mounted = false }
  }, [stageId])

  // ---- data load -------------------------------------------------------

  const loadAyeContext = useCallback(async (ayeId, preferredActiveId = null) => {
    if (!stageId) return
    setDataLoading(true)
    setDataError(null)
    setBootstrapError(null)
    setBootstrapNotice(null)

    const [ayeResult, scenariosResult, accountsResult] = await Promise.all([
      supabase
        .from('academic_years')
        .select('id, label')
        .eq('id', ayeId)
        .single(),
      supabase
        .from('budget_stage_scenarios')
        .select('id, scenario_label, description, is_recommended, state, narrative, show_narrative_in_pdf, created_at, locked_at, locked_by, locked_via, override_justification')
        .eq('aye_id', ayeId)
        .eq('stage_id', stageId)
        .order('created_at', { ascending: true }),
      supabase
        .from('chart_of_accounts')
        .select('id, code, name, parent_id, account_type, posts_directly, is_pass_thru, is_active, is_ed_program_dollars, is_contribution, sort_order')
        .order('sort_order', { ascending: true })
        .order('code', { ascending: true }),
    ])

    if (ayeResult.error)       { setDataError(ayeResult.error.message);       setDataLoading(false); return }
    if (scenariosResult.error) { setDataError(scenariosResult.error.message); setDataLoading(false); return }
    if (accountsResult.error)  { setDataError(accountsResult.error.message);  setDataLoading(false); return }

    setAye(ayeResult.data)
    const list = scenariosResult.data || []
    setScenarios(list)
    setAccounts(accountsResult.data || [])

    let active = null
    if (preferredActiveId && list.some((s) => s.id === preferredActiveId)) {
      active = preferredActiveId
    } else if (activeScenarioId && list.some((s) => s.id === activeScenarioId)) {
      active = activeScenarioId
    } else if (list.length > 0) {
      active = list[0].id
    }
    setActiveScenarioId(active)

    if (active) {
      const { data: lineRows, error: linesErr } = await supabase
        .from('budget_stage_lines')
        .select('id, scenario_id, account_id, amount, source_type, notes')
        .eq('scenario_id', active)
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
  }, [activeScenarioId, stageId])

  const loadLines = useCallback(async (scenarioId) => {
    setDataLoading(true)
    setDataError(null)
    const { data, error } = await supabase
      .from('budget_stage_lines')
      .select('id, scenario_id, account_id, amount, source_type, notes')
      .eq('scenario_id', scenarioId)
    if (error) {
      setDataError(error.message)
    } else {
      setLines(data || [])
    }
    setDataLoading(false)
  }, [])

  // Reload when AYE OR stage changes — switching between Preliminary
  // and Final (or any other stages) should refetch everything for the
  // new stage scope.
  useEffect(() => {
    if (!selectedAyeId || !canView || !stageId) return
    let mounted = true
    ;(async () => {
      await loadAyeContext(selectedAyeId)
      if (!mounted) return
    })()
    return () => { mounted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAyeId, canView, stageId])

  const initialMountRef = useRef(true)
  useEffect(() => {
    if (initialMountRef.current) {
      initialMountRef.current = false
      return
    }
    if (!activeScenarioId) {
      setLines([])
      setUndoStack([])
      return
    }
    setUndoStack([])
    loadLines(activeScenarioId)
  }, [activeScenarioId, loadLines])

  // ---- derived values --------------------------------------------------

  const tree = useMemo(
    () => buildBudgetTree(accounts, lines),
    [accounts, lines]
  )

  const kpis = useMemo(() => {
    if (!activeScenario) return null
    return computeKpis(accounts, lines)
  }, [accounts, lines, activeScenario])

  const unbudgeted = useMemo(() => {
    if (!activeScenario || autoDetectDismissed) return []
    return findUnbudgetedAccounts(accounts, lines)
  }, [accounts, lines, activeScenario, autoDetectDismissed])

  // ---- bootstrap (empty state) -----------------------------------------

  async function handleStartBlank() {
    setCreating(true)
    setBootstrapError(null)
    setBootstrapNotice(null)
    try {
      await createBlankScenario({
        ayeId: selectedAyeId,
        stageId,
        userId: user?.id,
      })
      await loadAyeContext(selectedAyeId)
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
        stageId,
        userId: user?.id,
        priorSnapshotId: probeResult.snapshot.id,
      })
      const sourceLabel = probeResult.stage_match === 'same'
        ? `${probeResult.aye.label} ${probeResult.snapshot.stage_display_name_at_lock}`
        : `${probeResult.aye.label} ${probeResult.snapshot.stage_display_name_at_lock} (no prior ${stage?.display_name || 'same-stage'} budget; used closest match)`
      const noticeParts = [`Bootstrapped from ${sourceLabel}.`]
      if (result.skippedNames && result.skippedNames.length > 0) {
        const list = result.skippedNames.slice(0, 6).join(', ')
        const more =
          result.skippedNames.length > 6
            ? ` and ${result.skippedNames.length - 6} more`
            : ''
        noticeParts.push(
          `${result.skippedNames.length} account(s) from the prior budget are no longer in your Chart of Accounts and were skipped: ${list}${more}.`
        )
      }
      setBootstrapNotice(noticeParts.join(' '))
      await loadAyeContext(selectedAyeId, result.scenarioId)
    } catch (e) {
      setBootstrapError(e.message || String(e))
    } finally {
      setCreating(false)
    }
  }

  async function handleCsvConfirm(rows) {
    setBootstrapError(null)
    setBootstrapNotice(null)
    const result = await createScenarioFromCsvRows({
      ayeId: selectedAyeId,
      stageId,
      userId: user?.id,
      rows,
    })
    setCsvOpen(false)
    await loadAyeContext(selectedAyeId, result.scenarioId)
  }

  async function handleResetScenarioLines() {
    if (!activeScenario) return
    if (!window.confirm(
      `Reset lines in "${activeScenario.scenario_label}"? All ${lines.length} line(s) will be deleted ` +
      `and the scenario will return to the empty start prompt.`
    )) {
      return
    }
    setResetting(true)
    setDataError(null)
    try {
      const { error: linesErr } = await supabase
        .from('budget_stage_lines')
        .delete()
        .eq('scenario_id', activeScenario.id)
      if (linesErr) throw linesErr
      const { error: scenarioErr } = await supabase
        .from('budget_stage_scenarios')
        .delete()
        .eq('id', activeScenario.id)
      if (scenarioErr) throw scenarioErr
      setScenarios((prev) => prev.filter((s) => s.id !== activeScenario.id))
      const remaining = scenarios.filter((s) => s.id !== activeScenario.id)
      setActiveScenarioId(remaining.length > 0 ? remaining[0].id : null)
      setLines([])
      setUndoStack([])
    } catch (e) {
      setDataError(e.message || String(e))
    } finally {
      setResetting(false)
    }
  }

  // ---- editing ---------------------------------------------------------

  const handleSaveAmount = useCallback(
    async (accountId, newAmount, prevAmount, { skipUndoPush = false } = {}) => {
      if (newAmount === prevAmount) return

      const targetLine = lines.find((l) => l.account_id === accountId)
      if (!targetLine) {
        setDataError(`No budget line found for account ${accountId}`)
        return
      }

      setLines((prev) =>
        prev.map((l) =>
          l.id === targetLine.id ? { ...l, amount: newAmount } : l
        )
      )

      const { error } = await supabase
        .from('budget_stage_lines')
        .update({ amount: newAmount, updated_by: user?.id })
        .eq('id', targetLine.id)

      if (error) {
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

  // ---- auto-detect: add unbudgeted at $0 -------------------------------

  async function handleAddUnbudgeted(accountIds) {
    if (!activeScenario) return
    const newLines = accountIds.map((id) => ({
      scenario_id: activeScenario.id,
      account_id: id,
      amount: 0,
      source_type: 'manual',
      created_by: user?.id,
      updated_by: user?.id,
    }))
    const { error } = await supabase
      .from('budget_stage_lines')
      .insert(newLines)
    if (error) throw error
    await loadLines(activeScenario.id)
  }

  // ---- inline add account ----------------------------------------------

  async function handleAddAccountSuccess(message) {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 5000)
    await loadAyeContext(selectedAyeId, activeScenarioId)
  }
  const toastTimer = useRef(null)
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  // ---- scenario tab actions --------------------------------------------

  function handleScenarioSelect(id) {
    setActiveScenarioId(id)
  }

  function handleAddScenario() {
    setNewScenarioOpen(true)
  }

  async function handleScenarioCreated(newId) {
    setNewScenarioOpen(false)
    await loadAyeContext(selectedAyeId, newId)
  }

  async function handleScenarioAction(scenarioId, action) {
    setDataError(null)
    const target = scenarios.find((s) => s.id === scenarioId)
    if (!target) return

    if (action === 'rename') {
      setSettingsModal({ scenarioId, field: 'label' })
      return
    }
    if (action === 'description') {
      setSettingsModal({ scenarioId, field: 'description' })
      return
    }
    if (action === 'recommend') {
      try {
        const otherIds = scenarios
          .filter((s) => s.id !== scenarioId && s.is_recommended)
          .map((s) => s.id)
        if (otherIds.length > 0) {
          const { error: clearErr } = await supabase
            .from('budget_stage_scenarios')
            .update({ is_recommended: false, updated_by: user?.id })
            .in('id', otherIds)
          if (clearErr) throw clearErr
        }
        const { error: setErr } = await supabase
          .from('budget_stage_scenarios')
          .update({ is_recommended: true, updated_by: user?.id })
          .eq('id', scenarioId)
        if (setErr) throw setErr
        await loadAyeContext(selectedAyeId, activeScenarioId)
      } catch (e) {
        setDataError(e.message || String(e))
      }
      return
    }
    if (action === 'delete') {
      if (target.state !== 'drafting') {
        setDataError(
          `Cannot delete a scenario in state "${target.state}". Reopen it via the unlock workflow first.`
        )
        return
      }
      const lineLabel = scenarioId === activeScenarioId
        ? `${lines.length} line(s)`
        : 'all of its lines'
      if (!window.confirm(
        `Delete "${target.scenario_label}"? ${lineLabel} will be removed and the scenario will disappear from the tab strip. This cannot be undone.`
      )) {
        return
      }
      try {
        const { error: linesErr } = await supabase
          .from('budget_stage_lines')
          .delete()
          .eq('scenario_id', scenarioId)
        if (linesErr) throw linesErr
        const { error: scenarioErr } = await supabase
          .from('budget_stage_scenarios')
          .delete()
          .eq('id', scenarioId)
        if (scenarioErr) throw scenarioErr
        const nextActive = scenarioId === activeScenarioId ? null : activeScenarioId
        setActiveScenarioId(nextActive)
        await loadAyeContext(selectedAyeId, nextActive)
      } catch (e) {
        setDataError(e.message || String(e))
      }
      return
    }
  }

  async function handleSettingsSave({ label, description }) {
    if (!settingsModal) return
    const updates =
      settingsModal.field === 'label'
        ? { scenario_label: label, updated_by: user?.id }
        : { description, updated_by: user?.id }
    const { error } = await supabase
      .from('budget_stage_scenarios')
      .update(updates)
      .eq('id', settingsModal.scenarioId)
    if (error) throw error
    setSettingsModal(null)
    await loadAyeContext(selectedAyeId, activeScenarioId)
  }

  // ---- lock workflow ---------------------------------------------------

  async function handleSubmitLockConfirm({ lockedVia, overrideJustification }) {
    if (!activeScenario) return
    await submitScenarioForLockReview({
      scenarioId: activeScenario.id,
      lockedVia,
      overrideJustification,
      userId: user?.id,
    })
    setSubmitLockOpen(false)
    await loadAyeContext(selectedAyeId, activeScenarioId)
  }

  async function handleApprove() {
    if (!activeScenario) return
    await approveAndLockScenario({ scenarioId: activeScenario.id })
    await loadAyeContext(selectedAyeId, activeScenarioId)
  }

  async function handleReject() {
    if (!activeScenario) return
    await rejectScenarioLock({ scenarioId: activeScenario.id, userId: user?.id })
    await loadAyeContext(selectedAyeId, activeScenarioId)
  }

  const [lockedByName, setLockedByName] = useState(null)
  useEffect(() => {
    if (!activeScenario?.locked_by) {
      setLockedByName(null)
      return
    }
    let mounted = true
    ;(async () => {
      const { data } = await supabase
        .from('user_profiles')
        .select('full_name')
        .eq('id', activeScenario.locked_by)
        .maybeSingle()
      if (mounted) setLockedByName(data?.full_name || null)
    })()
    return () => { mounted = false }
  }, [activeScenario?.id, activeScenario?.locked_by])

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
        <Breadcrumb items={[{ label: 'Budget' }, { label: stage?.short_name || 'Stage' }]} />
        <h1 className="font-display text-navy text-[28px] mb-3 leading-tight">
          You don't have access to this module.
        </h1>
        <p className="text-body mb-6">
          Budget access requires the appropriate module permission.
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

  if (stageError) {
    return (
      <AppShell>
        <Breadcrumb items={[{ label: 'Budget' }, { label: 'Stage not found' }]} />
        <h1 className="font-display text-navy text-[28px] mb-3 leading-tight">
          Budget stage not found.
        </h1>
        <p className="text-body mb-2">{stageError}</p>
        <p className="text-muted italic mb-6 text-sm">
          The stage may have been removed from the workflow. Check the
          sidebar for current stages, or contact a system admin.
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

  if (!stage) {
    return (
      <AppShell>
        <p className="text-muted">Loading stage…</p>
      </AppShell>
    )
  }

  const readOnly = !canEdit || (activeScenario && activeScenario.state !== 'drafting')

  const settingsScenario = settingsModal
    ? scenarios.find((s) => s.id === settingsModal.scenarioId)
    : null

  return (
    <AppShell>
      <div className="-mx-6 -my-6 flex flex-col h-[calc(100vh-3.5rem)]">
        <div className="px-6">
          <HeaderZone
            stage={stage}
            ayeLabel={aye?.label}
            selectedAyeId={selectedAyeId}
            onAyeChange={setSelectedAyeId}
            scenarios={scenarios}
            activeScenarioId={activeScenarioId}
            onSelectScenario={handleScenarioSelect}
            onAddScenario={handleAddScenario}
            onScenarioAction={handleScenarioAction}
            onResetClick={handleResetScenarioLines}
            onAddAccountClick={() => setAddAccountOpen(true)}
            onSubmitLockClick={() => setSubmitLockOpen(true)}
            resetting={resetting}
            canEdit={canEdit && canEditCoa}
            canSubmitLock={canSubmitLock || canPbAdmin}
            scenarioForActions={activeScenario}
          />
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Detail zone first (left); KPI sidebar after (right). The
              navy KPI panel against cream surfaces on both sides reads
              as a clearly bounded element — adjacency to the navy nav
              sidebar at the page's left edge produced visual collision
              when the KPIs lived on the left of the detail. */}
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
            ) : !activeScenario ? (
              canEdit ? (
                <BudgetEmptyState
                  ayeId={selectedAyeId}
                  ayeLabel={aye?.label}
                  stageDisplayName={stage.display_name}
                  stageId={stage.id}
                  onAyeChange={setSelectedAyeId}
                  onStartBlank={handleStartBlank}
                  onUploadCsv={() => setCsvOpen(true)}
                  onBootstrapPrior={handleBootstrapPrior}
                  creating={creating}
                  error={bootstrapError}
                />
              ) : (
                <p className="text-muted italic mt-8">
                  No {stage.display_name} exists for {aye?.label || 'this AYE'} yet. You
                  need <strong>edit</strong> permission to start one.
                </p>
              )
            ) : (
              <>
                {activeScenario.state === 'locked' && (
                  <LockedBanner
                    scenario={activeScenario}
                    lockedByName={lockedByName}
                  />
                )}
                {activeScenario.state === 'pending_lock_review' && canApproveLock && (
                  <ApproveLockBar
                    scenario={activeScenario}
                    onApprove={handleApprove}
                    onReject={handleReject}
                  />
                )}
                {activeScenario.state === 'pending_lock_review' && !canApproveLock && (
                  <div className="mb-4 px-4 py-3 bg-status-blue-bg border-[0.5px] border-status-blue/25 rounded text-status-blue text-sm">
                    <p className="font-display text-[13px] tracking-[0.06em] uppercase mb-0.5">
                      Pending lock review
                    </p>
                    <p className="text-body">
                      Submitted; waiting for an approver. The detail view is
                      read-only until approval or rejection.
                    </p>
                  </div>
                )}
                {activeScenario.state === 'drafting' &&
                 !autoDetectDismissed &&
                 unbudgeted.length > 0 && (
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

          <KpiSidebar kpis={kpis} />
        </div>
      </div>

      {csvOpen && (
        <CsvImportModal
          ayeLabel={aye?.label}
          onCancel={() => setCsvOpen(false)}
          onConfirm={handleCsvConfirm}
        />
      )}

      {addAccountOpen && activeScenario && (
        <AddAccountModal
          accounts={accounts}
          scenarioId={activeScenario.id}
          userId={user?.id}
          onClose={() => setAddAccountOpen(false)}
          onSuccess={handleAddAccountSuccess}
        />
      )}

      {newScenarioOpen && (
        <NewScenarioModal
          ayeId={selectedAyeId}
          stageId={stage.id}
          ayeLabel={aye?.label}
          stageDisplayName={stage.display_name}
          currentScenario={activeScenario}
          userId={user?.id}
          onClose={() => setNewScenarioOpen(false)}
          onCreated={handleScenarioCreated}
        />
      )}

      {settingsModal && settingsScenario && (
        <ScenarioSettingsModal
          scenario={settingsScenario}
          field={settingsModal.field}
          onClose={() => setSettingsModal(null)}
          onSave={handleSettingsSave}
        />
      )}

      {submitLockOpen && activeScenario && (
        <SubmitLockModal
          scenario={activeScenario}
          lines={lines}
          ayeId={selectedAyeId}
          isAdmin={!!canPbAdmin}
          onCancel={() => setSubmitLockOpen(false)}
          onConfirm={handleSubmitLockConfirm}
        />
      )}
    </AppShell>
  )
}

export default BudgetStage
