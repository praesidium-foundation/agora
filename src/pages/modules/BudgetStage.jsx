import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import { useToast } from '../../lib/Toast'
import {
  createBlankScenario,
  createScenarioFromCsvRows,
  createScenarioFromPriorAye,
} from '../../lib/budgetBootstrap'
import {
  buildBudgetTree,
  buildSnapshotTree,
  computeKpis,
  findUnbudgetedAccounts,
  snapshotKpis,
} from '../../lib/budgetTree'
import {
  approveAndLockScenario,
  findLockedSibling,
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
import LineHistoryModal from '../../components/budget/LineHistoryModal'
import ActivityFeedModal from '../../components/budget/ActivityFeedModal'
import RequestUnlockModal from '../../components/budget/RequestUnlockModal'
import ApproveUnlockModal from '../../components/budget/ApproveUnlockModal'
import RejectUnlockModal from '../../components/budget/RejectUnlockModal'
import WithdrawUnlockModal from '../../components/budget/WithdrawUnlockModal'
import PredecessorSelector from '../../components/budget/PredecessorSelector'
import SeedFromPredecessorModal from '../../components/budget/SeedFromPredecessorModal'

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
  onSaveClick,
  onViewPdfClick,
  onSubmitLockClick,
  onOpenActivityFeed,
  resetting,
  canEdit,
  canSubmitLock,
  scenarioForActions,
  lockedSibling,
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    function close() { setMenuOpen(false) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuOpen])

  // Header button gating (architecture Section 8.12):
  //
  //   Save             — enabled when a scenario exists AND state is
  //                      drafting AND user has edit permission. The
  //                      underlying interaction is direct-edit-with-undo
  //                      so saves are implicit on blur; Save is a
  //                      confidence affordance ("yes, your changes are
  //                      persisted") that surfaces a toast on click.
  //   View PDF         — Commit F deliverable; remains a placeholder
  //                      here with a tooltip that explains the schedule
  //                      rather than misleading the user about what's
  //                      gating it.
  //   Submit for Lock  — enabled only when scenario state = drafting
  //   Review             AND user has submit_lock (or admin) AND
  //                      is_recommended = true. The recommended
  //                      requirement is surfaced inline below the
  //                      buttons so users discover it without trial.
  const saveDisabled =
    !scenarioForActions ||
    !canEdit ||
    scenarioForActions.state !== 'drafting'

  const submitDisabled =
    !scenarioForActions ||
    !canSubmitLock ||
    !scenarioForActions.is_recommended ||
    scenarioForActions.state !== 'drafting' ||
    !!lockedSibling

  // Inline-hint condition: every gate other than is_recommended is
  // satisfied. We don't want to nag the user with this hint when the
  // problem is something else (wrong state, wrong permission, or a
  // sibling-lock block — the page-level banner covers that case).
  const showRecommendedHint =
    !!scenarioForActions &&
    !!canSubmitLock &&
    !lockedSibling &&
    scenarioForActions.state === 'drafting' &&
    !scenarioForActions.is_recommended

  const submitTooltip = !scenarioForActions
    ? 'No scenario selected'
    : !canSubmitLock
      ? 'Submit for lock review requires submit_lock permission.'
      : scenarioForActions.state !== 'drafting'
        ? `Scenario is ${scenarioForActions.state}; submit not available in this state.`
        : lockedSibling
          ? `"${lockedSibling.scenario_label}" is currently locked in this (AYE, stage). Unlock it before submitting this scenario for lock review.`
          : !scenarioForActions.is_recommended
            ? 'This scenario must be marked as recommended before it can be locked. Use the scenario tab menu (⋮) to mark it.'
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
            <ActionButton
              disabled={saveDisabled}
              label="Save"
              title={
                saveDisabled
                  ? !scenarioForActions
                    ? 'No scenario selected'
                    : !canEdit
                      ? 'Edit permission required'
                      : `Scenario is ${scenarioForActions.state}; cannot save in this state.`
                  : 'Confirm changes are saved (changes auto-save on edit).'
              }
              onClick={onSaveClick}
            />
            <ActionButton
              disabled={!scenarioForActions}
              label="View PDF"
              title={
                !scenarioForActions
                  ? 'No scenario to print.'
                  : scenarioForActions.state === 'locked'
                    ? 'Open the locked Operating Budget Detail PDF (snapshot data, approved-by footer).'
                    : 'Open the DRAFT Operating Budget Detail PDF (live data, watermarked).'
              }
              onClick={onViewPdfClick}
            />
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

      {/* Recommended-scenario inline hint. Visible only when the
          recommended condition is the specific blocker on Submit
          (state is drafting, user has submit_lock, scenario is not
          marked recommended). Hidden when the blocker is something
          else (wrong state, missing permission) so we don't nag the
          user with a non-actionable hint. */}
      {showRecommendedHint && (
        <p className="mt-2 text-right font-body italic text-[12px] text-muted leading-relaxed">
          Mark this scenario as <span className="text-gold not-italic">★</span>{' '}
          recommended (via the scenario tab menu) before submitting for lock review.
        </p>
      )}

      {scenarios.length > 0 && (
        <div className="mt-3 -mb-3 border-b-[0.5px] border-card-border flex items-end justify-between gap-4">
          <ScenarioTabs
            scenarios={scenarios}
            activeId={activeScenarioId}
            onSelect={onSelectScenario}
            onAdd={onAddScenario}
            onAction={onScenarioAction}
            canEdit={canEdit}
          />
          {/* Recent Activity affordance (v3.6 relocation): right-
              aligned text link on the scenario tabs row, baseline-
              aligned with tab labels. Click opens ActivityFeedModal.
              Only rendered when an active scenario exists — the modal
              operates on the active scenario. */}
          {scenarioForActions && (
            <button
              type="button"
              onClick={onOpenActivityFeed}
              className="px-3 py-1.5 font-body text-[13px] text-status-blue hover:underline whitespace-nowrap flex-shrink-0"
            >
              Recent Activity
            </button>
          )}
        </div>
      )}
    </header>
  )
}

