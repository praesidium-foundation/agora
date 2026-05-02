import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import {
  describeField,
  fetchLineHistory,
  formatAbsoluteTimestamp,
} from '../../lib/auditLog'
import PrintShell from '../../components/print/PrintShell'

// Per-line audit history print page.
//
// Route: /print/budget-line/:lineId/history
//
// Renders a single budget_stage_lines row's complete change_log as a
// printable governance artifact. Fetches:
//   - the line itself (account_id, scenario_id) → live row
//   - the line's account (code, name)
//   - the line's scenario + stage + AYE for the title block
//   - all change_log events for the line (already-grouped by auditLog.js)
//
// Marked as DRAFT only when the parent scenario is non-locked. A history
// log of a locked scenario's line is itself a finalized document and
// renders without the watermark.

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
})
const fmtUsd = (n) => usd0.format(Number(n) || 0)

export default function BudgetLineHistoryPrint() {
  const { lineId } = useParams()
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
    if (!canView || !lineId) return
    let mounted = true
    ;(async () => {
      try {
        const { data: line, error: lineErr } = await supabase
          .from('budget_stage_lines')
          .select('id, scenario_id, account_id')
          .eq('id', lineId)
          .maybeSingle()
        if (lineErr) throw lineErr

        // The line may have been deleted; fall back to reconstructing
        // identity from change_log inserts so the export still works
        // for an audit of a removed line.
        let scenarioId = line?.scenario_id || null
        let accountId  = line?.account_id  || null
        if (!line) {
          const { data: insRow } = await supabase
            .from('change_log')
            .select('new_value')
            .eq('target_table', 'budget_stage_lines')
            .eq('target_id', lineId)
            .eq('field_name', '__insert__')
            .maybeSingle()
          if (insRow && insRow.new_value) {
            scenarioId = insRow.new_value.scenario_id
            accountId  = insRow.new_value.account_id
          }
        }

        if (!scenarioId || !accountId) {
          throw new Error('Could not identify the scenario or account this line belongs to.')
        }

        const [accountRes, scenarioRes, eventsRes] = await Promise.all([
          supabase.from('chart_of_accounts').select('id, code, name').eq('id', accountId).maybeSingle(),
          supabase.from('budget_stage_scenarios').select('id, scenario_label, state, aye_id, stage_id').eq('id', scenarioId).single(),
          fetchLineHistory(lineId),
        ])
        if (accountRes.error)  throw accountRes.error
        if (scenarioRes.error) throw scenarioRes.error

        const [ayeRes, stageRes] = await Promise.all([
          supabase.from('academic_years').select('id, label').eq('id', scenarioRes.data.aye_id).single(),
          supabase.from('module_workflow_stages').select('id, display_name').eq('id', scenarioRes.data.stage_id).single(),
        ])
        if (ayeRes.error)   throw ayeRes.error
        if (stageRes.error) throw stageRes.error

        if (!mounted) return
        setData({
          line,
          account: accountRes.data,
          scenario: scenarioRes.data,
          aye: ayeRes.data,
          stage: stageRes.data,
          events: eventsRes,
        })
      } catch (e) {
        if (mounted) setError(e.message || String(e))
      }
    })()
    return () => { mounted = false }
  }, [canView, lineId])

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
  if (!data) return <p className="p-8 font-body text-muted">Loading history…</p>

  const accountLabel = data.account
    ? `${data.account.code ? data.account.code + ' ' : ''}${data.account.name}`
    : '(account no longer in COA)'
  const draft = data.scenario.state !== 'locked'

  return (
    <PrintShell
      title={`${accountLabel} — Change History`}
      subtitle={`${data.scenario.scenario_label} · ${data.aye.label} ${data.stage.display_name}`}
      draft={draft}
      draftLabel={draft ? `DRAFT — Audit excerpt` : null}
      generatedAt={new Date()}
      generatedByName={printerName}
      backTo={`/modules/budget/${data.stage.id}`}
    >
      {/* Reference-document density (v3.6): smaller text and tighter
          spacing than Operating Budget Detail. Audit log PDFs are
          reference artifacts, not presentation pieces. Field-level
          diffs and reason text remain at full content (no truncation,
          §9.1 commitment). */}
      <p className="font-body text-muted text-[9.5pt] mb-2">
        {data.events.length} event{data.events.length === 1 ? '' : 's'} captured.
      </p>
      {data.events.length === 0 ? (
        <p className="font-body italic text-muted text-[9.5pt]">
          No history captured for this line. (If the line is brand-new
          and was created before the change_log trigger was active, no
          events will appear.)
        </p>
      ) : (
        <ol className="space-y-1.5">
          {data.events.map((event, i) => (
            <PrintEvent key={i} event={event} />
          ))}
        </ol>
      )}
      <p className="font-body text-muted text-[8.5pt] italic mt-6">
        Source: Agora change log for budget line {lineId}.
      </p>
    </PrintShell>
  )
}

