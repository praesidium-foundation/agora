import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import {
  fetchScenarioActivity,
  formatAbsoluteTimestamp,
  summarizeEvent,
} from '../../lib/auditLog'
import PrintShell from '../../components/print/PrintShell'

// Per-scenario activity feed print page.
//
// Route: /print/budget/:scenarioId/activity
//
// Fetches the entire change_log for the scenario (every event for the
// scenario row + every line belonging to it) and renders it as a
// chronological audit log. Does NOT respect any in-app filter — the
// route is reproducible from its URL alone.
//
// Marked DRAFT only when the parent scenario is non-locked. An activity
// log of a locked scenario is itself a final document.

export default function BudgetActivityPrint() {
  const { scenarioId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { allowed: canView, loading: permLoading } = useModulePermission(
    'budget',
    'view'
  )

  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [printerName, setPrinterName] = useState(null)

  useEffect(() => {
    if (!user?.id) return
    let mounted = true
    ;(async () => {
      const { data } = await supabase
        .from('user_profiles')
        .select('full_name')
        .eq('id', user.id)
        .maybeSingle()
      if (mounted) setPrinterName(data?.full_name || null)
    })()
    return () => { mounted = false }
  }, [user?.id])

  useEffect(() => {
    if (!canView || !scenarioId) return
    let mounted = true
    ;(async () => {
      try {
        const { data: scenario, error: scenErr } = await supabase
          .from('budget_stage_scenarios')
          .select('id, scenario_label, description, state, aye_id, stage_id')
          .eq('id', scenarioId)
          .single()
        if (scenErr) throw scenErr

        const [ayeRes, stageRes, accountsRes] = await Promise.all([
          supabase.from('academic_years').select('id, label').eq('id', scenario.aye_id).single(),
          supabase.from('module_workflow_stages').select('id, display_name').eq('id', scenario.stage_id).single(),
          supabase.from('chart_of_accounts').select('id, code, name'),
        ])
        if (ayeRes.error)      throw ayeRes.error
        if (stageRes.error)    throw stageRes.error
        if (accountsRes.error) throw accountsRes.error

        const accountsById = Object.fromEntries(
          (accountsRes.data || []).map((a) => [a.id, { code: a.code, name: a.name }])
        )

        const events = await fetchScenarioActivity(scenarioId, {
          limit: null,
          accountsById,
        })

        if (!mounted) return
        setData({ scenario, aye: ayeRes.data, stage: stageRes.data, events })
      } catch (e) {
        if (mounted) setError(e.message || String(e))
      }
    })()
    return () => { mounted = false }
  }, [canView, scenarioId])

  if (permLoading) return <p className="p-8 font-body text-muted">Loading…</p>
  if (!canView) {
    return (
      <div className="p-8">
        <p className="font-body text-status-red mb-4">
          You do not have view access to the Budget module.
        </p>
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="bg-navy text-gold px-4 py-2 rounded text-sm"
        >
          Back to Dashboard
        </button>
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-8">
        <p className="font-body text-status-red mb-4">{error}</p>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="bg-navy text-gold px-4 py-2 rounded text-sm"
        >
          Back
        </button>
      </div>
    )
  }
  if (!data) return <p className="p-8 font-body text-muted">Loading activity…</p>

  const draft = data.scenario.state !== 'locked'
  const events = data.events
  const firstEventDate = events.length > 0
    ? formatAbsoluteTimestamp(events[events.length - 1].changed_at)
    : null
  const lastEventDate = events.length > 0
    ? formatAbsoluteTimestamp(events[0].changed_at)
    : null

  return (
    <PrintShell
      title={`Activity History — ${data.stage.display_name}`}
      subtitle={`${data.scenario.scenario_label} · ${data.aye.label}${data.scenario.description ? ' — ' + data.scenario.description : ''}`}
      draft={draft}
      draftLabel={draft ? 'DRAFT — Audit log' : null}
      generatedAt={new Date()}
      generatedByName={printerName}
      backTo={`/modules/budget/${data.stage.id}`}
    >
      {/* Audit log PDFs render at reference-document density (v3.6) —
          smaller text, tighter spacing than Operating Budget Detail.
          These are reference artifacts (think SEC filing exhibits),
          not presentation pieces. Full justification / reason text
          remains visible inline (no truncation, §9.1 commitment). */}
      <section className="mb-3">
        <p className="font-body text-[9.5pt] text-body leading-snug">
          {events.length} event{events.length === 1 ? '' : 's'} recorded.
          {firstEventDate && lastEventDate && (
            <span className="text-muted">
              {' '}Range: {firstEventDate} → {lastEventDate}.
            </span>
          )}
        </p>
      </section>

      {events.length === 0 ? (
        <p className="font-body italic text-muted text-[9.5pt]">
          No activity captured for this scenario yet.
        </p>
      ) : (
        <ol className="space-y-1">
          {events.map((event, i) => (
            <PrintFeedRow key={i} event={event} />
          ))}
        </ol>
      )}

      <p className="font-body text-muted text-[8.5pt] italic mt-6">
        Source: Agora activity log for "{data.scenario.scenario_label}".
      </p>
    </PrintShell>
  )
}

function PrintFeedRow({ event }) {
  // v3.6: tighter padding throughout for reference-document density.
  const treatments = {
    lock:      'border-l-4 border-status-blue bg-status-blue-bg/30 pl-2 pr-2 py-1',
    override:  'border-l-4 border-status-amber bg-status-amber-bg/40 pl-2 pr-2 py-1',
    submit:    'border-l-2 border-status-amber pl-2 py-0.5',
    reject:    'border-l-2 border-status-amber pl-2 py-0.5',
    recommend: 'border-l-2 border-gold pl-2 py-0.5',
    insert:    'border-l-2 border-status-green pl-2 py-0.5',
    delete:    'border-l-2 border-status-red pl-2 py-0.5',
    amount:    'border-l-2 border-card-border pl-2 py-0.5',
    edit:      'border-l-2 border-card-border pl-2 py-0.5',
    unlock_requested:        'border-l-4 border-status-amber bg-status-amber-bg/40 pl-2 pr-2 py-1',
    unlock_first_approval:   'border-l-4 border-status-amber bg-status-amber-bg/30 pl-2 pr-2 py-1',
    unlock_completed:        'border-l-4 border-status-blue bg-status-blue-bg/30 pl-2 pr-2 py-1',
    unlock_rejected:         'border-l-4 border-status-red bg-status-red-bg/30 pl-2 pr-2 py-1',
    unlock_withdrawn:        'border-l-2 border-card-border pl-2 py-0.5',
  }
  const cls = treatments[event.kind] || 'border-l-2 border-card-border pl-2 py-0.5'

  let overrideJustification = null
  if (event.kind === 'override') {
    const f = event.fields.find((x) => x.field_name === 'override_justification')
    if (f && f.new_value) overrideJustification = String(f.new_value)
  }

  return (
    <li className={cls}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-body text-body text-[9pt] leading-snug">
          {event.kind === 'lock' && (
            <span className="text-status-blue mr-1" aria-hidden="true">🔒</span>
          )}
          <span className="text-muted">{event.changed_by_name || '(unknown)'}</span>
          {' — '}
          {summarizeEvent(event)}
        </span>
        <span className="font-body text-muted text-[8pt] tabular-nums whitespace-nowrap">
          {formatAbsoluteTimestamp(event.changed_at)}
        </span>
      </div>
      {/* Override justification preserved at full text — never
          truncated, per §9.1 architectural commitment. */}
      {overrideJustification && (
        <p className="font-body text-status-amber text-[8.5pt] italic mt-0.5">
          Justification: "{overrideJustification}"
        </p>
      )}
    </li>
  )
}
