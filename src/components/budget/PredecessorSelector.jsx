import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import Card from '../Card'

// Setup-view component for non-first stages of a Budget workflow.
//
// Architecture §8.14. Replaces the three-option BudgetEmptyState flow
// when the active stage is not the first stage in its workflow.
// Non-first stages MUST seed from a locked predecessor stage in the
// same AYE; the three-option flow is conceptually wrong here (there
// is no "fresh start" or "CSV import" path for a Final Budget — it
// should reflect the locked Preliminary).
//
// Two render branches:
//
//   1. No locked predecessors yet — friendly empty state with a link
//      back to the predecessor stage. Setup is blocked until at least
//      one predecessor is locked.
//
//   2. One or more locked predecessors — render each as a card showing
//      the working scenario name (from the snapshot — this is a
//      working-tool surface, see §8.15), lock date, locked-by name,
//      and the captured KPI totals. Clicking a card opens the
//      confirmation modal (parent owns it via onSelectSnapshot).
//
// Even when only one predecessor exists, the card flow is preserved as
// a deliberate confirmation pause rather than auto-progressing.
//
// Props:
//   targetStage      — { id, display_name, sort_order, workflow_id }
//   ayeId            — id of the active AYE
//   ayeLabel         — display label of the active AYE
//   predecessorStages — array of { id, display_name, sort_order } for
//                        all stages with sort_order < targetStage.sort_order
//                        in the same workflow. Parent loads this so it
//                        can also use it for the empty-state link.
//   onSelectSnapshot — (snapshot, predecessorStage) => void; parent
//                       opens SeedFromPredecessorModal

export default function PredecessorSelector({
  targetStage,
  ayeId,
  ayeLabel,
  predecessorStages,
  onSelectSnapshot,
}) {
  const [snapshots, setSnapshots] = useState(null)
  const [error, setError] = useState(null)
  const [lockerNames, setLockerNames] = useState({})

  // Load all locked predecessor snapshots for this AYE. One query
  // covers all predecessor stages — we filter client-side by stage_id
  // membership rather than running N separate queries.
  useEffect(() => {
    if (!ayeId || predecessorStages.length === 0) {
      setSnapshots([])
      return
    }
    let mounted = true
    const predecessorIds = predecessorStages.map((s) => s.id)
    ;(async () => {
      const { data, error: queryError } = await supabase
        .from('budget_snapshots')
        .select('id, stage_id, scenario_id, scenario_label, stage_display_name_at_lock, locked_at, locked_by, kpi_total_income, kpi_total_expenses, kpi_net_income')
        .eq('aye_id', ayeId)
        .in('stage_id', predecessorIds)
        .order('locked_at', { ascending: false })
      if (!mounted) return
      if (queryError) {
        setError(queryError.message)
        setSnapshots([])
        return
      }
      // Most recent locked snapshot per stage (stages may have
      // multiple locks if a future unlock+re-lock cycle occurs).
      const seenStages = new Set()
      const latestPerStage = []
      for (const snap of data || []) {
        if (seenStages.has(snap.stage_id)) continue
        seenStages.add(snap.stage_id)
        latestPerStage.push(snap)
      }
      setSnapshots(latestPerStage)

      // Resolve locker names. Single batch query.
      const lockerIds = [...new Set(latestPerStage.map((s) => s.locked_by).filter(Boolean))]
      if (lockerIds.length > 0) {
        const { data: profiles } = await supabase
          .from('user_profiles')
          .select('id, full_name')
          .in('id', lockerIds)
        if (mounted) {
          const byId = Object.fromEntries((profiles || []).map((p) => [p.id, p.full_name]))
          setLockerNames(byId)
        }
      }
    })()
    return () => { mounted = false }
  }, [ayeId, predecessorStages])

  const stageById = Object.fromEntries(predecessorStages.map((s) => [s.id, s]))

  if (snapshots === null) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] py-6">
        <p className="font-body italic text-muted">Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] py-6">
        <p className="font-body text-status-red text-sm" role="alert">{error}</p>
      </div>
    )
  }

  // Branch 1: no locked predecessors. Friendly empty state.
  if (snapshots.length === 0) {
    const earliestPredecessor = predecessorStages[0] || null
    return (
      <div className="flex items-center justify-center min-h-[60vh] py-6">
        <Card className="max-w-2xl w-full">
          <h2 className="font-display text-navy text-[22px] mb-2 leading-tight">
            Set up your {targetStage.display_name}
          </h2>
          <p className="font-body text-body text-sm leading-relaxed mb-4">
            <strong className="font-medium">{targetStage.display_name}</strong>{' '}
            requires a locked{' '}
            {earliestPredecessor ? (
              <strong className="font-medium">{earliestPredecessor.display_name}</strong>
            ) : (
              <strong className="font-medium">predecessor</strong>
            )}{' '}
            as its starting point. No locked
            {earliestPredecessor ? ` ${earliestPredecessor.display_name}` : ' predecessor'}
            {' '}exists yet for {ayeLabel}.
          </p>
          <p className="font-body italic text-muted text-sm leading-relaxed mb-5">
            Lock a {earliestPredecessor ? earliestPredecessor.display_name : 'predecessor stage'}{' '}
            first, then return here to begin{' '}
            {targetStage.display_name}.
          </p>
          {earliestPredecessor && (
            <Link
              to={`/modules/budget/${earliestPredecessor.id}`}
              className="inline-block bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity"
            >
              Go to {earliestPredecessor.display_name}
            </Link>
          )}
        </Card>
      </div>
    )
  }

  // Branch 2: one or more locked predecessors. Render as cards.
  return (
    <div className="flex items-center justify-center min-h-[60vh] py-6">
      <Card className="max-w-3xl w-full">
        <h2 className="font-display text-navy text-[22px] mb-1 leading-tight">
          Set up your {targetStage.display_name}
        </h2>
        <p className="font-body italic text-muted text-sm mb-6">
          Pick a locked predecessor to use as the starting point. The
          predecessor remains in audit history; you will work in a new
          editable copy.
        </p>

        <div className="space-y-3">
          {snapshots.map((snap) => (
            <PredecessorCard
              key={snap.id}
              snapshot={snap}
              predecessorStage={stageById[snap.stage_id]}
              ayeLabel={ayeLabel}
              lockerName={lockerNames[snap.locked_by] || null}
              onSelect={() => onSelectSnapshot(snap, stageById[snap.stage_id])}
            />
          ))}
        </div>
      </Card>
    </div>
  )
}

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
})
const fmtUsd = (n) => (n == null ? '—' : usd0.format(Number(n)))

