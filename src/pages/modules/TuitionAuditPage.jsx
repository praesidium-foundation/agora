import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import { useToast } from '../../lib/Toast'
import {
  computeEnvelopesUsed,
  computeFamilyDistribution,
  computeNetTuitionForYear,
  naturalAppliedTierRate,
  naturalAppliedTierSize,
  tierDiscountPct,
} from '../../lib/tuitionMath'
import { formatCurrency, formatInteger } from '../../lib/format'
import AppShell from '../../components/AppShell'
import AYESelector from '../../components/AYESelector'
import Breadcrumb from '../../components/Breadcrumb'
import TuitionAuditEmptyState from '../../components/tuition/TuitionAuditEmptyState'
import TuitionFamilyDetailsTable from '../../components/tuition/TuitionFamilyDetailsTable'
import CaptureSnapshotModal from '../../components/tuition/CaptureSnapshotModal'
import SnapshotsPanel from '../../components/tuition/SnapshotsPanel'
import ActivityFeedModal from '../../components/budget/ActivityFeedModal'
import TuitionImportUploadModal from '../../components/tuition/TuitionImportUploadModal'

// Tuition Stage 2 (Tuition Audit) page — v3.8.16 (B2-final) redesign.
//
// Architecture §7.3 v3.8.16. Tuition Audit is a LIVING WORKING DOCUMENT
// maintained throughout the academic year. It has no lock workflow;
// the scenario stays in 'drafting' indefinitely. Reference points are
// captured via operator-triggered snapshots (Capture Snapshot button
// in the page header).
//
// Layout (3-card collapsible header + sticky table):
//
//   ┌─ Header ───────────────────────────────────────────────────────┐
//   │ Breadcrumb · Title · [▾] · Capture / Snapshots / Activity      │
//   ├─ Reference grid (collapsible, weighted 1:1.6:1) ───────────────┤
//   │ ┌ Tier Rates ┐ ┌ Discount Envelopes ┐ ┌ Enrolled Families ┐  │
//   │ └─────────────┘ └─────────────────────┘ └─────────────────────┘  │
//   ├─ Action bar ────────────────────────────────────────────────────┤
//   │ Sort By · + Add Family · + Import CSV · · · {N} fam · {M} stu │
//   ├─ Family table (15 columns, sticky header, vertical dividers) ──┤
//   │ ...                                                             │
//   └─────────────────────────────────────────────────────────────────┘
//
// Page state machine (gates inherited from B2a):
//   1. No Stage 1 lock for the AYE → cascade-blocked empty state
//   2. Stage 1 IS locked, no Stage 2 scenario → setup card with
//      "Begin Tuition Audit" button (calls create_tuition_scenario_
//      from_snapshot RPC)
//   3. Stage 2 scenario exists → render the editor

// ----- Sort logic ------------------------------------------------------

const SORT_OPTIONS = [
  { value: 'alphabetical', label: 'Alphabetical' },
  { value: 'date_enrolled_newest', label: 'Date enrolled (newest first)' },
  { value: 'date_enrolled_oldest', label: 'Date enrolled (oldest first)' },
  { value: 'date_withdrawn_newest', label: 'Date withdrawn (most recent first)' },
  { value: 'faculty_first', label: 'Faculty first' },
]

function sortFamilies(families, sortBy) {
  if (!Array.isArray(families)) return []
  const arr = [...families]
  const byName = (a, b) => (a.family_label || '').toLowerCase().localeCompare((b.family_label || '').toLowerCase())
  const dateAsc = (a, b) => {
    const aNull = !a, bNull = !b
    if (aNull && bNull) return 0
    if (aNull) return 1   // null at bottom regardless of asc/desc
    if (bNull) return -1
    return new Date(a) - new Date(b)
  }
  const dateDesc = (a, b) => {
    const aNull = !a, bNull = !b
    if (aNull && bNull) return 0
    if (aNull) return 1   // null at bottom
    if (bNull) return -1
    return new Date(b) - new Date(a)
  }
  switch (sortBy) {
    case 'alphabetical':
      return arr.sort(byName)
    case 'date_enrolled_newest':
      return arr.sort((a, b) => dateDesc(a.date_enrolled, b.date_enrolled) || byName(a, b))
    case 'date_enrolled_oldest':
      return arr.sort((a, b) => dateAsc(a.date_enrolled, b.date_enrolled) || byName(a, b))
    case 'date_withdrawn_newest':
      return arr.sort((a, b) => dateDesc(a.date_withdrawn, b.date_withdrawn) || byName(a, b))
    case 'faculty_first':
      return arr.sort((a, b) => {
        const af = a.is_faculty_family ? 0 : 1
        const bf = b.is_faculty_family ? 0 : 1
        if (af !== bf) return af - bf
        return byName(a, b)
      })
    default:
      return arr.sort(byName)
  }
}

