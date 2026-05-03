import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import { useToast } from '../../lib/Toast'
import { defaultTierRates, defaultFamilyDistribution } from '../../lib/tuitionDefaults'
import {
  applyDerivedFamilyCounts,
  computeTotalFamilies,
  computeProjectedMultiStudentDiscount,
  computeProjectedGrossAtTier1,
  computeProjectedEdProgramRevenue,
  sumTotalProjectedDiscounts,
  computeNetProjectedEdProgramRevenue,
  computeNetEdProgramRatio,
  computeBreakevenEnrollment,
} from '../../lib/tuitionMath'
import { formatCurrency } from '../../lib/format'
import AppShell from '../../components/AppShell'
import AYESelector from '../../components/AYESelector'
import Breadcrumb from '../../components/Breadcrumb'
import Badge from '../../components/Badge'
import StatsSidebar from '../../components/tuition/StatsSidebar'
import TuitionEmptyState from '../../components/tuition/TuitionEmptyState'
import TuitionConfigurationZone from '../../components/tuition/TuitionConfigurationZone'
import TuitionNewScenarioModal from '../../components/tuition/TuitionNewScenarioModal'
import ScenarioSettingsModal from '../../components/budget/ScenarioSettingsModal'

// Tuition Stage 1 (Tuition Planning) configuration page.
//
// URL: /modules/tuition (mounts the preliminary-typed stage of the
// tuition workflow; Stage 2 / Tuition Audit ships in Tuition-D at
// a separate route).
//
// Pattern parallels BudgetStage.jsx:
//   - Three-zone layout (sticky header / configuration zone / right
//     stats sidebar) per architecture §8.1.
//   - Multi-scenario shell with tab strip + kebab menu (rename,
//     mark-recommended, edit description, delete).
//   - Direct-edit-with-undo on every leaf field (architecture §8.3
//     editing model). Save is a confidence affordance (toast
//     confirms persistence); writes are implicit on each field
//     change.
//   - State-aware rendering: drafting → editable; pending_lock_review
//     and locked → read-only. (Only drafting is reachable in B1; the
//     read-only paths are stubbed-in so Tuition-D drops in cleanly.)
//   - Permission gating: tuition.view to read; tuition.edit to write.
//
// What's deliberately absent from B1:
//   - Submit for Lock Review button (lock workflow ships in Tuition-D)
//   - View PDF button (PDF ships in Tuition-E)
//   - LockedBanner / approve-lock bar / unlock-modal stack (Tuition-D)
//   - Year-over-year comparison (Tuition-B3)
//   - Computed KPIs in the stats sidebar (Tuition-C — sidebar is
//     data-driven from inception so the swap is rewrite-free)
//   - Recent Activity link wired up (the activity-log query helper
//     is Budget-specific today; the link is rendered as a stub with
//     a tooltip explaining wire-up lands in Tuition-D)

const STATE_BADGES = {
  drafting:             { label: 'DRAFTING',              variant: 'navy' },
  pending_lock_review:  { label: 'PENDING LOCK REVIEW',   variant: 'amber' },
  locked:               { label: 'LOCKED',                variant: 'green' },
  pending_unlock_review:{ label: 'PENDING UNLOCK REVIEW', variant: 'amber' },
}

function StateBadge({ state }) {
  const cfg = STATE_BADGES[state]
  if (!cfg) return null
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>
}