function PredecessorCard({ snapshot, predecessorStage, ayeLabel, lockerName, onSelect }) {
  const lockedAtStr = snapshot.locked_at
    ? new Date(snapshot.locked_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : '—'
  const stageLabel =
    predecessorStage?.display_name || snapshot.stage_display_name_at_lock || 'Predecessor'
  // Heading includes AYE context to disambiguate which specific locked
  // artifact this card represents — e.g., "AYE 2026 Preliminary Budget"
  // rather than just "Preliminary Budget". Mirrors the canonical-name
  // pattern from §8.15 (without the school prefix, since we are already
  // inside the school-branded app).
  const cardHeading = ayeLabel ? `${ayeLabel} ${stageLabel}` : stageLabel

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left px-5 py-4 rounded-[8px] border-[0.5px] border-card-border bg-white hover:bg-cream-highlight hover:border-navy/30 transition-colors"
    >
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <span className="font-display text-navy text-[15px] tracking-[0.04em]">
          {cardHeading}
        </span>
        <span className="font-body text-[11px] text-muted uppercase tracking-wider">
          Locked {lockedAtStr}
        </span>
      </div>
      <p className="font-body text-sm text-body leading-relaxed mb-3">
        Working name: <strong className="font-medium">{snapshot.scenario_label || '—'}</strong>
        {lockerName ? <> · Approved by <strong className="font-medium">{lockerName}</strong></> : null}
      </p>
      {/* Three KPI pairs in a single horizontal row. Each label-amount
          pair reads as a connected unit (no justify-between within the
          pair); pairs are separated by a middot-spaced gap. Mirrors
          the §10.4 principle "name and amount read as connected
          units, not opposite ends of the page". */}
      <div className="flex items-baseline gap-x-5 gap-y-1 flex-wrap text-[12px]">
        <KpiPair label="Income" value={snapshot.kpi_total_income} />
        <KpiPair label="Expenses" value={snapshot.kpi_total_expenses} />
        <KpiPair label="Net" value={snapshot.kpi_net_income} accentNegative />
      </div>
    </button>
  )
}

function KpiPair({ label, value, accentNegative = false }) {
  const numeric = Number(value)
  const isNegative = accentNegative && numeric < 0
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-body text-muted">{label}</span>
      <span className={`font-body tabular-nums font-medium ${isNegative ? 'text-status-red' : 'text-navy'}`}>
        {fmtUsd(value)}
      </span>
    </span>
  )
}
