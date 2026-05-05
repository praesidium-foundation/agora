import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useToast } from '../../lib/Toast'
import { downloadTuitionImportTemplate, parseUploadedFile } from '../../lib/tuitionImportTemplate'
import { parseSpreadsheetRows } from '../../lib/tuitionImportParser'

// Bulk Family Import — upload modal.
//
// v3.8.18 (Tuition-B2-import). Three-step affordance:
//
//   1. Download Template button — generates a multi-tab XLSX with
//      Instructions + Family Data sheets (live reference values
//      pulled from the active scenario).
//   2. File picker — accepts XLSX or CSV; clicking opens the OS
//      file dialog.
//   3. On file selection: parses the file client-side, normalizes
//      rows via tuitionImportParser, posts the parsed-rows array
//      to create_tuition_audit_import_batch RPC, then navigates to
//      the staging review page.
//
// Server-side validation (Migration 041) re-runs every parse on
// the staging rows; the client-side parse is for early UX feedback
// (the upload modal won't post a file that produces zero rows or
// surfaces a fatal parse failure).
//
// Props:
//   scenario   — active Stage 2 scenario row (for template
//                reference values + RPC scenario_id)
//   ayeLabel   — for template filename + Instructions tab heading
//   onCancel   — () => void
//   onSuccess  — (batch_id) => void; parent typically navigates
//                away to the staging page