function PrintEvent({ event }) {
  // v3.6: tighter padding for reference-document density.
  const treatments = {
    lock:      'border-l-4 border-status-blue bg-status-blue-bg/30 px-2 py-1',
    override:  'border-l-4 border-status-amber bg-status-amber-bg/40 px-2 py-1',
    submit:    'border-l-2 border-status-amber pl-2 py-0.5',
    reject:    'border-l-2 border-status-amber pl-2 py-0.5',
    recommend: 'border-l-2 border-gold pl-2 py-0.5',
    insert:    'border-l-2 border-status-green pl-2 py-0.5',
    delete:    'border-l-2 border-status-red pl-2 py-0.5',
    amount:    'border-l-2 border-card-border pl-2 py-0.5',
    edit:      'border-l-2 border-card-border pl-2 py-0.5',
    unlock_requested:        'border-l-4 border-status-amber bg-status-amber-bg/40 px-2 py-1',
    unlock_first_approval:   'border-l-4 border-status-amber bg-status-amber-bg/30 px-2 py-1',
    unlock_completed:        'border-l-4 border-status-blue bg-status-blue-bg/30 px-2 py-1',
    unlock_rejected:         'border-l-4 border-status-red bg-status-red-bg/30 px-2 py-1',
    unlock_withdrawn:        'border-l-2 border-card-border pl-2 py-0.5',
  }
  const cls = treatments[event.kind] || 'border-l-2 border-card-border pl-2 py-0.5'

  const real = event.fields.filter(
    (f) => f.field_name !== '__insert__' && f.field_name !== '__delete__'
  )
  const insertField = event.fields.find((f) => f.field_name === '__insert__')
  const deleteField = event.fields.find((f) => f.field_name === '__delete__')

  return (
    <li className={cls}>
      <div className="flex items-baseline justify-between gap-3 mb-0.5">
        <span className="font-body text-body text-[9.5pt] font-medium">
          {labelForKind(event.kind)}
        </span>
        <span className="font-body text-muted text-[8pt] tabular-nums whitespace-nowrap">
          {formatAbsoluteTimestamp(event.changed_at)}
        </span>
      </div>
      <p className="font-body text-muted text-[8.5pt]">
        {event.changed_by_name || '(unknown user)'}
      </p>
      {insertField && (
        <p className="font-body text-body text-[8.5pt] italic mt-0.5">
          Created with amount {fmtUsd(insertField.new_value?.amount)}
        </p>
      )}
      {deleteField && (
        <p className="font-body text-body text-[8.5pt] italic mt-0.5">
          Removed (last amount: {fmtUsd(deleteField.old_value?.amount)})
        </p>
      )}
      {real.length > 0 && (
        <ul className="mt-0.5 space-y-0">
          {real.map((f, i) => (
            <li key={i} className="font-body text-body text-[8.5pt] leading-snug">
              {describeField(f)}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function labelForKind(kind) {
  switch (kind) {
    case 'insert':                return 'Created'
    case 'delete':                return 'Deleted'
    case 'amount':                return 'Amount changed'
    case 'edit':                  return 'Edited'
    case 'lock':                  return 'Scenario locked'
    case 'override':              return 'Override applied'
    case 'submit':                return 'Submitted for lock review'
    case 'reject':                return 'Rejected back to drafting'
    case 'recommend':             return 'Recommended status changed'
    case 'unlock_requested':      return 'Unlock requested'
    case 'unlock_first_approval': return 'Unlock — first approval'
    case 'unlock_completed':      return 'Unlock approved · returned to drafting'
    case 'unlock_rejected':       return 'Unlock request rejected'
    case 'unlock_withdrawn':      return 'Unlock request withdrawn'
    default:                      return 'Change'
  }
}