function BudgetStage() {
  const { stageId } = useParams()
  const { user } = useAuth()
  const toast = useToast()
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
  const { allowed: canApproveUnlock } = useModulePermission(
    'budget',
    'approve_unlock'
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

  // Locked-scenario render path (architecture Section 5.1 binding rule):
  // when the active scenario is locked, the budget tree and KPIs come
  // from the snapshot tables — NOT from budget_stage_lines joined to
  // live chart_of_accounts. The snapshot's captured-by-value columns
  // are the source of truth for locked views; live data is forbidden
  // in that render path. These two pieces of state hold the snapshot
  // payload; they're empty in drafting / pending_lock_review states.
  const [snapshot, setSnapshot] = useState(null)
  const [snapshotLines, setSnapshotLines] = useState([])

  const [dataLoading, setDataLoading] = useState(false)

  const [creating, setCreating] = useState(false)
  // Bootstrap-flow error stays inline INSIDE BudgetEmptyState (the
  // empty-state card is the focal point during bootstrap). Other
  // errors and all success / informational messages route through
  // toast.error / toast.success — visible regardless of scroll
  // position on the long-list budget detail.
  const [bootstrapError, setBootstrapError] = useState(null)
  const [csvOpen, setCsvOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const [newScenarioOpen, setNewScenarioOpen] = useState(false)
  const [settingsModal, setSettingsModal] = useState(null)
  const [submitLockOpen, setSubmitLockOpen] = useState(false)

  const [autoDetectDismissed, setAutoDetectDismissed] = useState(false)
  const [undoStack, setUndoStack] = useState([])

  // Per-line audit history modal. Holds {lineId, accountCode,
  // accountName} when open; null when closed.
  const [lineHistoryFor, setLineHistoryFor] = useState(null)

  // Activity feed modal. Boolean — opens against the active scenario.
  // v3.6: replaced the cream-highlight inline banner with a "Recent
  // Activity" link in the scenario tabs row that opens this modal.
  const [activityFeedOpen, setActivityFeedOpen] = useState(false)

  // Unlock workflow modals. Single string controls which (if any) is
  // open: 'request' | 'approve' | 'reject' | 'withdraw' | null. Only
  // one unlock-related modal is open at a time, and they all act on
  // the activeScenario, so a single piece of state suffices.
  const [unlockModal, setUnlockModal] = useState(null)

  // Predecessor-seed modal state for the non-first-stage setup flow.
  // Holds { snapshot, predecessorStage } when open; null otherwise.
  // Architecture §8.14.
  const [seedFromSnapshot, setSeedFromSnapshot] = useState(null)

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) || null,
    [scenarios, activeScenarioId]
  )

  // When ANY scenario in this (AYE, stage) is locked, every OTHER
  // scenario in the slot is gated from claiming `recommended` or
  // submitting for lock review (Migration 015 / architecture Section
  // 8.7). This in-memory derivation feeds the page banner, the
  // ScenarioTabs menu gating, the Submit button tooltip, and the
  // SubmitLockModal hardBlock failure.
  const lockedSibling = useMemo(
    () => findLockedSibling(scenarios, activeScenarioId),
    [scenarios, activeScenarioId]
  )

  // Account lookup map for the activity feed and line-history modal.
  // Resolves account_id → {code, name} so audit events render as
  // "Curriculum/Book Fees ($0 → $9,750)" instead of raw uuids.
  const accountsById = useMemo(() => {
    const m = {}
    for (const a of accounts) m[a.id] = { code: a.code, name: a.name }
    return m
  }, [accounts])

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
        .select('id, stage_type, display_name, short_name, sort_order, target_month, workflow_id')
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

  // Sibling stages in the same workflow. Loaded after the active stage
  // is loaded; used to detect whether the current stage is the first
  // in its workflow (architecture §8.14: first stages keep the
  // three-option setup flow; non-first stages seed from a locked
  // predecessor) and to enumerate predecessors for the
  // PredecessorSelector view. Order ascending by sort_order so the
  // resulting array reads workflow-natural.
  const [workflowStages, setWorkflowStages] = useState([])
  useEffect(() => {
    if (!stage?.workflow_id) {
      setWorkflowStages([])
      return
    }
    let mounted = true
    ;(async () => {
      const { data } = await supabase
        .from('module_workflow_stages')
        .select('id, display_name, short_name, sort_order')
        .eq('workflow_id', stage.workflow_id)
        .order('sort_order', { ascending: true })
      if (!mounted) return
      setWorkflowStages(data || [])
    })()
    return () => { mounted = false }
  }, [stage?.workflow_id])

  // Derived: is this the first stage in its workflow? (Lowest
  // sort_order.) Determines which setup view renders when no scenario
  // exists yet for the (AYE, stage) combination.
  const isFirstStageInWorkflow = useMemo(() => {
    if (!stage || workflowStages.length === 0) return null // unknown
    const minSort = Math.min(...workflowStages.map((s) => s.sort_order))
    return stage.sort_order === minSort
  }, [stage, workflowStages])

  // Predecessor stages — those with lower sort_order than the current
  // stage in the same workflow. Empty for first stages.
  const predecessorStages = useMemo(() => {
    if (!stage) return []
    return workflowStages.filter((s) => s.sort_order < stage.sort_order)
  }, [stage, workflowStages])

  // ---- data load -------------------------------------------------------

  const loadAyeContext = useCallback(async (ayeId, preferredActiveId = null) => {
    if (!stageId) return
    setDataLoading(true)
    setBootstrapError(null)

    const [ayeResult, scenariosResult, accountsResult] = await Promise.all([
      supabase
        .from('academic_years')
        .select('id, label')
        .eq('id', ayeId)
        .single(),
      supabase
        .from('budget_stage_scenarios')
        .select('id, scenario_label, description, is_recommended, state, narrative, show_narrative_in_pdf, created_at, locked_at, locked_by, locked_via, override_justification, unlock_requested, unlock_request_justification, unlock_requested_at, unlock_requested_by, unlock_approval_1_at, unlock_approval_1_by, unlock_approval_2_at, unlock_approval_2_by')
        .eq('aye_id', ayeId)
        .eq('stage_id', stageId)
        .order('created_at', { ascending: true }),
      supabase
        .from('chart_of_accounts')
        .select('id, code, name, parent_id, account_type, posts_directly, is_pass_thru, is_active, is_ed_program_dollars, is_contribution, sort_order')
        .order('sort_order', { ascending: true })
        .order('code', { ascending: true }),
    ])

    if (ayeResult.error)       { toast.error(ayeResult.error.message);       setDataLoading(false); return }
    if (scenariosResult.error) { toast.error(scenariosResult.error.message); setDataLoading(false); return }
    if (accountsResult.error)  { toast.error(accountsResult.error.message);  setDataLoading(false); return }

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
      const activeRow = list.find((s) => s.id === active)
      try {
        await fetchScenarioPayload(active, activeRow?.state)
      } catch (e) {
        toast.error(e.message || String(e))
        setDataLoading(false)
        return
      }
    } else {
      setLines([])
      setSnapshot(null)
      setSnapshotLines([])
    }

    setDataLoading(false)
  }, [activeScenarioId, stageId, toast])

  // Branched data load. For LOCKED scenarios the budget tree comes
  // from budget_snapshots + budget_snapshot_lines (architecture Section
  // 5.1: locked-state UI renders exclusively from snapshot tables).
  // For drafting / pending_lock_review / pending_unlock_review, lines
  // come from budget_stage_lines and the tree builder joins them to
  // the live chart_of_accounts payload already loaded.
  //
  // Sets either {snapshot, snapshotLines} or {lines}; the unused side
  // is cleared so the useMemo branches read clean state.
  const fetchScenarioPayload = useCallback(async (scenarioId, scenarioState) => {
    if (scenarioState === 'locked') {
      const { data: snap, error: snapErr } = await supabase
        .from('budget_snapshots')
        .select('*')
        .eq('scenario_id', scenarioId)
        .order('locked_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (snapErr) throw snapErr
      if (!snap) {
        // Architectural anomaly: scenario.state = 'locked' but no
        // snapshot row exists. Migration 012's lock function inserts
        // both atomically so this should be impossible. Surface
        // clearly rather than silently falling back to live data,
        // which would re-introduce the bug this guards against.
        setSnapshot(null)
        setSnapshotLines([])
        setLines([])
        throw new Error(
          'Locked scenario is missing its snapshot row. Database may have been edited outside the lock workflow; contact a system admin.'
        )
      }
      const { data: snapLines, error: snapLinesErr } = await supabase
        .from('budget_snapshot_lines')
        .select('id, account_id, account_code, account_name, account_type, account_hierarchy_path, is_pass_thru, is_ed_program_dollars, is_contribution, amount, source_type, notes')
        .eq('snapshot_id', snap.id)
      if (snapLinesErr) throw snapLinesErr
      setSnapshot(snap)
      setSnapshotLines(snapLines || [])
      setLines([])
      return
    }
    // Live mode (drafting / pending_lock_review / pending_unlock_review)
    const { data, error } = await supabase
      .from('budget_stage_lines')
      .select('id, scenario_id, account_id, amount, source_type, notes')
      .eq('scenario_id', scenarioId)
    if (error) throw error
    setLines(data || [])
    setSnapshot(null)
    setSnapshotLines([])
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
      setSnapshot(null)
      setSnapshotLines([])
      setUndoStack([])
      return
    }
    setUndoStack([])
    const activeRow = scenarios.find((s) => s.id === activeScenarioId)
    if (!activeRow) return
    setDataLoading(true)
    ;(async () => {
      try {
        await fetchScenarioPayload(activeScenarioId, activeRow.state)
      } catch (e) {
        toast.error(e.message || String(e))
      } finally {
        setDataLoading(false)
      }
    })()
  }, [activeScenarioId, scenarios, fetchScenarioPayload, toast])

  // ---- derived values --------------------------------------------------

  // Tree source forks on scenario state. Locked → buildSnapshotTree
  // from captured columns. Drafting / pending → buildBudgetTree from
  // live COA + active lines. The two builders return the same shape
  // so BudgetDetailZone renders either without modification.
  const tree = useMemo(() => {
    if (activeScenario?.state === 'locked') {
      return buildSnapshotTree(snapshotLines)
    }
    return buildBudgetTree(accounts, lines)
  }, [activeScenario, snapshotLines, accounts, lines])

  const kpis = useMemo(() => {
    if (!activeScenario) return null
    if (activeScenario.state === 'locked') {
      // Locked: KPIs come from captured snapshot columns, not from
      // re-computing across live data.
      return snapshotKpis(snapshot)
    }
    return computeKpis(accounts, lines)
  }, [accounts, lines, activeScenario, snapshot])

  const unbudgeted = useMemo(() => {
    if (!activeScenario || autoDetectDismissed) return []
    return findUnbudgetedAccounts(accounts, lines)
  }, [accounts, lines, activeScenario, autoDetectDismissed])

  // ---- bootstrap (empty state) -----------------------------------------

  async function handleStartBlank() {
    setCreating(true)
    setBootstrapError(null)
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
      toast.success(noticeParts.join(' '))
      await loadAyeContext(selectedAyeId, result.scenarioId)
    } catch (e) {
      setBootstrapError(e.message || String(e))
    } finally {
      setCreating(false)
    }
  }

  async function handleCsvConfirm(rows) {
    setBootstrapError(null)
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
      toast.error(e.message || String(e))
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
        toast.error(`No budget line found for account ${accountId}`)
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
        toast.error(error.message)
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
    // Auto-detect banner only renders in drafting state, so the
    // active scenario is guaranteed to be drafting here. Reload the
    // live lines via the state-aware payload fetcher to keep the
    // tree in sync.
    await fetchScenarioPayload(activeScenario.id, activeScenario.state)
  }

  // ---- inline add account ----------------------------------------------

  async function handleAddAccountSuccess(message) {
    toast.success(message)
    await loadAyeContext(selectedAyeId, activeScenarioId)
  }

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
        toast.error(e.message || String(e))
      }
      return
    }
    if (action === 'delete') {
      if (target.state !== 'drafting') {
        toast.error(
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
        toast.error(e.message || String(e))
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

  // Unlock workflow modal handlers. Each modal owns its own RPC call
  // (via supabase.rpc inside the modal); on success the modal calls
  // back here to close itself and refetch scenario state. This is
  // the same pattern as LineHistoryModal / SubmitLockModal.
  async function handleUnlockModalSuccess() {
    setUnlockModal(null)
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
          You do not have access to this module.
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
            onSaveClick={() => toast.success('All changes are saved.')}
            onViewPdfClick={() => {
              if (activeScenario) {
                window.open(`/print/budget/${activeScenario.id}`, '_blank', 'noopener')
              }
            }}
            onSubmitLockClick={() => setSubmitLockOpen(true)}
            onOpenActivityFeed={() => setActivityFeedOpen(true)}
            resetting={resetting}
            canEdit={canEdit && canEditCoa}
            canSubmitLock={canSubmitLock || canPbAdmin}
            scenarioForActions={activeScenario}
            lockedSibling={lockedSibling}
          />
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Detail zone first (left); KPI sidebar after (right). The
              navy KPI panel against cream surfaces on both sides reads
              as a clearly bounded element — adjacency to the navy nav
              sidebar at the page's left edge produced visual collision
              when the KPIs lived on the left of the detail. */}
          <div className="flex-1 overflow-y-auto px-6 py-2">
            {/* Status messages (data-load errors, bootstrap notices,
                add-account success) route through the global Toast
                system at the top-right of the viewport — visible
                regardless of how deep the user has scrolled into the
                budget detail. */}

            {!selectedAyeId ? (
              <p className="text-muted italic mt-8">
                Pick an academic year to begin.
              </p>
            ) : dataLoading ? (
              <p className="text-muted mt-8">Loading…</p>
            ) : !activeScenario ? (
              canEdit ? (
                /* Setup gateway. Branches on whether this stage is
                   the first in its workflow (architecture §8.14):
                     - First stage    → BudgetEmptyState (three options)
                     - Non-first stage → PredecessorSelector (cards or
                                          empty state if no locked
                                          predecessor exists yet)
                   isFirstStageInWorkflow is null while the workflow's
                   stage list is still loading; we render the existing
                   empty state in that brief window rather than
                   flashing two views in sequence. */
                isFirstStageInWorkflow === false ? (
                  <PredecessorSelector
                    targetStage={stage}
                    ayeId={selectedAyeId}
                    ayeLabel={aye?.label}
                    predecessorStages={predecessorStages}
                    onSelectSnapshot={(snapshot, predecessorStage) =>
                      setSeedFromSnapshot({ snapshot, predecessorStage })
                    }
                  />
                ) : (
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
                )
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
                    aye={aye}
                    stage={stage}
                    lockedByName={lockedByName}
                    currentUser={user}
                    hasSubmitLock={canSubmitLock || canPbAdmin}
                    hasApproveUnlock={canApproveUnlock || canPbAdmin}
                    onRequestUnlock={() => setUnlockModal('request')}
                    onApproveUnlock={() => setUnlockModal('approve')}
                    onRejectUnlock={() => setUnlockModal('reject')}
                    onWithdrawUnlock={() => setUnlockModal('withdraw')}
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
                {activeScenario.state === 'drafting' && lockedSibling && (
                  <div className="mb-4 px-4 py-3 bg-status-amber-bg border-[0.5px] border-status-amber/30 rounded text-status-amber text-sm">
                    <p className="font-display text-[13px] tracking-[0.06em] uppercase mb-0.5">
                      Sibling scenario is locked
                    </p>
                    <p className="text-body">
                      <strong className="font-medium">
                        {lockedSibling.scenario_label}
                      </strong>{' '}
                      is currently locked for this {aye?.label || 'AYE'}{' '}
                      {stage.display_name}. You can still draft and edit
                      this scenario, but it cannot be marked recommended or
                      submitted for lock review until the locked sibling
                      is unlocked.
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
                  hideLineHistory={activeScenario.state === 'locked'}
                  onShowLineHistory={(line, account) =>
                    setLineHistoryFor({
                      lineId: line.id,
                      accountCode: account.code,
                      accountName: account.name,
                    })
                  }
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
          lockedSibling={lockedSibling}
          onCancel={() => setSubmitLockOpen(false)}
          onConfirm={handleSubmitLockConfirm}
        />
      )}

      {lineHistoryFor && (
        <LineHistoryModal
          lineId={lineHistoryFor.lineId}
          accountCode={lineHistoryFor.accountCode}
          accountName={lineHistoryFor.accountName}
          onClose={() => setLineHistoryFor(null)}
        />
      )}

      {/* Activity feed modal (v3.6 relocation). Opens from the
          "Recent Activity" link in the scenario tabs row. Operates
          on the active scenario. */}
      {activityFeedOpen && activeScenario && (
        <ActivityFeedModal
          scenarioId={activeScenario.id}
          accountsById={accountsById}
          onClose={() => setActivityFeedOpen(false)}
        />
      )}

      {/* Unlock workflow modals. Each acts on the active scenario;
          on success they call handleUnlockModalSuccess which closes
          the modal and refetches scenario state. */}
      {unlockModal === 'request' && activeScenario && (
        <RequestUnlockModal
          scenario={activeScenario}
          currentUser={user}
          hasSubmitLock={canSubmitLock || canPbAdmin}
          onCancel={() => setUnlockModal(null)}
          onSuccess={handleUnlockModalSuccess}
        />
      )}
      {unlockModal === 'approve' && activeScenario && (
        <ApproveUnlockModal
          scenario={activeScenario}
          currentUser={user}
          hasApproveUnlock={canApproveUnlock || canPbAdmin}
          onCancel={() => setUnlockModal(null)}
          onSuccess={handleUnlockModalSuccess}
        />
      )}
      {unlockModal === 'reject' && activeScenario && (
        <RejectUnlockModal
          scenario={activeScenario}
          currentUser={user}
          hasApproveUnlock={canApproveUnlock || canPbAdmin}
          onCancel={() => setUnlockModal(null)}
          onSuccess={handleUnlockModalSuccess}
        />
      )}
      {unlockModal === 'withdraw' && activeScenario && (
        <WithdrawUnlockModal
          scenario={activeScenario}
          currentUser={user}
          onCancel={() => setUnlockModal(null)}
          onSuccess={handleUnlockModalSuccess}
        />
      )}

      {/* Predecessor-seed confirmation modal — opens when the user
          picks a card on PredecessorSelector. Calls
          create_scenario_from_snapshot RPC; on success we close the
          modal, refetch, and the new scenario becomes active because
          loadAyeContext sets activeScenarioId to the returned id. */}
      {seedFromSnapshot && (
        <SeedFromPredecessorModal
          targetStage={stage}
          sourceSnapshot={seedFromSnapshot.snapshot}
          sourceAye={aye}
          onCancel={() => setSeedFromSnapshot(null)}
          onSuccess={async (newScenarioId) => {
            setSeedFromSnapshot(null)
            await loadAyeContext(selectedAyeId, newScenarioId)
          }}
        />
      )}
    </AppShell>
  )
}

export default BudgetStage
