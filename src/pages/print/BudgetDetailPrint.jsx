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

      <TopGroupPrint group={tree.income} />
      <TopGroupPrint group={tree.expense} />
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

// KPI summary — compact two-column key/value grid. The grid itself is
// allowed to break across pages if it must (no print-category here);
// keeping it small enough that this rarely happens. After the KPIs,
// the budget detail begins immediately on the same page if there's
// room — no forced page-break.
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
    <section className="mt-1 mb-3 grid grid-cols-2 gap-x-8 gap-y-1 text-[12px]">
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
    <section className="mt-3 mb-4">
      <h2 className="font-display text-navy text-[12px] tracking-[0.10em] uppercase mb-2">
        Narrative
      </h2>
      <p className="font-body text-body whitespace-pre-wrap leading-relaxed text-[11pt]">
        {text}
      </p>
    </section>
  )
}

// ============================================================================
// Hierarchical body — four-tier visual treatment per architecture §10.4.
//
//   Tier 1: top-level categories (INCOME / EXPENSES) — Cinzel 16pt navy,
//           gold underline, full-width row, vertical breathing room
//   Tier 2: first-level summary children of a category (Educational
//           Program Revenue, Personnel, Facilities, etc.) — EB Garamond
//           13pt bold navy, thin navy underline @ 30%, ~95% width
//   Tier 3: deeper summary nodes (Revenue – Tuition, Tuition Discounts,
//           Payroll, etc.) — EB Garamond 12pt bold navy, no rule, ~85% width
//   Tier 4: leaf posting accounts — EB Garamond 11pt navy @ 80%, regular
//           weight, code in 50px left column, ~75% width
//
// Indentation: 24px per tier (Tier 1 at 0, Tier 2 at 24, Tier 3 at 48,
// Tier 4 at 72). Indentation is the structural backbone; weight/size/
// rules reinforce.
//
// Page-break behavior (driven via .print-tier-2 / .print-tier-3-header
// in print.css):
//   - Tier 2 blocks: break-inside: avoid → stay together when possible
//   - Tier 3 headers: break-after: avoid → keep header with first child
//   - Tier 1 / Tier 4: break freely (a category that always wants to
//     stay together would force a new page on every category)
// ============================================================================

// Render a tier-1 category (INCOME or EXPENSES) and its full subtree.
function TopGroupPrint({ group }) {
  return (
    <section className="mt-6 print-tier-1">
      <header
        className="flex items-baseline gap-3 pb-1 mb-3"
        style={{
          borderBottom: '1pt solid rgba(215, 191, 103, 0.6)', // gold @ 60%
          paddingTop: '6pt',
          paddingBottom: '4pt',
        }}
      >
        <span
          className="font-display text-navy flex-1"
          style={{ fontSize: '16pt', letterSpacing: '0.05em' }}
        >
          {group.label}
        </span>
        <span
          className={`font-display tabular-nums ${group.total < 0 ? 'text-status-red' : 'text-navy'}`}
          style={{ fontSize: '16pt' }}
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
          <Tier2Block key={node.id} node={node} />
        ))
      )}
    </section>
  )
}

// Tier 2: top-level summary block. break-inside: avoid in print so
// "Personnel" and its dozen leaves stay together when possible.
//
// If the Tier 2 node IS a posting leaf itself (rare — a top-level
// category child that's also a leaf), render it as a single-row
// posting line at the Tier 2 width.
function Tier2Block({ node }) {
  const isLeafItself = node.posts_directly && node.children.length === 0

  if (isLeafItself) {
    // Render as a Tier 4 leaf at Tier 2 indent. Same alignment math as
    // the leaf renderer, just at a different starting indent.
    return <LeafRow node={node} depth={1} />
  }

  return (
    <section className="print-tier-2 mt-4 mb-2" style={{ paddingLeft: '24px' }}>
      <header
        className="flex items-baseline gap-3 pb-1 mb-1"
        style={{
          borderBottom: '0.5pt solid rgba(25, 42, 79, 0.3)', // navy @ 30%
          maxWidth: '95%',
          paddingTop: '6pt',
        }}
      >
        <span
          className="font-body font-bold text-navy flex-1 truncate"
          style={{ fontSize: '13pt' }}
        >
          {node.name}
        </span>
        <span
          className={`font-body font-bold tabular-nums ${node.rollup < 0 ? 'text-status-red' : 'text-navy'}`}
          style={{ fontSize: '13pt' }}
        >
          {fmtUsd(node.rollup)}
        </span>
      </header>
      {node.children.map((child) => (
        <SubtreeRenderer key={child.id} node={child} depth={2} />
      ))}
    </section>
  )
}

