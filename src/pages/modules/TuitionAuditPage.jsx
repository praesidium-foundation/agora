import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import { useToast } from '../../lib/Toast'
import {
  computeFamilyFacultyDiscountAuto,
  naturalAppliedTierRate,
  naturalAppliedTierSize,
} from '../../lib/tuitionMath'
import AppShell from '../../components/AppShell'
import AYESelector from '../../components/AYESelector'
import Breadcrumb from '../../components/Breadcrumb'
import Badge from '../../components/Badge'
import TuitionAuditEmptyState from '../../components/tuition/TuitionAuditEmptyState'
import TuitionFamilyDetailsTable from '../../components/tuition/TuitionFamilyDetailsTable'

// Tuition Stage 2 (Tuition Audit) page.
//
// URL: /modules/tuition/audit
//
// Architecture §7.3 ("Stage 2 immutability rules" + "Faculty discount
// rule" v3.8.14). The operational surface where the school records
// per-family realized enrollment, allocates discretionary discount
// envelopes (Faculty / Other / Financial Aid), and captures audit-
// trail-grade Notes.
//
// State machine of the page:
//
//   1. No Stage 1 lock for the AYE → empty-state cascade-blocked
//      message (TuitionAuditEmptyState).
//   2. Stage 1 IS locked, but no Stage 2 scenario exists → empty-
//      state "ready to set up" message + "Set up Audit from {Stage 1
//      label}" button (calls create_tuition_scenario_from_snapshot
//      RPC, seeding the Stage 2 scenario from the most-recent locked
//      Stage 1 snapshot).
//   3. Stage 2 scenario exists → render TuitionFamilyDetailsTable
//      with the family rows.
//
// Multi-scenario shell for Stage 2 is queued — B2a ships single-
// scenario support; if a future need surfaces for parallel Stage 2
// scenarios, the page extends with a tab strip mirroring Stage 1.
//
// Stage 2 lock workflow (Submit / Approve / Lock + banners) ships
// in B2b. B2a renders a placeholder header note where the lock
// affordance will live.

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

