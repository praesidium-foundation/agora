import { useEffect, useMemo, useState } from 'react'
import { parseCsv, downloadCsv } from '../../lib/csv'
import { fetchBudgetableAccounts } from '../../lib/budgetBootstrap'

// CSV import for the Preliminary Budget bootstrap flow.
//
// Format expectations (per build spec, Section B):
//
//   Required columns: account_code, annual_amount
//   Optional column:  notes
//   Negative amounts allowed (contra-revenue / discounts).
//   Empty annual_amount cells treated as 0.
//   Currency-formatted strings normalized: "$852,208" → 852208
//
// Stages:
//   1. file picker
//   2. parse + auto-detect headers
//   3. validate against COA (match codes to posting non-pass-thru active
//      accounts; collect unmatched as warnings)
//   4. preview summary (importing N lines, $X income, $Y expense)
//   5. caller-driven insert
//
// Stages 1 + 2 collapse here into the "Choose file" interaction. Stages 3
// and 4 render in the modal body. Stage 5 is the parent's onConfirm
// callback (which gets a row set ready for createScenarioFromCsvRows).

// Required columns. Match is case-insensitive, header normalized.
const REQUIRED_COLS = ['account_code', 'annual_amount']

// Normalize a header cell for matching: lower-case, trim, replace whitespace
// with underscores. So "Account Code" / "account_code" / "Account_Code" all
// match.
function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '_')
}

// Strip currency symbols, thousands separators, spaces. Convert empty to 0.
// Returns { ok: true, value: number } or { ok: false, error: 'reason' }.
function parseAmount(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return { ok: true, value: 0 }
  // Tolerate parentheses for negatives ("(1,234)" → -1234), the QuickBooks
  // export convention. Strip currency symbols and commas afterward.
  let working = s
  let isNeg = false
  const parens = /^\(([^)]+)\)$/.exec(working)
  if (parens) {
    isNeg = true
    working = parens[1]
  }
  working = working.replace(/[$,\s]/g, '')
  if (working === '' || working === '-') {
    return { ok: false, error: `"${s}" is not a number` }
  }
  const n = Number(working)
  if (!Number.isFinite(n)) {
    return { ok: false, error: `"${s}" is not a number` }
  }
  return { ok: true, value: isNeg ? -Math.abs(n) : n }
}

const TEMPLATE_FILENAME = 'agora_budget_template.csv'
const TEMPLATE_TEXT =
  'account_code,annual_amount,notes\r\n' +
  '4100,852208,Gross tuition revenue\r\n' +
  '4192,-5130,Teacher discount\r\n' +
  '4305,9750,\r\n'

