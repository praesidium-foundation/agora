import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useModulePermission } from '../../lib/usePermission'
import { useToast } from '../../lib/Toast'
import { computeEnvelopesUsed } from '../../lib/tuitionMath'
import { formatCurrency, formatInteger } from '../../lib/format'
import AppShell from '../../components/AppShell'
import Breadcrumb from '../../components/Breadcrumb'
import TuitionImportStagingTable from '../../components/tuition/TuitionImportStagingTable'

// Tuition Audit import staging review page.
//
// v3.8.18 (Tuition-B2-import). Route: /modules/tuition/audit/import/:batchId
//
// Loads a single staged batch + its rows. Renders:
//
//   - Header: batch metadata (filename, upload time, row count, status)
//   - Summary callout: total / errors / warnings / clean counts
//   - Mode radios: append (default) / replace (destructive)
//   - Staging table (TuitionImportStagingTable): per-row preview
//     with computed columns and status indicators
//   - Envelope-tracker preview: post-accept envelope state given the
//     mode toggle
//   - Action buttons: Reject (secondary, with optional reason) /
//     Accept (primary; disabled when any row has errors)
//
// The accept path calls accept_tuition_audit_import_batch RPC; on
// success, navigates back to the Tuition Audit page with a toast.

function TuitionAuditImportStaging() {
  const { batchId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { allowed: canView, loading: permLoading } = useModulePermission('tuition', 'view')
  const { allowed: canEdit } = useModulePermission('tuition', 'edit')

  const [batch, setBatch] = useState(null)
  const [scenario, setScenario] = useState(null)
  const [stagedRows, setStagedRows] = useState([])
  const [existingFamilies, setExistingFamilies] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [mode, setMode] = useState('append')
  const [submitting, setSubmitting] = useState(false)
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false)
  const [showRejectConfirm, setShowRejectConfirm] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const loadAll = useCallback(async () => {
    if (!batchId || !canView) return
    setLoading(true)
    setLoadError(null)
    try {
      const { data: batchRow, error: batchErr } = await supabase
        .from('tuition_audit_import_batches')
        .select('*')
        .eq('id', batchId)
        .single()
      if (batchErr) throw batchErr
      if (!batchRow) throw new Error('Import batch not found.')
      setBatch(batchRow)

      const { data: stagedData, error: stagedErr } = await supabase
        .from('tuition_audit_import_staged_rows')
        .select('*')
        .eq('batch_id', batchId)
        .order('row_number', { ascending: true })
      if (stagedErr) throw stagedErr
      setStagedRows(stagedData || [])

      // Fetch the active scenario for tier_rates / faculty_pct used
      // by the computed-column math.
      const { data: scenarioRow, error: scenarioErr } = await supabase
        .from('tuition_worksheet_scenarios')
        .select('id, scenario_label, tier_rates, faculty_discount_pct, projected_faculty_discount_amount, projected_other_discount, projected_financial_aid, projected_multi_student_discount')
        .eq('id', batchRow.scenario_id)
        .single()
      if (scenarioErr) throw scenarioErr
      setScenario(scenarioRow)

      // Fetch existing family_details rows for the envelope-tracker
      // preview (append vs replace would produce different
      // post-accept totals).
      const { data: familyRows, error: familyErr } = await supabase
        .from('tuition_worksheet_family_details')
        .select('id, students_enrolled, applied_tier_size, applied_tier_rate, faculty_discount_amount, other_discount_amount, financial_aid_amount, is_faculty_family')
        .eq('scenario_id', batchRow.scenario_id)
      if (familyErr) throw familyErr
      setExistingFamilies(familyRows || [])
    } catch (e) {
      setLoadError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [batchId, canView])

  useEffect(() => { loadAll() }, [loadAll])

  // Counts.
  const totals = useMemo(() => {
    const totalRows = stagedRows.length
    let errorCount = 0
    let warningCount = 0
    let cleanCount = 0
    for (const r of stagedRows) {
      const errs = Array.isArray(r.parse_errors) ? r.parse_errors.length : 0
      const warns = Array.isArray(r.parse_warnings) ? r.parse_warnings.length : 0
      if (errs > 0) errorCount++
      else if (warns > 0) warningCount++
      else cleanCount++
    }
    return { totalRows, errorCount, warningCount, cleanCount }
  }, [stagedRows])

  // Envelope-tracker preview. Given the current mode toggle, what
  // would the envelope state look like post-accept?
  const previewEnvelopes = useMemo(() => {
    if (!scenario) return null
    // Post-accept families = existing (if append) merged with
    // staged-and-error-free rows mapped into family-shape, OR
    // staged-and-error-free only (if replace).
    const stagedAsFamilies = stagedRows
      .filter((r) => !Array.isArray(r.parse_errors) || r.parse_errors.length === 0)
      .map((r) => ({
        students_enrolled:       r.students_enrolled,
        is_faculty_family:       r.is_faculty_family,
        applied_tier_size:       null,  // not yet committed; tier resolves at accept time
        applied_tier_rate:       null,
        faculty_discount_amount: r.faculty_discount_amount,
        other_discount_amount:   r.other_discount_amount,
        financial_aid_amount:    r.financial_aid_amount,
      }))
    const projectedFamilies = mode === 'replace'
      ? stagedAsFamilies
      : [...existingFamilies, ...stagedAsFamilies]
    return computeEnvelopesUsed(projectedFamilies, scenario)
  }, [stagedRows, existingFamilies, scenario, mode])

  // ---- accept / reject handlers ----------------------------------------

  async function performAccept() {
    if (!batchId || !canEdit) return
    setSubmitting(true)
    try {
      const { data, error } = await supabase.rpc('accept_tuition_audit_import_batch', {
        p_batch_id: batchId,
        p_mode:     mode,
      })
      if (error) throw error
      const committed = Array.isArray(data) ? data[0] : data
      toast.success(`${committed} ${committed === 1 ? 'family' : 'families'} imported.`)
      navigate('/modules/tuition/audit')
    } catch (e) {
      toast.error(e.message || String(e))
      setSubmitting(false)
    }
  }

  function handleAcceptClick() {
    if (totals.errorCount > 0 || !canEdit) return
    if (mode === 'replace') {
      setShowReplaceConfirm(true)
    } else {
      performAccept()
    }
  }

  async function performReject() {
    if (!batchId || !canEdit) return
    setSubmitting(true)
    try {
      const { error } = await supabase.rpc('reject_tuition_audit_import_batch', {
        p_batch_id: batchId,
        p_reason:   rejectReason.trim() || null,
      })
      if (error) throw error
      toast.success('Import rejected.')
      navigate('/modules/tuition/audit')
    } catch (e) {
      toast.error(e.message || String(e))
      setSubmitting(false)
    }
  }

  // ---- render branches -------------------------------------------------

  if (permLoading) {
    return <AppShell><p className="text-muted">Loading…</p></AppShell>
  }

  if (!canView) {
    return (
      <AppShell>
        <Breadcrumb items={[{ label: 'Tuition' }, { label: 'Audit' }, { label: 'Import' }]} />
        <h1 className="font-display text-navy text-[28px] mb-3 leading-tight">
          You do not have access to this module.
        </h1>
        <Link
          to="/dashboard"
          className="inline-block bg-navy text-gold px-4 py-2 rounded text-sm hover:opacity-90 transition-opacity"
        >
          Back to Dashboard
        </Link>
      </AppShell>
    )
  }

  if (loadError) {
    return (
      <AppShell>
        <Breadcrumb items={[{ label: 'Tuition' }, { label: 'Audit' }, { label: 'Import' }]} />
        <h1 className="font-display text-navy text-[24px] mb-3 leading-tight">
          Could not load import batch
        </h1>
        <p className="text-status-red text-sm mb-4" role="alert">{loadError}</p>
        <Link
          to="/modules/tuition/audit"
          className="inline-block bg-navy text-gold px-4 py-2 rounded text-sm hover:opacity-90 transition-opacity"
        >
          Back to Tuition Audit
        </Link>
      </AppShell>
    )
  }

  if (loading || !batch || !scenario) {
    return <AppShell><p className="text-muted">Loading import batch…</p></AppShell>
  }

  const isStaged = batch.status === 'staged'
  const acceptDisabled = !canEdit || !isStaged || totals.errorCount > 0 || submitting
  const acceptTooltip = totals.errorCount > 0
    ? `Fix the ${totals.errorCount} row${totals.errorCount === 1 ? '' : 's'} with errors before accepting (reject + re-upload).`
    : !isStaged
      ? `This batch has already been ${batch.status}.`
      : !canEdit
        ? 'Edit permission required to accept the import.'
        : `Accept this import in ${mode} mode.`

  return (
    <AppShell>
      <div className="-mx-6 -my-6 flex flex-col h-[calc(100vh-3.5rem)]">
        <div className="px-6 py-4 flex-1 overflow-y-auto">

          <header className="mb-4">
            <Breadcrumb items={[
              { label: 'Tuition' },
              { label: 'Audit', to: '/modules/tuition/audit' },
              { label: 'Import' },
            ]} />
            <div className="flex items-end justify-between gap-4 flex-wrap">
              <div>
                <h1 className="font-display text-navy text-[26px] leading-tight">
                  Reviewing Imported Family Data
                </h1>
                <p className="font-body text-muted text-[12px] mt-1">
                  <strong className="font-medium text-body">{batch.file_name}</strong>
                  {' · '}
                  Uploaded {new Date(batch.uploaded_at).toLocaleString(undefined, {
                    year: 'numeric', month: 'short', day: 'numeric',
                    hour: 'numeric', minute: '2-digit',
                  })}
                  {' · '}
                  {batch.row_count} {batch.row_count === 1 ? 'row' : 'rows'}
                  {' · '}
                  Status: <strong className="font-medium text-body uppercase">{batch.status}</strong>
                </p>
              </div>
              <Link
                to="/modules/tuition/audit"
                className="font-body text-status-blue hover:underline text-sm"
              >
                ← Back to Tuition Audit
              </Link>
            </div>
          </header>

          {/* Status callout */}
          <div className="grid grid-cols-4 gap-3 mb-4">
            <SummaryCard label="Total rows" value={totals.totalRows} tone="navy" />
            <SummaryCard label="Errors" value={totals.errorCount} tone={totals.errorCount > 0 ? 'red' : 'muted'} />
            <SummaryCard label="Warnings" value={totals.warningCount} tone={totals.warningCount > 0 ? 'amber' : 'muted'} />
            <SummaryCard label="Clean" value={totals.cleanCount} tone={totals.cleanCount > 0 ? 'green' : 'muted'} />
          </div>

          {/* Mode radios */}
          {isStaged && (
            <div className="bg-white border-[0.5px] border-card-border rounded-[6px] p-4 mb-4">
              <h2 className="font-display text-navy text-[12px] uppercase tracking-[0.1em] mb-3">
                Import Mode
              </h2>
              <div role="radiogroup" className="space-y-2">
                <label className="flex items-start gap-2 cursor-pointer text-sm">
                  <input
                    type="radio"
                    name="import-mode"
                    value="append"
                    checked={mode === 'append'}
                    onChange={() => setMode('append')}
                    className="accent-navy mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-body">Append to existing families</span>
                    <span className="block text-muted italic text-[12px] leading-snug mt-0.5">
                      Preserves any existing family rows; staged rows are added.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer text-sm">
                  <input
                    type="radio"
                    name="import-mode"
                    value="replace"
                    checked={mode === 'replace'}
                    onChange={() => setMode('replace')}
                    className="accent-navy mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-status-red">Replace all existing families</span>
                    <span className="block text-muted italic text-[12px] leading-snug mt-0.5">
                      Deletes all {existingFamilies.length} existing {existingFamilies.length === 1 ? 'row' : 'rows'} and replaces them with these {totals.totalRows} imported rows. Cannot be undone via the activity feed.
                    </span>
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* Staging table */}
          <TuitionImportStagingTable stagedRows={stagedRows} scenario={scenario} />

          {/* Envelope tracker preview */}
          {previewEnvelopes && isStaged && (
            <div className="mt-4 bg-white border-[0.5px] border-card-border rounded-[6px] p-4">
              <h2 className="font-display text-navy text-[12px] uppercase tracking-[0.1em] mb-3">
                Envelope preview · if accepted in <span className="text-gold">{mode}</span> mode
              </h2>
              <div className="grid grid-cols-[120px_75px_85px_85px] gap-x-4 gap-y-1.5 text-[12px]">
                <span />
                <span className="font-body text-muted uppercase tracking-wider text-[10px] text-right">Budget</span>
                <span className="font-body text-muted uppercase tracking-wider text-[10px] text-right">Used</span>
                <span className="font-body text-muted uppercase tracking-wider text-[10px] text-right">Remaining</span>
                {previewEnvelopes.rows.map((r) => (
                  <PreviewEnvelopeRow key={r.key} row={r} />
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          {isStaged && (
            <div className="mt-4 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowRejectConfirm(true)}
                disabled={!canEdit || submitting}
                className="bg-white border-[0.5px] border-status-red/40 text-status-red px-4 py-2 rounded text-sm font-body hover:bg-status-red-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Reject Import
              </button>
              <button
                type="button"
                onClick={handleAcceptClick}
                disabled={acceptDisabled}
                title={acceptTooltip}
                className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Submitting…' : `Accept Import (${mode})`}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Replace-mode confirmation */}
      {showReplaceConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
          onClick={() => !submitting && setShowReplaceConfirm(false)}
          role="presentation"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-md w-full p-6 shadow-lg"
            role="dialog"
            aria-modal="true"
          >
            <h3 className="font-display text-navy text-[18px] mb-2 leading-tight">
              Replace all existing families?
            </h3>
            <p className="text-body text-sm leading-relaxed mb-4">
              This will permanently delete all{' '}
              <strong className="font-medium">{existingFamilies.length}</strong> existing
              {existingFamilies.length === 1 ? ' family row' : ' family rows'} in this Tuition Audit and replace them with the{' '}
              <strong className="font-medium">{totals.totalRows}</strong> imported rows. This cannot be undone via the activity feed.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowReplaceConfirm(false)}
                disabled={submitting}
                className="font-body text-muted hover:text-navy text-sm disabled:opacity-30"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { setShowReplaceConfirm(false); performAccept() }}
                disabled={submitting}
                className="bg-status-red text-white border-[0.5px] border-status-red px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Submitting…' : 'Replace and Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject confirmation with optional reason */}
      {showRejectConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
          onClick={() => !submitting && setShowRejectConfirm(false)}
          role="presentation"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-md w-full p-6 shadow-lg"
            role="dialog"
            aria-modal="true"
          >
            <h3 className="font-display text-navy text-[18px] mb-2 leading-tight">
              Reject this import?
            </h3>
            <p className="text-body text-sm leading-relaxed mb-3">
              The batch will be marked rejected. The staged data is retained
              for audit; no family rows are added.
            </p>
            <label htmlFor="reject-reason" className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5">
              Reason (optional)
            </label>
            <textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              placeholder="e.g. Several rows had wrong faculty flags; will fix the source spreadsheet and re-upload."
              className="w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none mb-4"
            />
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowRejectConfirm(false)}
                disabled={submitting}
                className="font-body text-muted hover:text-navy text-sm disabled:opacity-30"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { setShowRejectConfirm(false); performReject() }}
                disabled={submitting}
                className="bg-status-red text-white border-[0.5px] border-status-red px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Submitting…' : 'Reject Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  )
}

function SummaryCard({ label, value, tone }) {
  const colorClass = {
    navy:  'text-navy',
    red:   'text-status-red',
    amber: 'text-status-amber',
    green: 'text-status-green',
    muted: 'text-muted',
  }[tone] || 'text-navy'
  return (
    <div className="bg-white border-[0.5px] border-card-border rounded-[6px] px-4 py-3">
      <p className="font-body text-muted text-[10px] uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className={`font-display text-[22px] tabular-nums ${colorClass}`}>
        {formatInteger(value)}
      </p>
    </div>
  )
}

function PreviewEnvelopeRow({ row }) {
  return (
    <>
      <span className="text-body">{row.label}</span>
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

export default TuitionAuditImportStaging
