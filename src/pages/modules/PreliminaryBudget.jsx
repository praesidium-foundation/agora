import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import {
  createBlankScenario,
  createScenarioFromCsvRows,
  createScenarioFromPriorAye,
  resetScenario,
} from '../../lib/budgetBootstrap'
import AppShell from '../../components/AppShell'
import AYESelector from '../../components/AYESelector'
import Breadcrumb from '../../components/Breadcrumb'
import Badge from '../../components/Badge'
import KpiSidebar from '../../components/budget/KpiSidebar'
import BudgetEmptyState from '../../components/budget/BudgetEmptyState'
import CsvImportModal from '../../components/budget/CsvImportModal'

// Preliminary Budget — three-zone shell (header + KPI sidebar + detail).
//
// Commit B (this commit) ships:
//   - sticky header with breadcrumb, AYE selector, scenario state badge,
//     placeholder action buttons, and a kebab menu with "Reset scenario"
//   - KPI sidebar shell (real numbers land in Commit C)
//   - empty state with three start options when the AYE has no scenario
//   - bootstrap flows (Start with $0, Upload CSV, Bootstrap from prior AYE)
//
// Commit C wires the real detail view, real KPI math, inline COA add,
// auto-detect banner, and direct-edit-with-undo. The placeholder detail
// for now is a small "scenario loaded — detail view lands in Commit C"
// card so the bootstrap flow's success state is visually meaningful
// without overpromising what's wired up.
//
// Multi-scenario tabs land in Commit D; this version assumes a single
// scenario per AYE and just picks the first one returned.

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