function ActionButton({ label, disabled, primary, onClick, title }) {
  const base = 'border-[0.5px] px-3.5 py-2 rounded text-sm font-body transition-colors'
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

// v3.8.7 (Tuition-C): format a Budget snapshot into a human-readable
// source label for the expense comparator's sublabel area. Examples:
//   ('AYE 2025', 'final')        → 'AYE 2025 Final Budget'
//   ('AYE 2025', 'preliminary')  → 'AYE 2025 Preliminary Budget'
//   ('AYE 2026', 'reforecast')   → 'AYE 2026 Reforecast Budget'
// The mapping uses the stage_type code; 'final' and 'preliminary' are
// the only types Libertas seeds today (Migration 010), but the
// formatter is permissive about future types.
function formatBudgetSourceLabel(aye, stageType) {
  if (!aye) return null
  const stageLabel = stageType === 'final'
    ? 'Final'
    : stageType === 'preliminary'
      ? 'Preliminary'
      : stageType
        ? stageType.charAt(0).toUpperCase() + stageType.slice(1)
        : ''
  return stageLabel ? `${aye} ${stageLabel} Budget` : `${aye} Budget`
}

// v3.8.7 (Tuition-C): comparator control rendered inside the Net
// Education Program Ratio stat's sublabel slot. Two visual modes:
//   - 'locked_budget': dropdown + read-only "vs. {sourceLabel}" text
//   - 'manual': dropdown + inline editable currency amount
// Read-only state (non-drafting scenario) renders the dropdown as
// plain text (no chevron), the amount as plain text. Stays inside
// the white/50 italic-ish typography of the standard sublabel area.
function ComparatorControl({
  mode,
  amount,
  sourceLabel,
  onModeChange,
  onAmountChange,
  readOnly,
}) {
  const [editingAmount, setEditingAmount] = useState(false)

  if (readOnly) {
    // Plain-text presentation in non-drafting states. The KPI math
    // still uses the stored amount; the user just can not change it
    // here.
    const modeText = mode === 'manual' ? 'Manual estimate' : (sourceLabel || 'no locked Budget available')
    const amountText = amount != null ? formatCurrency(amount) : null
    return (
      <span className="italic">
        vs. {modeText}{amountText && mode === 'manual' ? ` ${amountText}` : ''}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <select
        value={mode}
        onChange={(e) => onModeChange(e.target.value)}
        aria-label="Comparator source"
        className="bg-navy/40 text-white/85 border-[0.5px] border-white/15 rounded px-1 py-0.5 text-[11px] focus:outline-none focus:border-white/40 cursor-pointer"
      >
        <option value="locked_budget" className="text-navy">Latest locked Budget</option>
        <option value="manual" className="text-navy">Manual estimate</option>
      </select>
      <span className="italic">
        vs.&nbsp;
        {mode === 'locked_budget' ? (
          sourceLabel || 'expense estimate (no locked Budget available)'
        ) : (
          <>
            manual estimate&nbsp;
            {editingAmount ? (
              <ManualAmountEditor
                initial={amount}
                onSave={(v) => { onAmountChange(v); setEditingAmount(false) }}
                onCancel={() => setEditingAmount(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingAmount(true)}
                className="font-body not-italic underline-offset-2 hover:underline text-white/85"
                aria-label="Edit manual estimate"
                title="Click to edit"
              >
                {amount != null ? formatCurrency(amount) : '—'}
              </button>
            )}
          </>
        )}
      </span>
    </span>
  )
}

// Inline editor for the manual comparator amount. Same on-blur-saves
// pattern as the rest of the page.
function ManualAmountEditor({ initial, onSave, onCancel }) {
  const [draft, setDraft] = useState(
    initial === null || initial === undefined ? '' : String(initial)
  )
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function commit() {
    const s = String(draft ?? '').trim()
    if (s === '') {
      onSave(null)
      return
    }
    const cleaned = s.replace(/[$,()\s]/g, '')
    const n = Number(cleaned)
    if (!Number.isFinite(n) || n < 0) {
      setError('Amount must be a non-negative number')
      return
    }
    onSave(n)
  }

  return (
    <span className="inline-flex flex-col">
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
          }
        }}
        className="w-24 text-right bg-navy/40 text-white/85 border-[0.5px] border-white/40 rounded px-1 py-0.5 text-[11px] tabular-nums focus:outline-none focus:border-white"
        aria-label="Manual estimate amount"
      />
      {error && (
        <span className="text-status-red-bg text-[10px] italic mt-0.5">
          {error}
        </span>
      )}
    </span>
  )
}

// ----- Scenario Tabs (tuition-local; mirrors BudgetStage's pattern) -----
//
// Self-contained copy of the Budget scenario-tab pattern, reduced to
// tuition's scope (no findLockedSibling because lock workflow ships
// in Tuition-D — the sibling-locked guard is queued for that session).
// When Tuition-D lands the lock workflow, this component will gain
// the same lockedSibling gating that ScenarioTabs.jsx carries.

function ScenarioTabs({ scenarios, activeId, onSelect, onAdd, onAction, canEdit }) {
  return (
    <div role="tablist" aria-label="Scenarios" className="flex items-end gap-1 flex-wrap">
      {scenarios.map((s) => (
        <ScenarioTab
          key={s.id}
          scenario={s}
          active={s.id === activeId}
          onSelect={() => onSelect(s.id)}
          onAction={(action) => onAction(s.id, action)}
          canEdit={canEdit}
        />
      ))}
      {canEdit && (
        <button
          type="button"
          onClick={onAdd}
          className="ml-1 px-3 py-1.5 font-body text-[13px] text-status-blue hover:underline"
        >
          + New scenario
        </button>
      )}
    </div>
  )
}

