import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useModulePermission } from '../../lib/usePermission'
import {
  buildBudgetTree,
  buildSnapshotTree,
  computeKpis,
  snapshotKpis,
} from '../../lib/budgetTree'
import PrintShell from '../../components/print/PrintShell'

// Operating Budget Detail print page.
//
// Route: /print/budget/:scenarioId
//
// Forks on the active scenario's state:
//   - drafting / pending_lock_review / pending_unlock_review
//        → DRAFT variant: live data from chart_of_accounts +
//          budget_stage_lines, watermark, "DRAFT" header banner,
//          "preliminary working version" footer note.
//   - locked
//        → LOCKED variant: snapshot data from budget_snapshots +
//          budget_snapshot_lines (captured-by-value columns ONLY —
//          live joins to chart_of_accounts are FORBIDDEN here per
//          architecture §5.1). NO watermark; instead the footer
//          renders the approved-by indicator with snapshot id and
//          override justification when applicable.
//
// Permission: gated by budget.view (RLS + an explicit guard at mount).
// Users without view permission see a "no access" message rather than
// the print dialog.

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
const fmtUsd = (n) => (n == null ? '' : usd0.format(Number(n)))

function formatLockedDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
}

export default function BudgetDetailPrint() {
  const { scenarioId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { allowed: canView, loading: permLoading } = useModulePermission(
    'budget',
    'view'
  )

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [bundle, setBundle] = useState(null)
  // bundle shape:
  //   { mode: 'draft' | 'locked',
  //     scenario, aye, stage,
  //     // draft mode:
  //     accounts?, lines?,
  //     // locked mode:
  //     snapshot?, snapshotLines?, lockedByName? }

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
      setLoading(true)
      setError(null)
      try {
        const { data: scenario, error: scenErr } = await supabase
          .from('budget_stage_scenarios')
          .select('id, scenario_label, description, narrative, show_narrative_in_pdf, is_recommended, state, aye_id, stage_id, locked_at, locked_by, locked_via, override_justification')
          .eq('id', scenarioId)
          .single()
        if (scenErr) throw scenErr
        if (!mounted) return

        const [ayeRes, stageRes] = await Promise.all([
          supabase.from('academic_years').select('id, label').eq('id', scenario.aye_id).single(),
          supabase.from('module_workflow_stages').select('id, display_name, short_name').eq('id', scenario.stage_id).single(),
        ])
        if (ayeRes.error)   throw ayeRes.error
        if (stageRes.error) throw stageRes.error
        if (!mounted) return

        if (scenario.state === 'locked') {
          // LOCKED variant — read exclusively from snapshot tables.
          const { data: snap, error: snapErr } = await supabase
            .from('budget_snapshots')
            .select('*')
            .eq('scenario_id', scenarioId)
            .order('locked_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          if (snapErr) throw snapErr
          if (!snap) {
            throw new Error(
              'Locked scenario is missing its snapshot row. Cannot render the locked PDF.'
            )
          }
          const { data: snapLines, error: snapLinesErr } = await supabase
            .from('budget_snapshot_lines')
            .select('id, account_id, account_code, account_name, account_type, account_hierarchy_path, is_pass_thru, is_ed_program_dollars, is_contribution, amount, source_type, notes')
            .eq('snapshot_id', snap.id)
          if (snapLinesErr) throw snapLinesErr

          let lockedByName = null
          if (snap.locked_by) {
            const { data: u } = await supabase
              .from('user_profiles')
              .select('full_name')
              .eq('id', snap.locked_by)
              .maybeSingle()
            lockedByName = u?.full_name || null
          }

          if (!mounted) return
          setBundle({
            mode: 'locked',
            scenario,
            aye: ayeRes.data,
            stage: stageRes.data,
            snapshot: snap,
            snapshotLines: snapLines || [],
            lockedByName,
          })
        } else {
          // DRAFT variant — live data.
          const [accountsRes, linesRes] = await Promise.all([
            supabase
              .from('chart_of_accounts')
              .select('id, code, name, parent_id, account_type, posts_directly, is_pass_thru, is_active, is_ed_program_dollars, is_contribution, sort_order')
              .order('sort_order', { ascending: true })
              .order('code', { ascending: true }),
            supabase
              .from('budget_stage_lines')
              .select('id, scenario_id, account_id, amount, source_type, notes')
              .eq('scenario_id', scenarioId),
          ])
          if (accountsRes.error) throw accountsRes.error
          if (linesRes.error)    throw linesRes.error
          if (!mounted) return
          setBundle({
            mode: 'draft',
            scenario,
            aye: ayeRes.data,
            stage: stageRes.data,
            accounts: accountsRes.data || [],
            lines: linesRes.data || [],
          })
        }
      } catch (e) {
        if (mounted) setError(e.message || String(e))
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [canView, scenarioId])

  const tree = useMemo(() => {
    if (!bundle) return null
    return bundle.mode === 'locked'
      ? buildSnapshotTree(bundle.snapshotLines)
      : buildBudgetTree(bundle.accounts, bundle.lines)
  }, [bundle])

  const kpis = useMemo(() => {
    if (!bundle) return null
    return bundle.mode === 'locked'
      ? snapshotKpis(bundle.snapshot)
      : computeKpis(bundle.accounts, bundle.lines)
  }, [bundle])

  if (permLoading) {
    return <p className="p-8 font-body text-muted">Loading…</p>
  }
  if (!canView) {
    return (
      <div className="p-8">
        <p className="font-body text-status-red mb-4">
          You don't have view access to the Budget module.
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
  if (loading || !bundle) {
    return <p className="p-8 font-body text-muted">Loading budget data…</p>
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

  const draft = bundle.mode === 'draft'
  const stateLabel = bundle.scenario.state.toUpperCase().replace(/_/g, ' ')
  const title = `${bundle.aye.label} ${bundle.stage.display_name}`
  const subtitle = bundle.scenario.scenario_label
    + (bundle.scenario.description ? ` — ${bundle.scenario.description}` : '')

  const approvedNote = !draft
    ? {
        locked_at_display: formatLockedDate(bundle.snapshot.locked_at),
        locked_by_name: bundle.lockedByName,
        snapshot_id: bundle.snapshot.id,
        override_justification:
          bundle.snapshot.locked_via === 'override'
            ? bundle.snapshot.override_justification
            : null,
      }
    : null

  return (
    <PrintShell
      title={title}
      subtitle={subtitle}
      draft={draft}
      draftLabel={draft ? `DRAFT — ${stateLabel}` : null}
      approvedNote={approvedNote}
      generatedAt={new Date()}
      generatedByName={printerName}
      backTo={`/modules/budget/${bundle.stage.id}`}
    >
      {/* State-indicator banner directly under the letterhead. Visually
          loud for DRAFT (red rule); calmer for LOCKED (navy rule). */}
      <StateIndicator
        draft={draft}
        stateLabel={stateLabel}
        snapshot={bundle.snapshot}
        lockedByName={bundle.lockedByName}
      />

      <KpiSummary kpis={kpis} />

      {bundle.scenario.narrative && bundle.scenario.show_narrative_in_pdf && (
        <Narrative text={bundle.scenario.narrative} />
      )}

      <div className="mt-6">
        <TopGroupPrint group={tree.income} />
        <TopGroupPrint group={tree.expense} />
      </div>
    </PrintShell>
  )
}

function StateIndicator({ draft, stateLabel, snapshot, lockedByName }) {
  if (draft) {
    return (
      <div className="mb-5 px-4 py-2 border-l-4 border-status-red bg-status-red-bg/40">
        <p className="font-display text-status-red text-[14px] tracking-wider uppercase">
          DRAFT — {stateLabel}
        </p>
        <p className="font-body text-muted text-[11px] italic mt-0.5">
          Not yet approved. This document is for working / review purposes only.
        </p>
      </div>
    )
  }
  return (
    <div className="mb-5 px-4 py-2 border-l-4 border-navy">
      <p className="font-display text-navy text-[14px] tracking-wider uppercase">
        LOCKED — Approved {formatLockedDate(snapshot?.locked_at)}
        {lockedByName ? ` by ${lockedByName}` : ''}
      </p>
    </div>
  )
}

function KpiSummary({ kpis }) {
  if (!kpis) return null
  const rows = [
    ['Total Income', kpis.totalIncome],
    ['Total Expenses', kpis.totalExpense],
    ['Net Income', kpis.netIncome],
    ['Ed Program Dollars', kpis.edProgramDollars],
    ['Ed Program Ratio', kpis.edProgramRatio != null ? `${(kpis.edProgramRatio * 100).toFixed(1)}%` : '—'],
    ['Contributions Total', kpis.contributionsTotal],
    ['% Personnel', kpis.pctPersonnel != null ? `${(kpis.pctPersonnel * 100).toFixed(1)}%` : '—'],
  ]
  return (
    <section className="mt-1 mb-5 grid grid-cols-2 gap-x-8 gap-y-1 text-[12px] print-category">
      <h2 className="col-span-2 font-display text-navy text-[12px] tracking-[0.10em] uppercase mb-1">
        Summary
      </h2>
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex justify-between border-b-[0.5px] border-card-border py-1"
        >
          <span className="font-body text-muted">{label}</span>
          <span
            className={`font-body tabular-nums ${
              typeof value === 'number' && value < 0 ? 'text-status-red' : 'text-navy'
            }`}
          >
            {typeof value === 'number' ? fmtUsd(value) : value}
          </span>
        </div>
      ))}
    </section>
  )
}

function Narrative({ text }) {
  return (
    <section className="mt-3 mb-6 print-category">
      <h2 className="font-display text-navy text-[12px] tracking-[0.10em] uppercase mb-2">
        Narrative
      </h2>
      <p className="font-body text-body whitespace-pre-wrap leading-relaxed text-[11pt]">
        {text}
      </p>
    </section>
  )
}

// Hierarchical body. Same shape as BudgetDetailZone but stripped of
// editing affordances. Pass-thru accounts are filtered upstream by the
// tree builders, so we don't need to filter again here.
function TopGroupPrint({ group }) {
  return (
    <section className="print-category mt-4">
      <header className="flex items-center gap-3 px-1 py-1.5 border-b-[1px] border-navy">
        <span className="font-display text-navy text-[13px] tracking-[0.12em] uppercase flex-1">
          {group.label}
        </span>
        <span
          className={`font-display tabular-nums text-[13px] ${
            group.total < 0 ? 'text-status-red' : 'text-navy'
          }`}
        >
          {fmtUsd(group.total)}
        </span>
      </header>
      {group.children.length === 0 ? (
        <p className="font-body italic text-muted text-[11pt] py-3 px-2">
          No {group.account_type} accounts in this scenario.
        </p>
      ) : (
        group.children.map((node) => (
          <RowPrint key={node.id} node={node} depth={0} />
        ))
      )}
    </section>
  )
}

function RowPrint({ node, depth }) {
  const isPosting = node.posts_directly
  const hasLine = node.line !== null
  const amount = hasLine ? node.line.amount : 0
  const isInactive = node.is_active === false
  const indentPx = 16 * (depth + 1)

  return (
    <>
      <div
        className={`flex items-center gap-3 py-1 border-b-[0.5px] border-card-border print-leaf ${
          isInactive ? 'opacity-60' : ''
        }`}
        style={{ paddingLeft: `${indentPx}px` }}
      >
        {node.code && (
          <span className="font-body text-[10pt] text-muted tabular-nums w-12 flex-shrink-0">
            {node.code}
          </span>
        )}
        {!node.code && <span className="w-12 flex-shrink-0" />}

        <span
          className={`font-body flex-1 min-w-0 truncate ${
            isPosting ? 'text-body' : 'text-navy tracking-[0.04em]'
          }`}
        >
          {node.name}
          {isInactive && (
            <span className="ml-2 italic text-[9pt] text-muted">(inactive)</span>
          )}
        </span>

        {isPosting ? (
          <span
            className={`text-right tabular-nums w-24 flex-shrink-0 ${
              amount < 0 ? 'text-status-red' : 'text-body'
            }`}
          >
            {fmtUsd(amount)}
          </span>
        ) : (
          <span
            className={`text-right tabular-nums w-24 flex-shrink-0 font-medium ${
              node.rollup < 0 ? 'text-status-red' : 'text-navy'
            }`}
          >
            {fmtUsd(node.rollup)}
          </span>
        )}
      </div>

      {node.children.map((child) => (
        <RowPrint key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  )
}