// Recursive subtree renderer for Tier 3 / Tier 4. Decides per-node
// whether it's a summary (renders as Tier 3 header + recursed children)
// or a leaf (renders as Tier 4 row).
//
// `depth` here is the tier number we're at (2 = directly inside Tier 2,
// 3 = Tier 3, 4 = Tier 4). All Tier 3 and below clamp to Tier 4 styling
// for leaves regardless of actual tree depth — keeps the visual
// hierarchy at four tiers even when the underlying COA has deeper
// nesting.
function SubtreeRenderer({ node, depth }) {
  const isPosting = node.posts_directly
  const hasChildren = node.children.length > 0

  if (isPosting && !hasChildren) {
    // Leaf — Tier 4 styling regardless of depth.
    return <LeafRow node={node} depth={depth} />
  }

  // Summary: Tier 3 header (or deeper-nested clamp) + recursed children.
  return (
    <div className="mb-1">
      <Tier3Header node={node} depth={depth} />
      {node.children.map((child) => (
        <SubtreeRenderer
          key={child.id}
          node={child}
          depth={Math.min(depth + 1, 4)}
        />
      ))}
    </div>
  )
}

function Tier3Header({ node, depth }) {
  // Indent matches tier (24 / 48 / 72). Rare deeper nesting clamps at 72.
  const indentPx = Math.min(24 * depth, 72)
  return (
    <div
      className="print-tier-3-header flex items-baseline gap-3"
      style={{
        paddingLeft: `${indentPx}px`,
        maxWidth: '85%',
        paddingTop: '6pt',
        paddingBottom: '3pt',
      }}
    >
      <span
        className="font-body font-bold text-navy flex-1 truncate"
        style={{ fontSize: '12pt' }}
      >
        {node.name}
      </span>
      <span
        className={`font-body font-bold tabular-nums ${node.rollup < 0 ? 'text-status-red' : 'text-navy'}`}
        style={{ fontSize: '12pt' }}
      >
        {fmtUsd(node.rollup)}
      </span>
    </div>
  )
}

// Tier 4 leaf row.
//
// Three-column layout inside the row:
//   [code: 50px, navy @ 60%] [name: flex, navy @ 80%] [amount: right]
//
// Container max-width is 75% so the right edge sits ~25% away from the
// page edge — the eye associates name with amount as one cohesive unit.
function LeafRow({ node, depth }) {
  const indentPx = 24 * depth // depth=1 (Tier 2 leaf) → 24, depth=4 → 96
  const amount = node.line ? node.line.amount : 0
  const isInactive = node.is_active === false
  return (
    <div
      className={`flex items-baseline gap-3 ${isInactive ? 'opacity-70' : ''}`}
      style={{
        paddingLeft: `${indentPx}px`,
        maxWidth: '75%',
        paddingTop: '2pt',
        paddingBottom: '2pt',
      }}
    >
      <span
        className="font-body tabular-nums flex-shrink-0"
        style={{
          width: '50px',
          fontSize: '10pt',
          color: 'rgba(25, 42, 79, 0.6)', // navy @ 60%
        }}
      >
        {node.code || ''}
      </span>
      <span
        className="font-body flex-1 min-w-0 truncate"
        style={{
          fontSize: '11pt',
          color: 'rgba(25, 42, 79, 0.85)', // navy @ ~85% — slightly muted but
                                            // comfortably above WCAG AA on white
        }}
      >
        {node.name}
        {isInactive && (
          <span className="ml-2 italic" style={{ fontSize: '9pt', color: '#475472' }}>
            (inactive)
          </span>
        )}
      </span>
      <span
        className={`font-body tabular-nums ${amount < 0 ? 'text-status-red' : ''}`}
        style={{
          fontSize: '11pt',
          color: amount < 0 ? undefined : 'rgba(25, 42, 79, 0.85)',
        }}
      >
        {fmtUsd(amount)}
      </span>
    </div>
  )
}