function ScenarioTab({ scenario, active, onSelect, onAction, canEdit }) {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    function close() { setMenuOpen(false) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuOpen])

  const isLocked = scenario.state === 'locked' ||
                   scenario.state === 'pending_lock_review' ||
                   scenario.state === 'pending_unlock_review'

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-1.5 border-b-2 -mb-[0.5px] transition-colors ${
          active ? 'border-gold' : 'border-transparent hover:border-card-border'
        }`}
      >
        <button
          type="button"
          role="tab"
          aria-selected={active}
          onClick={onSelect}
          className={`px-3 py-1.5 font-body text-[13px] flex items-center gap-1.5 cursor-pointer ${
            active ? 'text-navy' : 'text-muted hover:text-navy'
          }`}
          title={scenario.description || undefined}
        >
          {scenario.is_recommended && (
            <span
              className="text-gold text-[12px] leading-none"
              aria-label="Recommended scenario"
              title="Recommended scenario"
            >
              ★
            </span>
          )}
          <span className="truncate max-w-[160px]">{scenario.scenario_label}</span>
        </button>

        {canEdit && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}
            aria-label={`Actions for ${scenario.scenario_label}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={`px-1.5 py-1 text-[14px] leading-none rounded transition-opacity ${
              active
                ? 'text-muted hover:text-navy hover:bg-cream-highlight'
                : 'opacity-0 hover:opacity-100 focus:opacity-100 group-hover:opacity-100 text-muted hover:bg-cream-highlight'
            }`}
          >
            ⋮
          </button>
        )}
      </div>

      {menuOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          role="menu"
          className="absolute left-0 top-full mt-1 w-56 bg-white border-[0.5px] border-card-border rounded-[8px] shadow-lg z-50 py-1"
        >
          {!scenario.is_recommended ? (
            <MenuItem
              onClick={() => { setMenuOpen(false); onAction('recommend') }}
              icon={<span className="text-gold text-[12px]">★</span>}
            >
              Mark as recommended
            </MenuItem>
          ) : (
            <MenuItem
              disabled
              icon={<span className="text-gold text-[12px]">★</span>}
            >
              Recommended scenario
            </MenuItem>
          )}
          <div className="border-t-[0.5px] border-card-border my-1" />
          <MenuItem onClick={() => { setMenuOpen(false); onAction('rename') }}>
            Rename…
          </MenuItem>
          <MenuItem onClick={() => { setMenuOpen(false); onAction('description') }}>
            Edit description…
          </MenuItem>
          <div className="border-t-[0.5px] border-card-border my-1" />
          <MenuItem
            danger
            onClick={() => { setMenuOpen(false); onAction('delete') }}
            disabled={isLocked}
            title={isLocked ? 'Locked scenarios cannot be deleted' : undefined}
          >
            Delete scenario…
          </MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({ children, onClick, disabled, danger, icon, title }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`w-full text-left px-4 py-2 font-body text-sm transition-colors ${
        disabled
          ? 'text-muted/50 cursor-not-allowed'
          : danger
            ? 'text-status-red hover:bg-status-red-bg'
            : 'text-body hover:bg-cream-highlight'
      }`}
    >
      <span className="flex items-center gap-2">
        {icon && <span className="flex-shrink-0">{icon}</span>}
        <span>{children}</span>
      </span>
    </button>
  )
}

// ----- Stats sidebar collapse persistence -----
const STATS_COLLAPSED_KEY = 'agora.tuitionStatsSidebar.collapsed'
function loadStatsCollapsed() {
  try {
    const saved = localStorage.getItem(STATS_COLLAPSED_KEY)
    if (saved === '1') return true
    if (saved === '0') return false
    return window.innerWidth < 1200
  } catch {
    return false
  }
}

// ====== Page ============================================================