// ----- Component -------------------------------------------------------

function TuitionAuditPage() {
  const { user } = useAuth()
  const toast = useToast()
  const { allowed: canView, loading: permLoading } = useModulePermission('tuition', 'view')
  const { allowed: canEdit } = useModulePermission('tuition', 'edit')

  const [stage, setStage] = useState(null)
  const [stage1, setStage1] = useState(null)
  const [stageError, setStageError] = useState(null)

  const [selectedAyeId, setSelectedAyeId] = useState(null)
  const [aye, setAye] = useState(null)

  const [stage1Loading, setStage1Loading] = useState(false)
  const [stage1Snapshot, setStage1Snapshot] = useState(null)

  const [scenarios, setScenarios] = useState([])
  const [activeScenarioId, setActiveScenarioId] = useState(null)
  const [families, setFamilies] = useState([])
  const [dataLoading, setDataLoading] = useState(false)
  const [seeding, setSeeding] = useState(false)

  // Header zone collapse state — persisted per scenario.
  const [headerCollapsed, setHeaderCollapsed] = useState(false)
  // Sort UI state.
  const [sortBy, setSortBy] = useState('alphabetical')
  // Display order — array of family ids representing current row order.
  // Sort applies on initial load and on sort-dropdown change ONLY;
  // mid-session edits and adds preserve the existing order. New rows
  // from + Add Family append to the end.
  const [displayOrder, setDisplayOrder] = useState([])

  // Modals / panels.
  const [captureModalOpen, setCaptureModalOpen] = useState(false)
  const [snapshotsPanelOpen, setSnapshotsPanelOpen] = useState(false)
  const [activityModalOpen, setActivityModalOpen] = useState(false)
  const [snapshotsRefreshKey, setSnapshotsRefreshKey] = useState(0)
  const [importModalOpen, setImportModalOpen] = useState(false)

  // ---- stage resolution ------------------------------------------------

  useEffect(() => {
    let mounted = true
    setStageError(null)
    ;(async () => {
      const { data, error } = await supabase
        .from('module_workflow_stages')
        .select('id, stage_type, display_name, short_name, sort_order, target_month, workflow_id, module_workflows!inner(module_id, modules!inner(code))')
        .eq('module_workflows.modules.code', 'tuition')
        .order('sort_order', { ascending: true })
      if (!mounted) return
      if (error) {
        setStageError(error.message)
        return
      }
      if (!data || data.length === 0) {
        setStageError('Tuition workflow stages not configured. Run Migration 022.')
        return
      }
      const final = data.find((s) => s.stage_type === 'final')
      const prelim = data.find((s) => s.stage_type === 'preliminary')
      if (!final) {
        setStageError('Tuition Audit stage (stage_type = final) not configured.')
        return
      }
      setStage(final)
      setStage1(prelim || null)
    })()
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!selectedAyeId) {
      setAye(null)
      return
    }
    let mounted = true
    ;(async () => {
      const { data, error } = await supabase
        .from('academic_years')
        .select('id, label')
        .eq('id', selectedAyeId)
        .single()
      if (!mounted) return
      if (error) { toast.error(error.message); return }
      setAye(data)
    })()
    return () => { mounted = false }
  }, [selectedAyeId, toast])

  useEffect(() => {
    if (!selectedAyeId || !stage1?.id || !canView) {
      setStage1Snapshot(null)
      return
    }
    let mounted = true
    setStage1Loading(true)
    ;(async () => {
      const { data, error } = await supabase
        .from('tuition_worksheet_snapshots')
        .select('id, stage_display_name_at_lock, scenario_label_at_lock, locked_at')
        .eq('aye_id', selectedAyeId)
        .eq('stage_id', stage1.id)
        .order('locked_at', { ascending: false })
        .limit(1)
      if (!mounted) return
      if (error) { toast.error(error.message); setStage1Snapshot(null) }
      else setStage1Snapshot(Array.isArray(data) && data.length > 0 ? data[0] : null)
      setStage1Loading(false)
    })()
    return () => { mounted = false }
  }, [selectedAyeId, stage1?.id, canView, toast])

  const stage1Locked = useMemo(() => stage1Snapshot != null, [stage1Snapshot])

  // ---- scenario + families load ----------------------------------------

  const loadScenarios = useCallback(async () => {
    if (!selectedAyeId || !stage?.id || !canView) {
      setScenarios([])
      setActiveScenarioId(null)
      return
    }
    setDataLoading(true)
    const { data, error } = await supabase
      .from('tuition_worksheet_scenarios')
      .select('id, scenario_label, description, is_recommended, state, created_at, locked_at, locked_by, locked_via, override_justification, tier_count, tier_rates, faculty_discount_pct, projected_faculty_discount_amount, projected_other_discount, projected_financial_aid, curriculum_fee_per_student, enrollment_fee_per_student, before_after_school_hourly_rate, projected_b_a_hours, projected_multi_student_discount, estimated_family_distribution, total_students, total_families, top_tier_avg_students_per_family, actual_before_after_school_hours, expense_comparator_mode, expense_comparator_amount, expense_comparator_source_label')
      .eq('aye_id', selectedAyeId)
      .eq('stage_id', stage.id)
      .order('created_at', { ascending: true })
    if (error) {
      toast.error(error.message)
      setDataLoading(false)
      return
    }
    setScenarios(data || [])
    if (data && data.length > 0) {
      setActiveScenarioId((prev) => {
        if (prev && data.some((s) => s.id === prev)) return prev
        return data[0].id
      })
    } else {
      setActiveScenarioId(null)
    }
    setDataLoading(false)
  }, [selectedAyeId, stage?.id, canView, toast])

  useEffect(() => { loadScenarios() }, [loadScenarios])

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) || null,
    [scenarios, activeScenarioId]
  )

  const loadFamilies = useCallback(async () => {
    if (!activeScenarioId) {
      setFamilies([])
      return
    }
    const { data, error } = await supabase
      .from('tuition_worksheet_family_details')
      .select('id, scenario_id, family_label, students_enrolled, applied_tier_size, applied_tier_rate, faculty_discount_amount, other_discount_amount, financial_aid_amount, notes, is_faculty_family, date_enrolled, date_withdrawn, created_at, updated_at')
      .eq('scenario_id', activeScenarioId)
      .order('created_at', { ascending: true })
    if (error) {
      toast.error(error.message)
      setFamilies([])
      return
    }
    setFamilies(data || [])
  }, [activeScenarioId, toast])

  useEffect(() => { loadFamilies() }, [loadFamilies])

  // ---- displayOrder sync (sort applies on first load + sort change) ----

  useEffect(() => {
    setDisplayOrder((prev) => {
      if (prev.length === 0) {
        // First load (or scenario switch) — apply current sortBy.
        return sortFamilies(families, sortBy).map((f) => f.id)
      }
      // Subsequent family-data refreshes — preserve order. Append
      // newly-added ids at the end; drop deleted ids.
      const existingIds = new Set(prev)
      const familyIds = new Set(families.map((f) => f.id))
      const filtered = prev.filter((id) => familyIds.has(id))
      const added = families.filter((f) => !existingIds.has(f.id)).map((f) => f.id)
      return [...filtered, ...added]
    })
    // sortBy is intentionally not a dep — sort applies only on
    // explicit user action (handleSortChange) or first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [families])

  // Reset displayOrder when scenario changes so the new scenario's
  // first load picks up the sort.
  useEffect(() => {
    setDisplayOrder([])
  }, [activeScenarioId])

  function handleSortChange(newSort) {
    setSortBy(newSort)
    setDisplayOrder(sortFamilies(families, newSort).map((f) => f.id))
  }

  const orderedFamilies = useMemo(() => {
    const byId = Object.fromEntries(families.map((f) => [f.id, f]))
    return displayOrder.map((id) => byId[id]).filter(Boolean)
  }, [families, displayOrder])

  // ---- Header collapse (per-scenario localStorage) ---------------------

  useEffect(() => {
    if (!activeScenarioId) return
    try {
      const key = `tuition-audit-header-collapsed-${activeScenarioId}`
      const stored = localStorage.getItem(key)
      setHeaderCollapsed(stored === 'true')
    } catch { /* ignore */ }
  }, [activeScenarioId])

  function toggleHeader() {
    setHeaderCollapsed((v) => {
      const next = !v
      try {
        if (activeScenarioId) {
          localStorage.setItem(`tuition-audit-header-collapsed-${activeScenarioId}`, next ? 'true' : 'false')
        }
      } catch { /* ignore */ }
      return next
    })
  }

  // ---- Setup-from-Stage-1 (create_tuition_scenario_from_snapshot) ------

  const handleSetupFromStage1 = useCallback(async () => {
    if (!stage1Snapshot || !stage?.id) return
    setSeeding(true)
    try {
      const { data, error } = await supabase.rpc('create_tuition_scenario_from_snapshot', {
        p_target_stage_id: stage.id,
        p_source_snapshot_id: stage1Snapshot.id,
        p_scenario_name: 'Audit',
      })
      if (error) throw error
      const newId = Array.isArray(data) ? data[0] : data
      await loadScenarios()
      if (newId) setActiveScenarioId(newId)
      toast.success(`Tuition Audit set up from ${stage1Snapshot.stage_display_name_at_lock}.`)
    } catch (e) {
      toast.error(e.message || String(e))
    } finally {
      setSeeding(false)
    }
  }, [stage1Snapshot, stage?.id, loadScenarios, toast])

  // ---- Family CRUD -----------------------------------------------------

  const handleUpdateRow = useCallback(async (familyId, patch) => {
    if (!familyId) return false
    const previous = families.find((f) => f.id === familyId)
    if (!previous) return false
    setFamilies((prev) => prev.map((f) => (f.id === familyId ? { ...f, ...patch } : f)))
    const { error } = await supabase
      .from('tuition_worksheet_family_details')
      .update({ ...patch, updated_by: user?.id ?? null })
      .eq('id', familyId)
    if (error) {
      setFamilies((prev) => prev.map((f) => (f.id === familyId ? previous : f)))
      toast.error(error.message)
      return false
    }
    return true
  }, [families, user?.id, toast])

  const handleAddFamily = useCallback(async () => {
    if (!activeScenario) return
    const seedFamily = { students_enrolled: 1, is_faculty_family: false }
    const tierSize = naturalAppliedTierSize(seedFamily, activeScenario)
    const tierRate = naturalAppliedTierRate(seedFamily, activeScenario)
    const { error } = await supabase
      .from('tuition_worksheet_family_details')
      .insert({
        scenario_id: activeScenario.id,
        family_label: '',
        students_enrolled: 1,
        applied_tier_size: tierSize,
        applied_tier_rate: tierRate,
        faculty_discount_amount: null,
        other_discount_amount: null,
        financial_aid_amount: null,
        notes: null,
        is_faculty_family: false,
        date_enrolled: null,
        date_withdrawn: null,
        created_by: user?.id ?? null,
        updated_by: user?.id ?? null,
      })
    if (error) {
      toast.error(error.message)
      return
    }
    await loadFamilies()
  }, [activeScenario, user?.id, loadFamilies, toast])

  const handleDeleteRow = useCallback(async (familyId) => {
    if (!familyId) return
    const target = families.find((f) => f.id === familyId)
    if (!target) return
    if (!window.confirm(
      `Remove ${target.family_label || 'this family'}? This action is recorded in the audit log.`
    )) {
      return
    }
    const { error } = await supabase
      .from('tuition_worksheet_family_details')
      .delete()
      .eq('id', familyId)
    if (error) { toast.error(error.message); return }
    await loadFamilies()
  }, [families, loadFamilies, toast])

  function handleImportCsvClick() {
    setImportModalOpen(true)
  }

  function handleSnapshotCaptured() {
    setCaptureModalOpen(false)
    setSnapshotsRefreshKey((k) => k + 1)
  }

  // ------- render branches ----------------------------------------------

  if (permLoading) {
    return <AppShell><p className="text-muted">Loading…</p></AppShell>
  }

  if (!canView) {
    return (
      <AppShell>
        <Breadcrumb items={[{ label: 'Tuition' }, { label: stage?.short_name || 'Audit' }]} />
        <h1 className="font-display text-navy text-[28px] mb-3 leading-tight">
          You do not have access to this module.
        </h1>
        <p className="text-body mb-6">
          Tuition access requires the appropriate module permission.
        </p>
        <Link to="/dashboard" className="inline-block bg-navy text-gold px-4 py-2 rounded text-sm hover:opacity-90 transition-opacity">
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
          Tuition Audit stage not found.
        </h1>
        <p className="text-body mb-2">{stageError}</p>
        <Link to="/dashboard" className="inline-block bg-navy text-gold px-4 py-2 rounded text-sm hover:opacity-90 transition-opacity">
          Back to Dashboard
        </Link>
      </AppShell>
    )
  }

  if (!stage) {
    return <AppShell><p className="text-muted">Loading stage…</p></AppShell>
  }

  const readOnly = !canEdit || (activeScenario && activeScenario.state !== 'drafting')
  const distribution = computeFamilyDistribution(families)
  const envelopes = activeScenario ? computeEnvelopesUsed(families, activeScenario) : null
  const netForYear = activeScenario ? computeNetTuitionForYear(families, activeScenario) : null

  return (
    <AppShell>
      <div className="-mx-6 -my-6 flex flex-col h-[calc(100vh-3.5rem)]">
        <div className="px-6 py-4 flex-1 overflow-y-auto">

          {/* Page header — breadcrumb + title row + page actions */}
          <header className="mb-4">
            <Breadcrumb items={[{ label: 'Tuition' }, { label: stage.short_name }]} />

            <div className="flex items-end justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                {activeScenario && (
                  <button
                    type="button"
                    onClick={toggleHeader}
                    aria-label={headerCollapsed ? 'Expand reference header' : 'Collapse reference header'}
                    aria-expanded={!headerCollapsed}
                    className="text-gold/70 hover:text-gold text-[12px] leading-none"
                  >
                    {headerCollapsed ? '▸' : '▾'}
                  </button>
                )}
                <h1 className="font-display text-navy text-[26px] leading-tight">
                  {aye?.label ? `${aye.label} ${stage.display_name}` : stage.display_name}
                </h1>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                {!activeScenario && (
                  <AYESelector value={selectedAyeId} onChange={setSelectedAyeId} />
                )}
                {activeScenario && (
                  <>
                    <AYESelector value={selectedAyeId} onChange={setSelectedAyeId} />
                    <button
                      type="button"
                      onClick={() => setCaptureModalOpen(true)}
                      disabled={readOnly}
                      className="bg-navy text-gold border-[0.5px] border-navy px-3.5 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Capture a snapshot of the current Tuition Audit state."
                    >
                      Capture Snapshot
                    </button>
                    <button
                      type="button"
                      onClick={() => setSnapshotsPanelOpen(true)}
                      className="font-body text-status-blue hover:underline text-sm"
                    >
                      Snapshots
                    </button>
                    <button
                      type="button"
                      onClick={() => setActivityModalOpen(true)}
                      className="font-body text-status-blue hover:underline text-sm"
                    >
                      Recent Activity
                    </button>
                  </>
                )}
              </div>
            </div>
          </header>

          {/* Body branches */}
          {!selectedAyeId ? (
            <p className="text-muted italic mt-8">Pick an academic year to begin.</p>
          ) : stage1Loading || dataLoading ? (
            <p className="text-muted mt-8">Loading…</p>
          ) : !stage1Locked ? (
            <TuitionAuditEmptyState
              ayeLabel={aye?.label}
              stageDisplayName={stage.display_name}
              stage1DisplayName={stage1?.display_name || 'Tuition Planning'}
              stage1AnyLocked={false}
            />
          ) : !activeScenario ? (
            <SetupFromStage1Card
              stage1Snapshot={stage1Snapshot}
              stage1DisplayName={stage1?.display_name || 'Tuition Planning'}
              stageDisplayName={stage.display_name}
              ayeLabel={aye?.label}
              onSetup={handleSetupFromStage1}
              seeding={seeding}
              canEdit={canEdit}
            />
          ) : (
            <>
              {/* Reference card grid (collapsible) */}
              <div
                className={`grid gap-4 transition-all duration-200 ease-out overflow-hidden ${
                  headerCollapsed ? 'max-h-0 mb-0 opacity-0' : 'max-h-[1000px] mb-4 opacity-100'
                }`}
                style={{ gridTemplateColumns: '1fr 1.6fr 1fr' }}
              >
                <TierRatesCard scenario={activeScenario} />
                <DiscountEnvelopesCard envelopes={envelopes} />
                <EnrolledFamiliesCard distribution={distribution} netForYear={netForYear} />
              </div>

              {/* Action bar */}
              <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <label className="font-body text-[11px] text-muted uppercase tracking-wider">
                    Sort By
                  </label>
                  <select
                    value={sortBy}
                    onChange={(e) => handleSortChange(e.target.value)}
                    className="bg-white border-[0.5px] border-card-border text-body px-2 py-1.5 rounded text-[12px]"
                  >
                    {SORT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  {!readOnly && (
                    <>
                      <button
                        type="button"
                        onClick={handleAddFamily}
                        className="font-body text-[13px] border-[0.5px] border-card-border bg-white hover:bg-cream-highlight text-navy px-3 py-1.5 rounded transition-colors"
                      >
                        + Add Family
                      </button>
                      <button
                        type="button"
                        onClick={handleImportCsvClick}
                        className="font-body text-[13px] border-[1px] border-dashed border-muted/50 text-muted/80 hover:text-navy hover:border-navy/40 px-3 py-1.5 rounded transition-colors"
                        title="Bulk import via CSV is coming in the next session."
                      >
                        + Import CSV
                      </button>
                    </>
                  )}
                </div>
                <p className="font-body text-muted text-[12px] tabular-nums">
                  {distribution.totalFamilies} {distribution.totalFamilies === 1 ? 'family' : 'families'}
                  {' · '}
                  {distribution.totalStudents} {distribution.totalStudents === 1 ? 'student' : 'students'}
                </p>
              </div>

              {/* Family table */}
              <TuitionFamilyDetailsTable
                families={orderedFamilies}
                scenario={activeScenario}
                readOnly={readOnly}
                onUpdateRow={handleUpdateRow}
                onDeleteRow={handleDeleteRow}
              />
            </>
          )}
        </div>
      </div>

      {captureModalOpen && activeScenario && (
        <CaptureSnapshotModal
          scenario={activeScenario}
          ayeLabel={aye?.label}
          onCancel={() => setCaptureModalOpen(false)}
          onSuccess={handleSnapshotCaptured}
        />
      )}

      {snapshotsPanelOpen && activeScenario && (
        <SnapshotsPanel
          scenarioId={activeScenario.id}
          refreshKey={snapshotsRefreshKey}
          onClose={() => setSnapshotsPanelOpen(false)}
        />
      )}

      {activityModalOpen && activeScenario && (
        <ActivityFeedModal
          moduleId="tuition"
          scenarioId={activeScenario.id}
          accountsById={null}
          onClose={() => setActivityModalOpen(false)}
        />
      )}

      {importModalOpen && activeScenario && (
        <TuitionImportUploadModal
          scenario={activeScenario}
          ayeLabel={aye?.label}
          onCancel={() => setImportModalOpen(false)}
          onSuccess={() => setImportModalOpen(false)}
        />
      )}
    </AppShell>
  )
}