function TuitionAuditPage() {
  const { user } = useAuth()
  const toast = useToast()
  const { allowed: canView, loading: permLoading } = useModulePermission('tuition', 'view')
  const { allowed: canEdit } = useModulePermission('tuition', 'edit')

  // Stage metadata (loaded from module_workflow_stages).
  const [stage, setStage] = useState(null)
  const [stage1, setStage1] = useState(null)  // sibling preliminary stage
  const [stageError, setStageError] = useState(null)

  const [selectedAyeId, setSelectedAyeId] = useState(null)
  const [aye, setAye] = useState(null)

  const [stage1Loading, setStage1Loading] = useState(false)
  // Most-recent Stage 1 snapshot for the AYE (used as the seed source
  // when creating a new Stage 2 scenario). null when no lock exists.
  const [stage1Snapshot, setStage1Snapshot] = useState(null)

  // Stage 2 scenario + families.
  const [scenarios, setScenarios] = useState([])
  const [activeScenarioId, setActiveScenarioId] = useState(null)
  const [families, setFamilies] = useState([])
  const [dataLoading, setDataLoading] = useState(false)
  const [seeding, setSeeding] = useState(false)

  // Resolve both tuition stages on mount.
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

  // Resolve the active AYE label.
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
      if (error) {
        toast.error(error.message)
        return
      }
      setAye(data)
    })()
    return () => { mounted = false }
  }, [selectedAyeId, toast])

  // Probe the most-recent Stage 1 snapshot for the AYE. Used as
  // (a) the cascade gate ("does any locked Stage 1 exist?") and
  // (b) the seed source when creating a new Stage 2 scenario.
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
      if (error) {
        toast.error(error.message)
        setStage1Snapshot(null)
      } else {
        setStage1Snapshot(Array.isArray(data) && data.length > 0 ? data[0] : null)
      }
      setStage1Loading(false)
    })()
    return () => { mounted = false }
  }, [selectedAyeId, stage1?.id, canView, toast])

  const stage1Locked = useMemo(() => stage1Snapshot != null, [stage1Snapshot])

  // Load Stage 2 scenarios for (AYE, stage). Only runs when the
  // cascade gate is satisfied — otherwise rendering the table-driven
  // editor would expose pre-cascade state.
  const loadScenarios = useCallback(async () => {
    if (!selectedAyeId || !stage?.id || !canView) {
      setScenarios([])
      setActiveScenarioId(null)
      return
    }
    setDataLoading(true)
    const { data, error } = await supabase
      .from('tuition_worksheet_scenarios')
      .select('id, scenario_label, description, is_recommended, state, created_at, locked_at, locked_by, locked_via, override_justification, tier_count, tier_rates, faculty_discount_pct, projected_faculty_discount_amount, projected_other_discount, projected_financial_aid, curriculum_fee_per_student, enrollment_fee_per_student, before_after_school_hourly_rate, projected_b_a_hours, projected_multi_student_discount, estimated_family_distribution, total_students, total_families, top_tier_avg_students_per_family, actual_before_after_school_hours, expense_comparator_mode, expense_comparator_amount, expense_comparator_source_label, unlock_requested, unlock_request_justification, unlock_requested_at, unlock_requested_by')
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

  useEffect(() => {
    loadScenarios()
  }, [loadScenarios])

  const activeScenario = useMemo(
    () => scenarios.find((s) => s.id === activeScenarioId) || null,
    [scenarios, activeScenarioId]
  )

  // Load families for the active scenario.
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

  useEffect(() => {
    loadFamilies()
  }, [loadFamilies])

  // ---- Setup-from-Stage-1 (create_tuition_scenario_from_snapshot) -------

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
      toast.success(`Stage 2 scenario set up from ${stage1Snapshot.stage_display_name_at_lock}.`)
    } catch (e) {
      toast.error(e.message || String(e))
    } finally {
      setSeeding(false)
    }
  }, [stage1Snapshot, stage?.id, loadScenarios, toast])

  // ---- Family CRUD -------------------------------------------------------

  // Atomic multi-field update. Optimistic local state + rollback on
  // error. Mirrors the persistFields pattern from TuitionWorksheet.
  const handleUpdateRow = useCallback(async (familyId, patch) => {
    if (!familyId) return false
    const previous = families.find((f) => f.id === familyId)
    if (!previous) return false

    setFamilies((prev) =>
      prev.map((f) => (f.id === familyId ? { ...f, ...patch } : f))
    )

    const { error } = await supabase
      .from('tuition_worksheet_family_details')
      .update({ ...patch, updated_by: user?.id ?? null })
      .eq('id', familyId)

    if (error) {
      setFamilies((prev) =>
        prev.map((f) => (f.id === familyId ? previous : f))
      )
      toast.error(error.message)
      return false
    }
    return true
  }, [families, user?.id, toast])

  // Add a fresh family row. Initial defaults: students_enrolled=1,
  // is_faculty_family=false, blank label. Tier resolves from the
  // scenario's tier_rates via naturalAppliedTier* helpers (so the
  // INSERT carries valid tier values rather than relying on a
  // post-INSERT cascade).
  const handleAddFamily = useCallback(async () => {
    if (!activeScenario) return
    const seedFamily = {
      students_enrolled: 1,
      is_faculty_family: false,
    }
    const tierSize = naturalAppliedTierSize(seedFamily, activeScenario)
    const tierRate = naturalAppliedTierRate(seedFamily, activeScenario)

    const { data, error } = await supabase
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
      .select('id')
      .single()
    if (error) {
      toast.error(error.message)
      return
    }
    await loadFamilies()
    void data
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
    if (error) {
      toast.error(error.message)
      return
    }
    await loadFamilies()
  }, [families, loadFamilies])

  // Suppress unused-import lint warning — helper imported for future
  // override re-detection on cascade saves; not directly invoked here
  // because the cascades happen inside TuitionFamilyDetailsTable.
  void computeFamilyFacultyDiscountAuto

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
        <Breadcrumb items={[{ label: 'Tuition' }, { label: stage?.short_name || 'Audit' }]} />
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
          Tuition Audit stage not found.
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

  const readOnly =
    !canEdit || (activeScenario && activeScenario.state !== 'drafting')

  return (
    <AppShell>
      <div className="-mx-6 -my-6 flex flex-col h-[calc(100vh-3.5rem)]">
        <div className="px-6">
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
              </div>
            </div>

            {/* Placeholder for the Stage 2 lock workflow header (B2b).
                Today renders a small italic note where the Submit-for-
                Lock-Review button will eventually live. */}
            {activeScenario && (
              <p className="mt-2 text-right font-body italic text-[12px] text-muted">
                Stage 2 lock workflow ships in Tuition-B2b.
              </p>
            )}
          </header>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-3">
          {!selectedAyeId ? (
            <p className="text-muted italic mt-8">
              Pick an academic year to begin.
            </p>
          ) : stage1Loading || dataLoading ? (
            <p className="text-muted mt-8">Loading…</p>
          ) : !stage1Locked ? (
            // Cascade-blocked: no Stage 1 lock yet.
            <TuitionAuditEmptyState
              ayeLabel={aye?.label}
              stageDisplayName={stage.display_name}
              stage1DisplayName={stage1?.display_name || 'Tuition Planning'}
              stage1AnyLocked={false}
            />
          ) : !activeScenario ? (
            // Stage 1 IS locked, but no Stage 2 scenario yet — offer
            // the setup affordance.
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
            // Stage 2 scenario exists — render the editor.
            <TuitionFamilyDetailsTable
              families={families}
              scenario={activeScenario}
              readOnly={readOnly}
              onUpdateRow={handleUpdateRow}
              onDeleteRow={handleDeleteRow}
              onAddFamily={handleAddFamily}
            />
          )}
        </div>
      </div>
    </AppShell>
  )
}

// Setup card — visible when Stage 1 is locked but no Stage 2 scenario
// exists yet. Mirrors the Budget PredecessorSelector pattern (single
// card click → seed scenario from snapshot).
function SetupFromStage1Card({
  stage1Snapshot,
  stage1DisplayName,
  stageDisplayName,
  ayeLabel,
  onSetup,
  seeding,
  canEdit,
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
          <strong className="font-medium">{dateStr}</strong>). Stage 2
          will seed from this snapshot — tier rates, fee structures, and
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
          {seeding ? 'Setting up…' : `Set up Audit from ${stage1DisplayName}`}
        </button>
      </div>
    </div>
  )
}

export default TuitionAuditPage