function TuitionWorksheet() {
  const { user } = useAuth()
  const toast = useToast()
  const { allowed: canView, loading: permLoading } = useModulePermission('tuition', 'view')
  const { allowed: canEdit }      = useModulePermission('tuition', 'edit')

  // Stage metadata (loaded from module_workflow_stages) — drives the
  // page heading and is the source of truth for stage display name.
  // Per CLAUDE.md "Module workflows and stages": never hardcode
  // "Tuition Planning"; always read display_name dynamically.
  const [stage, setStage] = useState(null)
  const [stageError, setStageError] = useState(null)

  const [selectedAyeId, setSelectedAyeId] = useState(null)
  const [aye, setAye] = useState(null)

  const [scenarios, setScenarios] = useState([])
  const [activeScenarioId, setActiveScenarioId] = useState(null)
  const [dataLoading, setDataLoading] = useState(false)

  const [creating, setCreating] = useState(false)
  const [bootstrapError, setBootstrapError] = useState(null)

  const [newScenarioOpen, setNewScenarioOpen] = useState(false)
  const [settingsModal, setSettingsModal] = useState(null)

  const [statsCollapsed, setStatsCollapsed] = useState(loadStatsCollapsed)
  useEffect(() => {
    try { localStorage.setItem(STATS_COLLAPSED_KEY, statsCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [statsCollapsed])

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) || null,
    [scenarios, activeScenarioId]
  )

  // ---- stage resolve ---------------------------------------------------
  //
  // Tuition-B1 mounts the preliminary-typed stage of the tuition
  // workflow. The route is /modules/tuition (no stageId in URL); we
  // resolve the stage by joining modules → module_workflows →
  // module_workflow_stages and picking stage_type = 'preliminary'.
  // Tuition-D's audit page will be a separate route /modules/tuition/audit
  // (or /modules/tuition/:stageId) and resolve the final-typed stage.
  useEffect(() => {
    let mounted = true
    setStageError(null)
    ;(async () => {
      const { data, error } = await supabase
        .from('module_workflow_stages')
        .select('id, stage_type, display_name, short_name, sort_order, target_month, workflow_id, module_workflows!inner(module_id, modules!inner(code))')
        .eq('module_workflows.modules.code', 'tuition')
        .eq('stage_type', 'preliminary')
        .maybeSingle()
      if (!mounted) return
      if (error) {
        setStageError(error.message)
        setStage(null)
        return
      }
      if (!data) {
        setStageError('Tuition Planning stage not configured. Run Migration 022.')
        setStage(null)
        return
      }
      setStage({
        id: data.id,
        stage_type: data.stage_type,
        display_name: data.display_name,
        short_name: data.short_name,
        sort_order: data.sort_order,
        target_month: data.target_month,
        workflow_id: data.workflow_id,
      })
    })()
    return () => { mounted = false }
  }, [])

  // ---- data load -------------------------------------------------------

  const loadAyeContext = useCallback(async (ayeId, preferredActiveId = null) => {
    if (!stage?.id) return
    setDataLoading(true)
    setBootstrapError(null)

    const [ayeResult, scenariosResult] = await Promise.all([
      supabase.from('academic_years').select('id, label').eq('id', ayeId).single(),
      supabase
        .from('tuition_worksheet_scenarios')
        .select('id, scenario_label, description, is_recommended, state, created_at, locked_at, locked_by, locked_via, override_justification, tier_count, tier_rates, faculty_discount_pct, projected_faculty_discount_amount, projected_other_discount, projected_financial_aid, curriculum_fee_per_student, enrollment_fee_per_student, before_after_school_hourly_rate, projected_b_a_hours, projected_multi_student_discount, estimated_family_distribution, total_students, total_families, top_tier_avg_students_per_family, actual_before_after_school_hours, expense_comparator_mode, expense_comparator_amount, expense_comparator_source_label, unlock_requested, unlock_request_justification, unlock_requested_at, unlock_requested_by, unlock_approval_1_at, unlock_approval_1_by, unlock_approval_2_at, unlock_approval_2_by')
        .eq('aye_id', ayeId)
        .eq('stage_id', stage.id)
        .order('created_at', { ascending: true }),
    ])

    if (ayeResult.error)       { toast.error(ayeResult.error.message);       setDataLoading(false); return }
    if (scenariosResult.error) { toast.error(scenariosResult.error.message); setDataLoading(false); return }

    setAye(ayeResult.data)
    const list = scenariosResult.data || []
    setScenarios(list)

    let active = null
    if (preferredActiveId && list.some((s) => s.id === preferredActiveId)) {
      active = preferredActiveId
    } else if (activeScenarioId && list.some((s) => s.id === activeScenarioId)) {
      active = activeScenarioId
    } else if (list.length > 0) {
      active = list[0].id
    }
    setActiveScenarioId(active)
    setDataLoading(false)
  }, [activeScenarioId, stage?.id, toast])

  // Reload when AYE changes OR stage resolves.
  useEffect(() => {
    if (!selectedAyeId || !canView || !stage?.id) return
    let mounted = true
    ;(async () => {
      await loadAyeContext(selectedAyeId)
      if (!mounted) return
    })()
    return () => { mounted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAyeId, canView, stage?.id])

  // ---- bootstrap (empty state) -----------------------------------------
  //
  // Tuition deviates from Budget's three-option setup gateway. Per the
  // v3.8.2 commit-message note: bootstrap-from-prior is deferred until
  // AYE 2027; CSV import is permanently skipped (data shape too small
  // to warrant a CSV format). Single fresh-start path.

  async function handleCreateFirstScenario() {
    if (!selectedAyeId || !stage?.id) return
    setCreating(true)
    setBootstrapError(null)
    try {
      const { data, error } = await supabase
        .from('tuition_worksheet_scenarios')
        .insert({
          aye_id: selectedAyeId,
          stage_id: stage.id,
          scenario_label: 'Scenario 1',
          is_recommended: true,           // first scenario auto-marks recommended
          state: 'drafting',
          tier_count: 4,
          tier_rates: defaultTierRates(),
          faculty_discount_pct: 50.00,
          // v3.8.2 (B1.1): renamed + new fields
          projected_faculty_discount_amount: 0,
          projected_other_discount: 0,
          projected_financial_aid: 0,
          curriculum_fee_per_student: 0,
          enrollment_fee_per_student: 0,
          before_after_school_hourly_rate: 0,
          estimated_family_distribution: defaultFamilyDistribution(),
          total_students: null,
          total_families: null,
          top_tier_avg_students_per_family: null,
          // v3.8.3 (B1.2): two new columns. Both nullable; null until
          // the user enters a value or until persistFields recomputes
          // multi-student-discount on a save that sets the inputs.
          projected_b_a_hours: null,
          projected_multi_student_discount: null,
          created_by: user?.id ?? null,
          updated_by: user?.id ?? null,
        })
        .select('id')
        .single()
      if (error) throw error
      await loadAyeContext(selectedAyeId, data.id)
    } catch (e) {
      setBootstrapError(e.message || String(e))
    } finally {
      setCreating(false)
    }
  }

  // ---- field updates (direct-edit-with-undo) ---------------------------
  //
  // All four sections route their per-field edits through these
  // handlers. Optimistic UI: the local scenarios state updates
  // immediately, then the Supabase write fires; on error we revert.
  //
  // Save is implicit on every edit; the header's "Save" button is a
  // confidence affordance (it surfaces a toast).

  // v3.8.3 (B1.2): every persistFields call also recomputes
  // projected_multi_student_discount from the projected post-patch
  // state and persists it through to the column. This keeps the
  // stored value as the at-save snapshot of the math, so downstream
  // reads (lock snapshot capture, future RPC math) work without
  // recomputation. The math lives in tuitionMath.js for now and
  // will hoist into compute_tuition_scenario_kpis at Tuition-C.
  const persistFields = useCallback(async (fields) => {
    if (!activeScenario) return false
    const previous = { ...activeScenario }

    // Project the post-patch scenario state and recompute the
    // multi-student discount against it. Returns null when inputs
    // are insufficient (no total_students, no derived family_counts,
    // etc.); column accepts NULL.
    const projected = { ...activeScenario, ...fields }
    const newDiscount = computeProjectedMultiStudentDiscount(projected)
    const fullPatch = {
      ...fields,
      projected_multi_student_discount: newDiscount,
    }

    setScenarios((prev) =>
      prev.map((s) => (s.id === activeScenario.id ? { ...s, ...fullPatch } : s))
    )

    const { error } = await supabase
      .from('tuition_worksheet_scenarios')
      .update({ ...fullPatch, updated_by: user?.id ?? null })
      .eq('id', activeScenario.id)

    if (error) {
      // Revert optimistic update.
      setScenarios((prev) =>
        prev.map((s) => (s.id === activeScenario.id ? previous : s))
      )
      toast.error(error.message)
      return false
    }
    return true
  }, [activeScenario, user?.id, toast])

  // Generic field updater. For most fields a flat persistFields
  // suffices. For `total_students` and `top_tier_avg_students_per_family`
  // we additionally re-derive total_families when the user is tracking
  // the derived value (i.e., not overriding) so that derived family
  // counts stay consistent without manual recompute on the user's part.
  const handleUpdateField = useCallback(
    async (field, value) => {
      if (field === 'total_students' || field === 'top_tier_avg_students_per_family') {
        const totalFamilies = activeScenario?.total_families
        const oldDerived = computeTotalFamilies({
          totalStudents: activeScenario?.total_students,
          distribution: activeScenario?.estimated_family_distribution,
          topTierAvgStudents: activeScenario?.top_tier_avg_students_per_family,
        })
        const isTrackingDerived =
          totalFamilies != null
          && oldDerived != null
          && Number(totalFamilies) === Number(oldDerived)
        if (isTrackingDerived) {
          const nextStudents = field === 'total_students' ? value : activeScenario?.total_students
          const nextTopAvg = field === 'top_tier_avg_students_per_family' ? value : activeScenario?.top_tier_avg_students_per_family
          const newDerived = computeTotalFamilies({
            totalStudents: nextStudents,
            distribution: activeScenario?.estimated_family_distribution,
            topTierAvgStudents: nextTopAvg,
          })
          const dist = Array.isArray(activeScenario?.estimated_family_distribution)
            ? activeScenario.estimated_family_distribution
            : []
          const nextDist = applyDerivedFamilyCounts(dist, newDerived)
          return persistFields({
            [field]: value,
            total_families: newDerived,
            estimated_family_distribution: nextDist,
          })
        }
      }
      return persistFields({ [field]: value })
    },
    [activeScenario, persistFields]
  )

  const handleUpdateTierRates = useCallback(
    (rows) => persistFields({ tier_rates: rows, tier_count: rows.length }),
    [persistFields]
  )

  // Distribution save with optional family_count recomputation. The
  // section component buffers breakdown_pct edits locally and only
  // calls this handler when the breakdown sum is valid (100 ± 0.01)
  // OR cleared to zero. opts.recompute=true tells us to derive
  // family_count for each row from the current total_families before
  // saving, so the stored jsonb stays self-consistent for downstream
  // reads.
  const handleUpdateFamilyDistribution = useCallback(
    async (rows, opts = {}) => {
      const totalFamilies = activeScenario?.total_families
      const next = opts.recompute
        ? applyDerivedFamilyCounts(rows, totalFamilies)
        : rows
      // v3.8.2: when total_families is currently NOT overridden (i.e.,
      // sitting at the previously-derived value), changing breakdowns
      // can shift the derived total_families. We re-derive and update
      // total_families IFF the user has not actively overridden — we
      // detect that by comparing current total_families to the freshly-
      // computed derived value at the OLD distribution. If they match,
      // the user is "tracking derived" and we keep tracking; if they
      // diverge, the user has overridden and we leave total_families
      // alone (override sticks).
      const oldDerived = computeTotalFamilies({
        totalStudents: activeScenario?.total_students,
        distribution: activeScenario?.estimated_family_distribution,
        topTierAvgStudents: activeScenario?.top_tier_avg_students_per_family,
      })
      const isTrackingDerived =
        totalFamilies != null
        && oldDerived != null
        && Number(totalFamilies) === Number(oldDerived)
      if (isTrackingDerived) {
        const newDerived = computeTotalFamilies({
          totalStudents: activeScenario?.total_students,
          distribution: next,
          topTierAvgStudents: activeScenario?.top_tier_avg_students_per_family,
        })
        const finalDist = applyDerivedFamilyCounts(next, newDerived)
        return persistFields({
          estimated_family_distribution: finalDist,
          total_families: newDerived,
        })
      }
      return persistFields({ estimated_family_distribution: next })
    },
    [activeScenario, persistFields]
  )

  // Total families override semantics. isOverride=true: persist value
  // as the explicit override. isOverride=false: clear override; persist
  // the supplied derived value (which may be null if it cannot be
  // derived).
  const handleUpdateTotalFamilies = useCallback(
    async (value, isOverride) => {
      // Re-derive family_count for each row against the new
      // total_families so the stored jsonb stays consistent with
      // downstream reads.
      const dist = Array.isArray(activeScenario?.estimated_family_distribution)
        ? activeScenario.estimated_family_distribution
        : []
      const nextDist = applyDerivedFamilyCounts(dist, value)
      // Either branch persists value to total_families. The "override"
      // distinction matters only if we ever store an "is_override" flag
      // — today we infer override state by comparing total_families
      // against the live-derived value (see FamilyDistributionSection).
      // The flag is part of the API for future-proofing; B1.1 collapses
      // both branches to a single persist call.
      void isOverride
      return persistFields({
        total_families: value,
        estimated_family_distribution: nextDist,
      })
    },
    [activeScenario, persistFields]
  )

  // ---- scenario CRUD ---------------------------------------------------

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
            .from('tuition_worksheet_scenarios')
            .update({ is_recommended: false, updated_by: user?.id ?? null })
            .in('id', otherIds)
          if (clearErr) throw clearErr
        }
        const { error: setErr } = await supabase
          .from('tuition_worksheet_scenarios')
          .update({ is_recommended: true, updated_by: user?.id ?? null })
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
      if (!window.confirm(
        `Delete "${target.scenario_label}"? This cannot be undone.`
      )) {
        return
      }
      try {
        // family_details cascade-deletes via FK (Migration 022). The
        // scenario row is the only thing we need to delete here.
        const { error: scenarioErr } = await supabase
          .from('tuition_worksheet_scenarios')
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
        ? { scenario_label: label, updated_by: user?.id ?? null }
        : { description, updated_by: user?.id ?? null }
    const { error } = await supabase
      .from('tuition_worksheet_scenarios')
      .update(updates)
      .eq('id', settingsModal.scenarioId)
    if (error) throw error
    setSettingsModal(null)
    await loadAyeContext(selectedAyeId, activeScenarioId)
  }

  // ---- expense comparator (v3.8.7 / Tuition-C) -------------------------
  //
  // Stage 1 KPIs (Net Education Program Ratio, Breakeven Enrollment)
  // measure scenarios against an expense comparator the system fetches
  // from the most recent locked Budget OR the user enters manually.
  // The cart-and-horse problem (architecture §7.5: Tuition Planning
  // happens before same-AYE Preliminary Budget) means same-AYE
  // Preliminary is rarely available at planning time; the default
  // comparator is the prior-AYE Final.
  //
  // Persistence: stored on the scenario row in three columns
  // (expense_comparator_mode | _amount | _source_label). The page
  // reads these columns on render and writes them via persistFields
  // on dropdown change OR manual amount edit.
  //
  // Stale-detection: on scenario load with mode='locked_budget', the
  // page silently fetches the latest locked Budget via
  // get_latest_locked_budget_for_school. If the returned amount or
  // source label differs from stored values, persistFields refreshes
  // both columns. The change_log captures the drift for audit
  // history; the user is not interrupted with a modal or banner.

  const fetchLatestLockedBudget = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_latest_locked_budget_for_school', {
      p_school_id: null,  // single-tenant; param ignored
    })
    if (error) {
      // Silent failure path. The comparator stays at its stored
      // value; KPIs render against whatever amount is on the row
      // (may be null → em-dash).
      console.warn('get_latest_locked_budget_for_school failed:', error.message)
      return null
    }
    if (!data || data.length === 0) return null
    const row = data[0]
    return {
      totalExpenses: row.total_expenses != null ? Number(row.total_expenses) : null,
      sourceLabel: formatBudgetSourceLabel(row.aye, row.stage_type),
    }
  }, [])

  // Stale-detection effect: on activeScenario change OR mode change,
  // if mode='locked_budget', fetch the latest and refresh stored
  // values if they differ. Dependencies are narrow (id + mode) to
  // avoid re-firing on every persistFields update — amount/label
  // changes that come from this same effect would otherwise loop.
  useEffect(() => {
    if (!activeScenario) return
    if (activeScenario.expense_comparator_mode !== 'locked_budget') return

    let cancelled = false
    ;(async () => {
      const latest = await fetchLatestLockedBudget()
      if (cancelled) return
      const newAmount = latest ? latest.totalExpenses : null
      const newLabel = latest ? latest.sourceLabel : null
      const currentAmount = activeScenario.expense_comparator_amount
      const currentLabel = activeScenario.expense_comparator_source_label
      // Compare numerically for amount (Number === Number); strict for label.
      const amountChanged = (currentAmount == null) !== (newAmount == null)
        || (currentAmount != null && newAmount != null && Number(currentAmount) !== Number(newAmount))
      const labelChanged = currentLabel !== newLabel
      if (amountChanged || labelChanged) {
        await persistFields({
          expense_comparator_amount: newAmount,
          expense_comparator_source_label: newLabel,
        })
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScenario?.id, activeScenario?.expense_comparator_mode])

  // Dropdown change handler. Atomically updates mode + amount + source
  // label per the v3.8.7 spec.
  const handleComparatorModeChange = useCallback(async (newMode) => {
    if (newMode === 'locked_budget') {
      const latest = await fetchLatestLockedBudget()
      await persistFields({
        expense_comparator_mode: 'locked_budget',
        expense_comparator_amount: latest ? latest.totalExpenses : null,
        expense_comparator_source_label: latest ? latest.sourceLabel : null,
      })
    } else if (newMode === 'manual') {
      // Preserve existing amount; if null, try to seed from latest
      // locked Budget so the manual input is not blank.
      let nextAmount = activeScenario?.expense_comparator_amount
      if (nextAmount == null) {
        const latest = await fetchLatestLockedBudget()
        nextAmount = latest ? latest.totalExpenses : null
      }
      await persistFields({
        expense_comparator_mode: 'manual',
        expense_comparator_amount: nextAmount,
        expense_comparator_source_label: 'Manual estimate',
      })
    }
  }, [activeScenario, fetchLatestLockedBudget, persistFields])

  const handleComparatorAmountChange = useCallback(async (value) => {
    await persistFields({
      expense_comparator_amount: value,
    })
  }, [persistFields])

  // ---- stats (data-driven; direct sums in B1, computed KPIs in C) ------

  // v3.8.7 (Tuition-C): seven stats in final spec order. Projected
  // Families removed (not a Tuition Committee KPI by Jenna's framing);
  // Projected Students renamed to Projected Enrollment and promoted to
  // the leading position; Net Education Program Ratio (emphasized) and
  // Breakeven Enrollment added at the foot. Net Education Program
  // Ratio uses the customSublabelNode slot for the comparator
  // dropdown + manual amount control.
  //
  // All stats compute via tuitionMath helpers with strict null
  // propagation — em-dashes for missing core inputs (total_students,
  // tier rates, expense_comparator_amount) so a fresh scenario
  // surfaces "not yet entered" honestly.
  const stats = useMemo(() => {
    if (!activeScenario) return []
    const comparator = activeScenario.expense_comparator_amount

    // ComparatorControl is a JSX node passed into the stat object
    // via customSublabelNode. The Stat subcomponent renders it in
    // place of the standard text sublabel.
    const comparatorControl = (
      <ComparatorControl
        mode={activeScenario.expense_comparator_mode}
        amount={comparator}
        sourceLabel={activeScenario.expense_comparator_source_label}
        onModeChange={handleComparatorModeChange}
        onAmountChange={handleComparatorAmountChange}
        readOnly={activeScenario.state !== 'drafting' || !canEdit}
      />
    )

    return [
      {
        key: 'projected_enrollment',
        label: 'Projected Enrollment',
        value: activeScenario.total_students != null ? Number(activeScenario.total_students) : null,
        format: 'integer',
      },
      {
        key: 'projected_gross_tuition',
        label: 'Projected Gross Tuition',
        sublabel: 'Total students × Base rate',
        value: computeProjectedGrossAtTier1(activeScenario),
        format: 'currency',
      },
      {
        key: 'projected_ed_program_revenue',
        label: 'Projected Ed Program Revenue',
        sublabel: 'Gross Tuition + Fees + B&A',
        value: computeProjectedEdProgramRevenue(activeScenario),
        format: 'currency',
      },
      {
        key: 'total_projected_discounts',
        label: 'Total Projected Discounts',
        sublabel: 'Multi-Student + Faculty + Other + Financial Aid',
        value: sumTotalProjectedDiscounts(activeScenario),
        format: 'currency',
        // v3.8.4: always render parens per the universal accounting
        // parentheses convention for subtractive currency values.
        subtractive: true,
      },
      {
        key: 'net_projected_ed_program_revenue',
        label: 'Net Projected Ed Program Revenue',
        sublabel: 'Ed Program Revenue − Discounts',
        value: computeNetProjectedEdProgramRevenue(activeScenario),
        format: 'currency',
        emphasized: true,
      },
      {
        key: 'net_ed_program_ratio',
        label: 'Net Education Program Ratio',
        // Custom sublabel slot — comparator dropdown + manual amount
        // input. The standard sublabel field is unused for this stat.
        customSublabelNode: comparatorControl,
        value: computeNetEdProgramRatio(activeScenario, comparator),
        format: 'percent',
        emphasized: true,
      },
      {
        key: 'breakeven_enrollment',
        label: 'Breakeven Enrollment',
        sublabel: 'Enrollment needed to break even at this tuition rate',
        value: computeBreakevenEnrollment(activeScenario, comparator),
        format: 'integer',
      },
    ]
  }, [activeScenario, canEdit, handleComparatorModeChange, handleComparatorAmountChange])

  // ---- render branches -------------------------------------------------

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
        <Breadcrumb items={[{ label: 'Tuition' }, { label: stage?.short_name || 'Planning' }]} />
        <h1 className="font-display text-navy text-[28px] mb-3 leading-tight">
          You do not have access to this module.
        </h1>
        <p className="text-body mb-6">
          Tuition access requires the appropriate module permission.
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
        <Breadcrumb items={[{ label: 'Tuition' }, { label: 'Stage not found' }]} />
        <h1 className="font-display text-navy text-[28px] mb-3 leading-tight">
          Tuition stage not found.
        </h1>
        <p className="text-body mb-2">{stageError}</p>
        <p className="text-muted italic mb-6 text-sm">
          The stage may not have been seeded yet, or the workflow row was
          edited outside the migration. Contact a system admin.
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

  // Save-button enable rule mirrors Budget: enabled only when there's
  // a drafting scenario the user can edit.
  const saveDisabled =
    !activeScenario || !canEdit || activeScenario.state !== 'drafting'

  return (
    <AppShell>
      <div className="-mx-6 -my-6 flex flex-col h-[calc(100vh-3.5rem)]">
        <div className="px-6">
          {/* ----- Header zone ----- */}
          <header className="sticky top-0 z-20 bg-cream pt-1 pb-3 -mt-1 border-b-[0.5px] border-card-border">
            <Breadcrumb items={[{ label: 'Tuition' }, { label: stage.short_name }]} />

            <div className="flex items-end justify-between gap-4 flex-wrap">
              <div className="flex items-baseline gap-3 flex-wrap">
                <h1 className="font-display text-navy text-[26px] leading-tight">
                  {aye?.label ? `${aye.label} ${stage.display_name}` : stage.display_name}
                </h1>
                {activeScenario && <StateBadge state={activeScenario.state} />}
              </div>

              <div className="flex items-end gap-3 flex-wrap">
                <AYESelector value={selectedAyeId} onChange={setSelectedAyeId} />

                <div className="flex items-center gap-2">
                  <ActionButton
                    disabled={saveDisabled}
                    label="Save"
                    title={
                      saveDisabled
                        ? !activeScenario
                          ? 'No scenario selected'
                          : !canEdit
                            ? 'Edit permission required'
                            : `Scenario is ${activeScenario.state}; cannot save in this state.`
                        : 'Confirm changes are saved (changes auto-save on edit).'
                    }
                    onClick={() => toast.success('All changes are saved.')}
                  />
                </div>
              </div>
            </div>

            {scenarios.length > 0 && (
              <div className="mt-3 -mb-3 border-b-[0.5px] border-card-border flex items-end justify-between gap-4">
                <ScenarioTabs
                  scenarios={scenarios}
                  activeId={activeScenarioId}
                  onSelect={handleScenarioSelect}
                  onAdd={handleAddScenario}
                  onAction={handleScenarioAction}
                  canEdit={canEdit}
                />
                {/* Recent Activity affordance — stub in B1. The
                    activity feed query helper (src/lib/auditLog.js's
                    fetchScenarioActivity) is hardcoded to Budget's
                    table names today; generalizing it for Tuition is
                    a Tuition-D follow-up. The link is rendered as
                    disabled with an explanatory tooltip rather than
                    omitted entirely so the placement convention from
                    Budget carries forward. */}
                {activeScenario && (
                  <button
                    type="button"
                    disabled
                    title="Activity feed wires up in Tuition-D once auditLog.fetchScenarioActivity is generalized for tuition tables."
                    className="px-3 py-1.5 font-body text-[13px] text-muted/60 whitespace-nowrap flex-shrink-0 cursor-not-allowed"
                  >
                    Recent Activity
                  </button>
                )}
              </div>
            )}
          </header>
        </div>

        {/* ----- Body: configuration + sidebar ----- */}
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-2">
            {!selectedAyeId ? (
              <p className="text-muted italic mt-8">
                Pick an academic year to begin.
              </p>
            ) : dataLoading ? (
              <p className="text-muted mt-8">Loading…</p>
            ) : !activeScenario ? (
              canEdit ? (
                <TuitionEmptyState
                  ayeId={selectedAyeId}
                  ayeLabel={aye?.label}
                  stageDisplayName={stage.display_name}
                  onAyeChange={setSelectedAyeId}
                  onCreate={handleCreateFirstScenario}
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
              <TuitionConfigurationZone
                scenario={activeScenario}
                onUpdateField={handleUpdateField}
                onUpdateTierRates={handleUpdateTierRates}
                onUpdateFamilyDistribution={handleUpdateFamilyDistribution}
                onUpdateTotalFamilies={handleUpdateTotalFamilies}
                readOnly={readOnly}
              />
            )}
          </div>

          <StatsSidebar
            stats={stats}
            collapsed={statsCollapsed}
            onCollapseChange={setStatsCollapsed}
          />
        </div>
      </div>

      {newScenarioOpen && (
        <TuitionNewScenarioModal
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
    </AppShell>
  )
}

export default TuitionWorksheet