// ----- Reference cards -------------------------------------------------

function TierRatesCard({ scenario }) {
  const rates = Array.isArray(scenario?.tier_rates) ? [...scenario.tier_rates] : []
  rates.sort((a, b) => (Number(a.tier_size) || 0) - (Number(b.tier_size) || 0))
  const baseRow = rates.find((r) => Number(r.tier_size) === 1)
  const baseRate = baseRow ? Number(baseRow.per_student_rate) || 0 : 0
  const curriculumFee = Number(scenario?.curriculum_fee_per_student) || 0
  const baHourlyRate = Number(scenario?.before_after_school_hourly_rate) || 0

  return (
    <Card title="Tier Rates">
      <ul className="space-y-1 text-[13px]">
        {rates.map((r) => {
          const tierSize = Number(r.tier_size)
          const isBase = tierSize === 1
          const rate = Number(r.per_student_rate) || 0
          const discountPct = isBase ? null : tierDiscountPct(rate, baseRate)
          return (
            <li key={tierSize} className="grid grid-cols-[1fr_auto_60px] gap-2 items-baseline">
              <span className="text-body">
                {isBase ? 'Base (1 student)' : `${tierSize === '4+' ? '4+' : tierSize}${tierSize === '4+' ? '' : tierSize >= 4 ? '+ students' : ' students'}`.replace(/^4\+ students$/, '4+ students')}
              </span>
              <span className="tabular-nums text-navy text-right">
                {formatCurrency(rate)}
              </span>
              <span className="tabular-nums text-muted text-right text-[12px]">
                {discountPct == null ? '—' : `−${(Math.round(discountPct * 10) / 10).toFixed(1)}%`}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="font-body text-muted italic text-[11px] mt-3 pt-2 border-t-[0.5px] border-card-border/60">
        Curriculum fee {formatCurrency(curriculumFee)} · B&A care {formatCurrency(baHourlyRate)}/hr
      </p>
    </Card>
  )
}

function DiscountEnvelopesCard({ envelopes }) {
  if (!envelopes) return <Card title="Discounts" />
  const { rows, total } = envelopes

  return (
    <Card title="Discounts">
      <div className="grid grid-cols-[120px_1fr_75px_75px_85px] gap-x-3 gap-y-1.5 items-baseline text-[12px]">
        {/* Header row (column legends) */}
        <span />
        <span />
        <span className="font-body text-muted uppercase tracking-wider text-[10px] text-right">Budget</span>
        <span className="font-body text-muted uppercase tracking-wider text-[10px] text-right">Used</span>
        <span className="font-body text-muted uppercase tracking-wider text-[10px] text-right">Remaining</span>

        {rows.map((row) => (
          <EnvelopeRow key={row.key} row={row} />
        ))}

        {/* Total row. Budget renders as a positive amount (it's a
            projected envelope, not a realized debit). Used renders
            in parens (realized discount; conceptually a debit
            against tuition revenue). Remaining renders conditional:
            positive → green; negative (over-budget) → red parens. */}
        <span className="text-body font-medium border-t-[0.5px] border-card-border pt-1.5 mt-0.5">{total.label}</span>
        <span className="border-t-[0.5px] border-card-border pt-1.5 mt-0.5" />
        <span className="tabular-nums text-navy text-right border-t-[0.5px] border-card-border pt-1.5 mt-0.5">
          {formatCurrency(total.budget)}
        </span>
        <span className="tabular-nums text-navy text-right border-t-[0.5px] border-card-border pt-1.5 mt-0.5">
          {formatCurrency(total.used, { subtractive: true })}
        </span>
        <span className={`tabular-nums text-right border-t-[0.5px] border-card-border pt-1.5 mt-0.5 ${
          total.remaining < 0 ? 'text-status-red' : 'text-status-green'
        }`}>
          {formatCurrency(total.remaining, { subtractive: total.remaining < 0 })}
        </span>
      </div>
    </Card>
  )
}

function EnvelopeRow({ row }) {
  const overBudget = row.used > row.budget && row.budget > 0
  const pct = row.budget > 0 ? Math.min(100, (row.used / row.budget) * 100) : (row.used > 0 ? 100 : 0)
  return (
    <>
      <span className="text-body">{row.label}</span>
      <span className="h-2 bg-cream-highlight/60 rounded-full overflow-hidden self-center">
        <span
          className={`block h-full rounded-full ${overBudget ? 'bg-status-red' : 'bg-status-green'}`}
          style={{ width: `${pct}%` }}
          aria-label={`${Math.round(pct)}% used`}
        />
      </span>
      {/* Budget: positive number; the envelope is a projection, not a
          realized debit. Used: parens (realized discount = subtractive).
          Remaining: conditional — positive green, negative red parens. */}
      <span className="tabular-nums text-navy text-right">
        {formatCurrency(row.budget)}
      </span>
      <span className="tabular-nums text-navy text-right">
        {formatCurrency(row.used, { subtractive: true })}
      </span>
      <span className={`tabular-nums text-right ${row.remaining < 0 ? 'text-status-red' : 'text-status-green'}`}>
        {formatCurrency(row.remaining, { subtractive: row.remaining < 0 })}
      </span>
    </>
  )
}

function EnrolledFamiliesCard({ distribution, netForYear }) {
  return (
    <Card title="Enrolled Families">
      <ul className="space-y-1 text-[13px]">
        {distribution.tiers.map((t) => (
          <li key={t.tier_size} className="grid grid-cols-[1fr_50px_50px] gap-2 items-baseline">
            <span className="text-body">
              {t.tier_size === '4+' ? '4+ students' : t.tier_size === 1 ? '1 student' : `${t.tier_size} students`}
            </span>
            <span className="tabular-nums text-navy text-right">
              {formatInteger(t.count)}
            </span>
            <span className="tabular-nums text-muted text-right text-[12px]">
              {t.pct}%
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 pt-2 border-t-[0.5px] border-card-border/60">
        <p className="text-body text-[13px] flex items-baseline justify-between">
          <span>Total</span>
          <span className="tabular-nums">
            <strong className="font-medium">{distribution.totalFamilies}</strong> fam · <strong className="font-medium">{distribution.totalStudents}</strong> stu
          </span>
        </p>
        <p className="text-body text-[13px] flex items-baseline justify-between mt-1">
          <span>NET tuition for year</span>
          <span className="tabular-nums text-navy font-medium">
            {formatCurrency(netForYear)}
          </span>
        </p>
      </div>
    </Card>
  )
}

function Card({ title, children }) {
  return (
    <section className="bg-white border-[0.5px] border-card-border rounded-[8px] p-4 shadow-sm">
      <h2 className="font-display text-navy text-[12px] uppercase tracking-[0.1em] mb-3">
        {title}
      </h2>
      {children}
    </section>
  )
}

// ----- Setup card (Stage 1 locked, no Stage 2 yet) ---------------------

function SetupFromStage1Card({
  stage1Snapshot, stage1DisplayName, stageDisplayName, ayeLabel,
  onSetup, seeding, canEdit,
}) {
  const dateStr = stage1Snapshot?.locked_at
    ? new Date(stage1Snapshot.locked_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : '—'
  return (
    <div className="flex items-center justify-center min-h-[60vh] py-6">
      <div className="bg-white border-[0.5px] border-card-border rounded-[10px] p-6 max-w-2xl w-full shadow-sm">
        <h2 className="font-display text-navy text-[22px] mb-2 leading-tight">
          Set up your {stageDisplayName}
        </h2>
        <p className="font-body text-body text-sm leading-relaxed mb-2">
          <strong className="font-medium">{stage1DisplayName}</strong> is
          locked for {ayeLabel || 'this academic year'} (locked{' '}
          <strong className="font-medium">{dateStr}</strong>). The audit
          seeds from this snapshot — tier rates, fee structures, and
          discount envelopes copy forward as the audit baseline. Per-
          family detail entry begins from there.
        </p>
        <p className="font-body italic text-muted text-sm leading-relaxed mb-5">
          The locked Stage 1 snapshot remains in audit history; this
          creates a separate, editable Stage 2 scenario.
        </p>
        <button
          type="button"
          onClick={onSetup}
          disabled={!canEdit || seeding}
          className="inline-block bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          title={!canEdit ? 'Tuition edit permission required to set up Stage 2.' : undefined}
        >
          {seeding ? 'Setting up…' : 'Begin Tuition Audit'}
        </button>
      </div>
    </div>
  )
}

export default TuitionAuditPage