export default function TuitionImportUploadModal({ scenario, ayeLabel, onCancel, onSuccess }) {
  const navigate = useNavigate()
  const toast = useToast()
  const fileInputRef = useRef(null)
  const [phase, setPhase] = useState('idle')   // 'idle' | 'parsing' | 'staging' | 'error'
  const [errorMessage, setErrorMessage] = useState(null)

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && phase === 'idle') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, phase])

  function handleDownloadTemplate() {
    try {
      downloadTuitionImportTemplate(scenario, ayeLabel)
      toast.success('Template downloaded.')
    } catch (e) {
      toast.error(`Could not generate template: ${e.message || String(e)}`)
    }
  }

  function handleClickFilePicker() {
    fileInputRef.current?.click()
  }

  async function handleFileSelected(event) {
    const file = event.target.files?.[0]
    // Reset the input so re-selecting the same file fires onChange.
    event.target.value = ''
    if (!file) return
    if (!scenario?.id) {
      setErrorMessage('No active Tuition Audit scenario.')
      setPhase('error')
      return
    }

    setPhase('parsing')
    setErrorMessage(null)

    // Step 1: parse the file client-side.
    const parseResult = await parseUploadedFile(file)
    if (parseResult.error) {
      setErrorMessage(parseResult.error)
      setPhase('error')
      return
    }
    const { rows: rawRows, format } = parseResult

    if (rawRows.length === 0) {
      setErrorMessage('The uploaded file produced no data rows. Confirm the "Family Data" tab has rows below the header.')
      setPhase('error')
      return
    }

    // Step 2: normalize + validate rows.
    const normalized = parseSpreadsheetRows(rawRows)

    // Step 3: build the parsed_rows jsonb payload for the RPC.
    // The RPC expects each row keyed by snake_case schema column.
    //
    // v3.8.19: include client_parse_errors and client_parse_warnings
    // alongside the normalized data so the server can preserve
    // client-detected issues (e.g., unparseable date strings the
    // client coerced to null) AND merge them with server-side
    // validation outcomes. Without this, a client-flagged
    // unparseable-date error would be lost on the round-trip.
    const parsedRowsPayload = normalized.rows.map((r) => ({
      family_label:           r.normalized.family_label,
      students_enrolled:      r.normalized.students_enrolled,
      is_faculty_family:      r.normalized.is_faculty_family,
      date_enrolled:          r.normalized.date_enrolled,
      date_withdrawn:         r.normalized.date_withdrawn,
      faculty_discount_amount: r.normalized.faculty_discount_amount,
      other_discount_amount:   r.normalized.other_discount_amount,
      financial_aid_amount:    r.normalized.financial_aid_amount,
      notes:                   r.normalized.notes,
      client_parse_errors:     r.errors,
      client_parse_warnings:   r.warnings,
      raw_row:                 r.raw_row,
    }))

    setPhase('staging')

    // Step 4: post to create_tuition_audit_import_batch.
    try {
      const { data, error } = await supabase.rpc('create_tuition_audit_import_batch', {
        p_scenario_id: scenario.id,
        p_file_name:   file.name,
        p_file_format: format,
        p_parsed_rows: parsedRowsPayload,
      })
      if (error) throw error
      const batchId = Array.isArray(data) ? data[0] : data
      toast.success(`Staged ${normalized.rows.length} row${normalized.rows.length === 1 ? '' : 's'} for review.`)
      // Navigate to the staging review page. Parent's onSuccess
      // hook fires too in case the parent wants to refresh state
      // (e.g., the import-history affordance).
      onSuccess?.(batchId)
      navigate(`/modules/tuition/audit/import/${batchId}`)
    } catch (e) {
      setErrorMessage(e.message || String(e))
      setPhase('error')
    }
  }

  function handleRetry() {
    setErrorMessage(null)
    setPhase('idle')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
      onClick={() => phase === 'idle' && onCancel()}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-cream border-[0.5px] border-card-border rounded-[10px] max-w-xl w-full p-0 shadow-lg max-h-[90vh] overflow-hidden flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-upload-title"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b-[0.5px] border-card-border">
          <h3
            id="import-upload-title"
            className="font-display text-navy text-[18px] leading-tight"
          >
            Import Family Data
          </h3>
          <button
            type="button"
            onClick={() => phase === 'idle' && onCancel()}
            disabled={phase !== 'idle'}
            aria-label="Close"
            className="text-muted hover:text-navy text-[18px] leading-none disabled:opacity-30"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto">
          <p className="text-body text-sm leading-relaxed mb-4">
            Bulk-import family rows for this Tuition Audit. Download the
            template, fill it out in your spreadsheet app, then upload —
            you'll review the parsed rows in a staging window before
            anything commits.
          </p>

          {phase === 'parsing' && (
            <p className="text-muted italic text-sm">Parsing file…</p>
          )}
          {phase === 'staging' && (
            <p className="text-muted italic text-sm">Staging rows for review…</p>
          )}
          {phase === 'error' && (
            <div className="mb-4 px-3 py-2 bg-status-red-bg border-[0.5px] border-status-red/25 rounded">
              <p className="text-status-red text-sm" role="alert">
                {errorMessage || 'Upload failed.'}
              </p>
              <button
                type="button"
                onClick={handleRetry}
                className="mt-2 font-body text-status-red text-sm underline-offset-2 hover:underline"
              >
                Try again
              </button>
            </div>
          )}

          {phase === 'idle' && (
            <>
              <div className="bg-white border-[0.5px] border-card-border rounded-[6px] p-4 mb-4">
                <h4 className="font-display text-navy text-[13px] uppercase tracking-[0.06em] mb-2">
                  Step 1 · Download the template
                </h4>
                <p className="text-body text-[13px] leading-relaxed mb-3">
                  The template includes step-by-step instructions and a
                  Family Data tab with formatted column headers.
                </p>
                <button
                  type="button"
                  onClick={handleDownloadTemplate}
                  className="bg-white border-[0.5px] border-navy text-navy px-3.5 py-2 rounded text-sm font-body hover:bg-cream-highlight transition-colors"
                >
                  Download Template
                </button>
              </div>

              <div className="bg-white border-[0.5px] border-card-border rounded-[6px] p-4">
                <h4 className="font-display text-navy text-[13px] uppercase tracking-[0.06em] mb-2">
                  Step 2 · Upload your filled-in file
                </h4>
                <p className="text-body text-[13px] leading-relaxed mb-3">
                  Save your file as XLSX or CSV — both formats are accepted.
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.csv"
                  onChange={handleFileSelected}
                  className="sr-only"
                />
                <button
                  type="button"
                  onClick={handleClickFilePicker}
                  className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity"
                >
                  Choose File…
                </button>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-4 px-6 py-4 border-t-[0.5px] border-card-border">
          <button
            type="button"
            onClick={onCancel}
            disabled={phase !== 'idle' && phase !== 'error'}
            className="font-body text-muted hover:text-navy text-sm disabled:opacity-30"
          >
            {phase === 'error' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}