// The header zone renders sticky at the top of the working area: breadcrumb
// + page title with state badge, AYE selector, and the action affordances.
// Action buttons are wired to no-ops in Commit B; Commits D / E / F /
// (PDF) replace them with real handlers.
function HeaderZone({
  ayeLabel,
  selectedAyeId,
  onAyeChange,
  scenario,
  onResetClick,
  resetting,
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  // Close kebab on outside click. A real popper would be nicer; this is a
  // single-item menu so the simple click-the-document handler is fine.
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

          {/* Action buttons. Disabled affordances in Commit B; full wire-up
              lands across Commits C–F. Rendered now so the layout doesn't
              shift when functionality arrives. */}
          <div className="flex items-center gap-2">
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

// Placeholder for the detail zone. Commit C replaces this with the
// hierarchical Display Style A render + direct-edit-with-undo. Showing
// something concrete here makes the bootstrap success state legible
// even though the real editing isn't wired yet.
function DetailZonePlaceholder({ scenario, lineCount }) {
  return (
    <div className="px-2 py-6">
      <div className="bg-white border-[0.5px] border-card-border rounded-[10px] px-6 py-8 max-w-2xl">
        <div className="flex items-baseline gap-3 mb-2">
          <h2 className="font-display text-navy text-[20px] leading-tight">
            {scenario.scenario_label}
          </h2>
          {scenario.is_recommended && (
            <Badge variant="navy">Recommended</Badge>
          )}
        </div>
        {scenario.description && (
          <p className="font-body italic text-muted text-sm mb-4">
            {scenario.description}
          </p>
        )}
        <p className="font-body text-body text-sm mb-2">
          Scenario created with <strong>{lineCount}</strong> budget line
          {lineCount === 1 ? '' : 's'}.
        </p>
        <p className="font-body italic text-muted text-sm leading-relaxed">
          The hierarchical detail view, KPI computation, inline COA add, and
          direct-edit-with-undo are scheduled for the next commit. Use Reset
          scenario in the menu above to return to the empty state and try
          another bootstrap path.
        </p>
      </div>
    </div>
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

  const [selectedAyeId, setSelectedAyeId] = useState(null)
  const [aye, setAye] = useState(null)

  // Active scenario for this AYE. null when none exists (empty state).
  const [scenario, setScenario] = useState(null)
  const [lineCount, setLineCount] = useState(0)

  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError] = useState(null)

  // Bootstrap-flow state.
  const [creating, setCreating] = useState(false)
  const [bootstrapError, setBootstrapError] = useState(null)
  const [bootstrapNotice, setBootstrapNotice] = useState(null)
  const [csvOpen, setCsvOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  // Load AYE + first scenario for the selected AYE. Scenarios beyond the
  // first land in Commit D's tab UI; for B we just pick the earliest one.
  useEffect(() => {
    if (!selectedAyeId || !canView) return

    let mounted = true
    async function load() {
      setDataLoading(true)
      setDataError(null)
      setBootstrapError(null)
      setBootstrapNotice(null)

      const [ayeResult, scenarioResult] = await Promise.all([
        supabase
          .from('academic_years')
          .select('id, label')
          .eq('id', selectedAyeId)
          .single(),
        supabase
          .from('preliminary_budget_scenarios')
          .select('id, scenario_label, description, is_recommended, state, narrative, show_narrative_in_pdf')
          .eq('aye_id', selectedAyeId)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle(),
      ])

      if (!mounted) return

      if (ayeResult.error) {
        setDataError(ayeResult.error.message)
        setDataLoading(false)
        return
      }
      setAye(ayeResult.data)

      if (scenarioResult.error) {
        setDataError(scenarioResult.error.message)
        setDataLoading(false)
        return
      }
      setScenario(scenarioResult.data || null)

      if (scenarioResult.data) {
        const { count, error: countErr } = await supabase
          .from('preliminary_budget_lines')
          .select('id', { count: 'exact', head: true })
          .eq('scenario_id', scenarioResult.data.id)
        if (!mounted) return
        if (countErr) {
          setDataError(countErr.message)
        } else {
          setLineCount(count || 0)
        }
      } else {
        setLineCount(0)
      }

      setDataLoading(false)
    }

    load()
    return () => { mounted = false }
  }, [selectedAyeId, canView])

  // Bootstrap handlers. Each catches its own errors and surfaces them on
  // the empty state so the prompt remains visible if creation fails.
  async function handleStartBlank() {
    setCreating(true)
    setBootstrapError(null)
    setBootstrapNotice(null)
    try {
      const result = await createBlankScenario({
        ayeId: selectedAyeId,
        userId: user?.id,
      })
      // Re-fetch so state badge / line count etc. come from the DB rather
      // than guessing client-side.
      await reloadScenario(result.scenarioId)
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
      await reloadScenario(result.scenarioId)
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
      userId: user?.id,
      rows,
    })
    setCsvOpen(false)
    await reloadScenario(result.scenarioId)
  }

  async function handleResetScenario() {
    if (!scenario) return
    if (!window.confirm(
      `Reset "${scenario.scenario_label}"? All ${lineCount} line(s) will be deleted ` +
      `and the scenario will return to the empty start prompt. The scenario ` +
      `itself (label, description) is preserved.`
    )) {
      return
    }
    setResetting(true)
    setDataError(null)
    try {
      await resetScenario(scenario.id)
      // Scenario row stays; line count goes to zero. Re-display the empty
      // state for that scenario so the user can pick a new bootstrap path.
      // (We achieve this by clearing the local scenario reference — the
      // empty state component creates a NEW scenario on its next path.
      // Future Commit D can teach this to restore the existing scenario.)
      // For Commit B simplicity: drop the scenario row entirely so the
      // user lands cleanly back at the empty state. That trade-off:
      // recreating the row loses any description the user typed. Worth
      // revisiting in D when scenarios are user-named.
      const { error } = await supabase
        .from('preliminary_budget_scenarios')
        .delete()
        .eq('id', scenario.id)
      if (error) throw error
      setScenario(null)
      setLineCount(0)
    } catch (e) {
      setDataError(e.message || String(e))
    } finally {
      setResetting(false)
    }
  }

  async function reloadScenario(scenarioId) {
    const { data, error } = await supabase
      .from('preliminary_budget_scenarios')
      .select('id, scenario_label, description, is_recommended, state, narrative, show_narrative_in_pdf')
      .eq('id', scenarioId)
      .single()
    if (error) {
      setBootstrapError(error.message)
      return
    }
    setScenario(data)
    const { count, error: countErr } = await supabase
      .from('preliminary_budget_lines')
      .select('id', { count: 'exact', head: true })
      .eq('scenario_id', scenarioId)
    if (countErr) {
      setBootstrapError(countErr.message)
      return
    }
    setLineCount(count || 0)
  }

  // ------- render branches ------------------------------------------------

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

  return (
    <AppShell>
      <div className="-mx-6 -my-6 flex flex-col h-[calc(100vh-3.5rem)]">
        {/* Header zone (sticky). The negative margins above pull the zone
            flush to the AppShell's edges so the sticky header spans the
            full working-area width. */}
        <div className="px-6">
          <HeaderZone
            ayeLabel={aye?.label}
            selectedAyeId={selectedAyeId}
            onAyeChange={setSelectedAyeId}
            scenario={scenario}
            onResetClick={handleResetScenario}
            resetting={resetting}
          />
        </div>

        {/* Body: KPI sidebar + detail zone. Detail zone scrolls; sidebar
            is its own scroll container. */}
        <div className="flex-1 flex overflow-hidden">
          <KpiSidebar />

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
              <DetailZonePlaceholder scenario={scenario} lineCount={lineCount} />
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
    </AppShell>
  )
}

export default PreliminaryBudget