function CsvImportModal({ onCancel, onConfirm, ayeLabel }) {
  // Stage state. 'pick' → user hasn't chosen a file yet.
  // 'preview' → file parsed and validated; preview is on screen.
  // 'inserting' → onConfirm is in flight.
  const [stage, setStage] = useState('pick')
  const [filename, setFilename] = useState(null)
  const [error, setError] = useState(null)
  const [warnings, setWarnings] = useState([])
  const [preview, setPreview] = useState(null)
  // Parsed rows ready to hand to onConfirm. Populated alongside preview.
  const [readyRows, setReadyRows] = useState([])

  const [accounts, setAccounts] = useState(null)
  const [accountsError, setAccountsError] = useState(null)

  useEffect(() => {
    let mounted = true
    fetchBudgetableAccounts()
      .then((data) => {
        if (mounted) setAccounts(data)
      })
      .catch((e) => {
        if (mounted) setAccountsError(e.message || String(e))
      })
    return () => {
      mounted = false
    }
  }, [])

  const accountsByCode = useMemo(() => {
    if (!accounts) return new Map()
    const m = new Map()
    for (const a of accounts) {
      if (a.code) m.set(String(a.code), a)
    }
    return m
  }, [accounts])

  function reset() {
    setStage('pick')
    setFilename(null)
    setError(null)
    setWarnings([])
    setPreview(null)
    setReadyRows([])
  }

  async function handleFile(file) {
    setError(null)
    setWarnings([])
    setPreview(null)
    setReadyRows([])
    setFilename(file.name)

    if (!accounts) {
      setError('Chart of Accounts is still loading — try again in a moment.')
      return
    }

    let text
    try {
      text = await file.text()
    } catch (e) {
      setError(`Could not read file: ${e.message || e}`)
      return
    }

    const rows = parseCsv(text)
    if (rows.length === 0) {
      setError('CSV is empty.')
      return
    }

    const header = rows[0].map(normalizeHeader)
    // Header validation: every required column present.
    const missing = REQUIRED_COLS.filter((req) => !header.includes(req))
    if (missing.length > 0) {
      setError(
        `CSV is missing required column(s): ${missing.join(', ')}. ` +
          `Found columns: ${header.join(', ')}.`
      )
      return
    }

    const colIdx = {
      account_code: header.indexOf('account_code'),
      annual_amount: header.indexOf('annual_amount'),
      notes: header.indexOf('notes'),
    }

    // Walk data rows. Collect:
    //   - matched rows (will insert)
    //   - unmatched codes (warnings; user chooses skip-and-continue or cancel)
    //   - hard errors (duplicate codes, non-numeric amounts → reject file)
    const seenCodes = new Set()
    const dupedCodes = []
    const unmatchedCodes = []
    const matchedRows = []
    const amountErrors = []

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]
      // Skip wholly-blank rows (trailing newline artifacts)
      if (row.every((c) => String(c ?? '').trim() === '')) continue

      const code = String(row[colIdx.account_code] ?? '').trim()
      if (!code) continue  // blank code row: skip

      if (seenCodes.has(code)) {
        dupedCodes.push(code)
        continue
      }
      seenCodes.add(code)

      const amountResult = parseAmount(row[colIdx.annual_amount])
      if (!amountResult.ok) {
        amountErrors.push(`Row ${r + 1} (code ${code}): ${amountResult.error}`)
        continue
      }

      const acct = accountsByCode.get(code)
      if (!acct) {
        unmatchedCodes.push(code)
        continue
      }

      // Eligibility (extra guard): the fetchBudgetableAccounts query
      // already filters to posting + non-pass-thru + active. Defensive
      // re-check in case future fetches broaden.
      if (!acct.posts_directly || acct.is_pass_thru || !acct.is_active) {
        unmatchedCodes.push(code)
        continue
      }

      const noteRaw =
        colIdx.notes >= 0 ? String(row[colIdx.notes] ?? '').trim() : ''

      matchedRows.push({
        accountId: acct.id,
        amount: amountResult.value,
        notes: noteRaw === '' ? null : noteRaw,
      })
    }

    // Hard errors: kill the file.
    if (dupedCodes.length > 0) {
      setError(
        `Duplicate account_code(s) in file: ${dupedCodes.slice(0, 8).join(', ')}` +
          (dupedCodes.length > 8 ? ` and ${dupedCodes.length - 8} more` : '') +
          '. Each account can appear only once.'
      )
      return
    }
    if (amountErrors.length > 0) {
      setError(amountErrors.slice(0, 5).join(' • '))
      return
    }
    if (matchedRows.length === 0) {
      setError(
        'No rows matched a posting, non-pass-thru, active account in your Chart of Accounts.'
      )
      return
    }

    // Build preview summary. We need account_type to split income vs.
    // expense; pull it from the COA lookup.
    const accountById = new Map((accounts || []).map((a) => [a.id, a]))
    let income = 0
    let expense = 0
    for (const m of matchedRows) {
      const a = accountById.get(m.accountId)
      if (!a) continue
      if (a.account_type === 'income') income += m.amount
      else expense += m.amount
    }

    setPreview({
      matchedCount: matchedRows.length,
      income,
      expense,
    })
    setReadyRows(matchedRows)
    if (unmatchedCodes.length > 0) {
      setWarnings([
        `${unmatchedCodes.length} code(s) not in your Chart of Accounts and will be skipped: ${unmatchedCodes
          .slice(0, 8)
          .join(', ')}${unmatchedCodes.length > 8 ? ` and ${unmatchedCodes.length - 8} more` : ''}.`,
      ])
    }
    setStage('preview')
  }

  async function handleConfirm() {
    if (readyRows.length === 0) return
    setStage('inserting')
    setError(null)
    try {
      await onConfirm(readyRows)
    } catch (e) {
      setError(e.message || String(e))
      setStage('preview')
    }
  }

  function handleDownloadTemplate() {
    downloadCsv(TEMPLATE_FILENAME, TEMPLATE_TEXT)
  }

  // Format helpers for the preview summary.
  const usd = (n) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(n)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/30"
      onClick={() => stage !== 'inserting' && onCancel()}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white border-[0.5px] border-card-border rounded-[10px] max-w-xl w-full p-6 shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="budget-csv-import-title"
      >
        <h3
          id="budget-csv-import-title"
          className="font-display text-navy text-[20px] mb-2 leading-tight"
        >
          Upload prior budget CSV
        </h3>
        <p className="font-body text-muted text-sm mb-4 leading-relaxed">
          Upload your prior year's final budget as a CSV. We'll match by
          account code to the accounts in your Chart of Accounts. Negative
          amounts are allowed for contra-revenue (e.g. tuition discounts).
          {ayeLabel ? ` This will create the first scenario for ${ayeLabel}.` : ''}
        </p>

        {accountsError && (
          <p className="text-status-red text-sm mb-3" role="alert">
            Could not load Chart of Accounts: {accountsError}
          </p>
        )}

        {error && (
          <p className="text-status-red text-sm mb-3" role="alert">
            {error}
          </p>
        )}

        {warnings.length > 0 && (
          <div className="mb-3 px-3 py-2 bg-status-amber-bg border-[0.5px] border-status-amber/30 rounded text-status-amber text-sm">
            {warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </div>
        )}

        {stage === 'pick' && (
          <>
            <label
              htmlFor="budget-csv-file"
              className="block border-[0.5px] border-dashed border-card-border rounded-[8px] px-6 py-8 text-center cursor-pointer hover:bg-cream-highlight transition-colors"
            >
              <span className="font-display text-[14px] text-navy block mb-1">
                Choose a CSV file
              </span>
              <span className="font-body italic text-muted text-xs">
                Required columns: account_code, annual_amount. Optional: notes.
              </span>
            </label>
            <input
              id="budget-csv-file"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFile(f)
                e.target.value = ''  // allow re-pick of the same file
              }}
            />
            <div className="mt-4 text-xs text-muted">
              <button
                type="button"
                onClick={handleDownloadTemplate}
                className="text-status-blue hover:underline"
              >
                Download CSV template
              </button>
            </div>
          </>
        )}

        {stage === 'preview' && preview && (
          <div className="mb-4">
            <p className="font-body text-sm text-body mb-2">
              <span className="font-medium">File:</span> {filename}
            </p>
            <div className="bg-cream-highlight border-[0.5px] border-card-border rounded-[8px] px-4 py-3">
              <p className="font-body text-sm text-navy mb-1">
                Importing <strong>{preview.matchedCount}</strong> budget line(s)
              </p>
              <p className="font-body text-xs text-muted tabular-nums">
                Income total: {usd(preview.income)} · Expense total:{' '}
                {usd(preview.expense)}
              </p>
            </div>
          </div>
        )}

        {stage === 'inserting' && (
          <p className="font-body italic text-muted text-sm mb-4">
            Creating scenario and importing lines…
          </p>
        )}

        <div className="flex items-center justify-between gap-4 pt-3 border-t-[0.5px] border-card-border">
          <button
            type="button"
            onClick={reset}
            disabled={stage === 'pick' || stage === 'inserting'}
            className="font-body text-status-blue text-sm hover:underline disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Choose another file
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={stage === 'inserting'}
              className="font-body text-muted hover:text-navy text-sm disabled:opacity-30"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={stage !== 'preview' || readyRows.length === 0}
              className="bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {stage === 'inserting' ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CsvImportModal
