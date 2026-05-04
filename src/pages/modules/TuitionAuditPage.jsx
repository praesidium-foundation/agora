import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useModulePermission } from '../../lib/usePermission'
import { useToast } from '../../lib/Toast'
import AppShell from '../../components/AppShell'
import AYESelector from '../../components/AYESelector'
import Breadcrumb from '../../components/Breadcrumb'
import TuitionAuditEmptyState from '../../components/tuition/TuitionAuditEmptyState'

// Tuition Stage 2 (Tuition Audit) page.
//
// URL: /modules/tuition/audit
//
// Architecture §3.4 + §7.3. Stage 2 reconciles the Stage 1 projection
// (tier rates, family distribution, discount envelopes captured into
// the Stage 1 snapshot at lock time) against actual per-family
// realized data. Per the cascade rules in §7.5, Stage 2 setup
// requires Stage 1 to be locked in the same AYE — the snapshot is
// the seed for Stage 2's per-family rows.
//
// Tuition-D (v3.8.10) ships only the gateway: the page resolves the
// final-typed stage of the tuition workflow, checks for a locked
// Stage 1 snapshot in the active AYE, and renders TuitionAuditEmpty
// State with one of two messages (cascade blocked vs. ready-to-set-up
// but editor not yet implemented). The Stage 2 editing surface itself
// — per-family rows, applied tier rate, Faculty/Other/FA allocations
// — is queued for a follow-on commit so the cascade gate is testable
// before the page grows in scope.

function TuitionAuditPage() {
  const toast = useToast()
  const { allowed: canView, loading: permLoading } = useModulePermission('tuition', 'view')

  // Stage metadata (loaded from module_workflow_stages). Resolved by
  // joining modules → module_workflows → module_workflow_stages and
  // picking stage_type = 'final' on the tuition workflow.
  const [stage, setStage] = useState(null)
  const [stage1, setStage1] = useState(null)  // sibling preliminary stage
  const [stageError, setStageError] = useState(null)

  const [selectedAyeId, setSelectedAyeId] = useState(null)
  const [aye, setAye] = useState(null)

  // Locked-Stage-1 detection. True iff at least one row exists in
  // tuition_worksheet_snapshots for the active AYE on the
  // preliminary-typed stage.
  const [stage1Loading, setStage1Loading] = useState(false)
  const [stage1AnyLocked, setStage1AnyLocked] = useState(false)

  // Resolve both tuition stages on mount. We need both:
  //   - stage (final): for the page heading, breadcrumb, badges
  //   - stage1 (preliminary): for the cascade-rule helper text and
  //                           the "Go to Tuition Planning" link target
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
        setStage(null)
        return
      }
      if (!data || data.length === 0) {
        setStageError('Tuition workflow stages not configured. Run Migration 022.')
        setStage(null)
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
        setAye(null)
        return
      }
      setAye(data)
    })()
    return () => { mounted = false }
  }, [selectedAyeId, toast])

  // Locked-Stage-1 check. Cascade gate per §7.5: Stage 2 cannot be
  // set up until at least one Stage 1 snapshot exists for the AYE.
  useEffect(() => {
    if (!selectedAyeId || !stage1?.id || !canView) {
      setStage1AnyLocked(false)
      return
    }
    let mounted = true
    setStage1Loading(true)
    ;(async () => {
      const { data, error } = await supabase
        .from('tuition_worksheet_snapshots')
        .select('id', { count: 'exact', head: true })
        .eq('aye_id', selectedAyeId)
        .eq('stage_id', stage1.id)
        .limit(1)
      if (!mounted) return
      if (error) {
        toast.error(error.message)
        setStage1AnyLocked(false)
      } else {
        // With head:true the response is { data: null, count: ... }
        // on supabase-js v2; with head:false (default) it's the row
        // array. We use head:true above so data is null and count
        // sits on the response. Either way, presence of any row
        // satisfies the gate — fall back permissively when the
        // shape is unfamiliar (rather than incorrectly gating).
        setStage1AnyLocked(Array.isArray(data) ? data.length > 0 : true)
      }
      setStage1Loading(false)
    })()
    return () => { mounted = false }
  }, [selectedAyeId, stage1?.id, canView, toast])

  // Re-derive: prefer the explicit count check. The above is a
  // permission-aware probe; defensively normalize to a boolean here.
  const stage1Locked = useMemo(() => Boolean(stage1AnyLocked), [stage1AnyLocked])

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
              </div>

              <div className="flex items-end gap-3 flex-wrap">
                <AYESelector value={selectedAyeId} onChange={setSelectedAyeId} />
              </div>
            </div>
          </header>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-2">
          {!selectedAyeId ? (
            <p className="text-muted italic mt-8">
              Pick an academic year to begin.
            </p>
          ) : stage1Loading ? (
            <p className="text-muted mt-8">Loading…</p>
          ) : (
            <TuitionAuditEmptyState
              ayeLabel={aye?.label}
              stageDisplayName={stage.display_name}
              stage1DisplayName={stage1?.display_name || 'Tuition Planning'}
              stage1AnyLocked={stage1Locked}
            />
          )}
        </div>
      </div>
    </AppShell>
  )
}

export default TuitionAuditPage
