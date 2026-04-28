// Chart of Accounts CSV import / export logic.
//
// Supported source formats on import:
//
//   1. Generic Agora format — columns: code, subaccount_of, name,
//      account_type, posts_directly, is_pass_thru, is_ed_program_dollars,
//      is_contribution, sort_order, is_active, notes. This is also the
//      format used for export, so round-tripping is supported.
//
//   2. QuickBooks Online (QBO) Account List CSV — columns: `Account #`,
//      `Full name`, `Type`, `Detail type`. Real QBO exports include 2–3
//      metadata rows before the header (e.g., "Account List" / company
//      name / blank). The parser scans the first 20 rows looking for the
//      header pattern; metadata rows are silently discarded.
//
// Type-value normalization for QBO:
//   `Income`           → income
//   `Expense`          → expense
//   `Expenses` (plural)→ expense   (this is what real QBO uses)
//   anything else      → rejected (Bank, A/R, Equity, etc.) with a
//                        budgeting-only message; the user chooses to skip
//                        these rows or cancel and edit the CSV.
//
// Both formats normalize into the same internal row shape before
// validation and insert.
//
// Canonical test artifact: test/fixtures/Libertas_Academy_Account_List.csv
// — preserved for regression testing of the QBO format path.

import { parseCsv, serializeCsv } from './csv'

// ---- Header detection ----------------------------------------------------

// Scan up to the first 20 rows for a recognizable header. Returns the
// row index of the header and the detected format. Metadata rows above
// the header are discarded.
export function findHeaderRow(rawRows) {
  const limit = Math.min(rawRows.length, 20)
  for (let i = 0; i < limit; i++) {
    const cells = rawRows[i].map((c) => String(c).toLowerCase().trim())

    // Generic format marker
    if (cells.includes('subaccount_of')) {
      return { idx: i, format: 'generic' }
    }

    // QBO format marker: minimum signature is `Full name` + `Type`. We
    // tolerate variations in the Account-Number column header (`Account #`,
    // `Account Number`, `Number`) and treat its presence as a confidence
    // booster but not strictly required — some QBO exports lack codes.
    const hasFullName = cells.includes('full name')
    const hasType = cells.includes('type')
    if (hasFullName && hasType) {
      return { idx: i, format: 'quickbooks' }
    }
  }
  return { idx: -1, format: 'unknown' }
}

function buildHeaderIndex(headers) {
  const lowered = headers.map((h) => String(h).toLowerCase().trim())
  const idx = {}
  for (let i = 0; i < lowered.length; i++) idx[lowered[i]] = i
  return idx
}

// ---- Helpers --------------------------------------------------------------

function parseBool(value, defaultVal = false) {
  if (value === null || value === undefined) return defaultVal
  const s = String(value).trim().toLowerCase()
  if (s === '' || s === 'null') return defaultVal
  if (['true', '1', 'yes', 'y', 't'].includes(s)) return true
  if (['false', '0', 'no', 'n', 'f'].includes(s)) return false
  return defaultVal
}

function trimOrNull(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

// QBO Type normalization. Returns 'income' / 'expense' for budget-relevant
// types, or null for balance-sheet accounts (Bank, Equity, etc.) which the
// caller surfaces to the user as rejected rows.
function normalizeQbType(raw) {
  const s = String(raw || '').toLowerCase().trim()
  if (s === 'income') return 'income'
  if (s === 'expense' || s === 'expenses') return 'expense'
  return null
}

// ---- Normalization (raw CSV rows → uniform internal shape) ---------------

function normalizeGeneric(rawRows, headerIdx) {
  const headers = rawRows[headerIdx]
  const idx = buildHeaderIndex(headers)
  const dataRows = rawRows.slice(headerIdx + 1)

  const out = []
  dataRows.forEach((r, i) => {
    const lineNo = headerIdx + 2 + i // +2 because headerIdx is 0-based and the header itself is row headerIdx+1
    const name = (r[idx.name] || '').trim()
    if (!name) return // skip blank rows
    out.push({
      _lineNo: lineNo,
      code: trimOrNull(r[idx.code]),
      subaccount_of: (r[idx.subaccount_of] || '').trim(),
      name,
      account_type: (r[idx.account_type] || '').toLowerCase().trim(),
      posts_directly: parseBool(r[idx.posts_directly], true),
      is_pass_thru: parseBool(r[idx.is_pass_thru], false),
      is_ed_program_dollars: parseBool(r[idx.is_ed_program_dollars], false),
      is_contribution: parseBool(r[idx.is_contribution], false),
      sort_order: parseInt(r[idx.sort_order], 10) || 0,
      is_active: parseBool(r[idx.is_active], true),
      notes: trimOrNull(r[idx.notes]),
    })
  })
  return { rows: out, rejected: [] }
}

function normalizeQuickbooks(rawRows, headerIdx) {
  const headers = rawRows[headerIdx]
  const idx = buildHeaderIndex(headers)
  const dataRows = rawRows.slice(headerIdx + 1)

  const fullNameCol = idx['full name']
  const typeCol = idx['type']
  // Account # variants, in priority order
  const numberCol =
    idx['account #'] !== undefined
      ? idx['account #']
      : idx['account number'] !== undefined
        ? idx['account number']
        : idx['number'] !== undefined
          ? idx['number']
          : idx['code']

  const out = []
  const rejected = []

  dataRows.forEach((r, i) => {
    const lineNo = headerIdx + 2 + i
    const fullName = String(r[fullNameCol] || '').trim()
    if (!fullName) return // skip blanks

    const typeRaw = String(r[typeCol] || '').trim()
    const typeNormalized = normalizeQbType(typeRaw)

    // Last segment is the displayed name (e.g., "Teacher Discount")
    const segments = fullName.split(':').map((s) => s.trim())
    const name = segments[segments.length - 1]
    const subaccount_of = segments.slice(0, -1).join(':')

    if (typeNormalized === null) {
      rejected.push({
        lineNo,
        name,
        fullName,
        type: typeRaw,
        message: `Row ${lineNo}: account "${name}" has type "${typeRaw}" which is a balance-sheet account, not used for budgeting. Agora is a budgeting tool — only Income and Expense accounts should be imported.`,
      })
      return
    }

    out.push({
      _lineNo: lineNo,
      code: numberCol !== undefined ? trimOrNull(r[numberCol]) : null,
      subaccount_of,
      name,
      account_type: typeNormalized,
      posts_directly: true,
      is_pass_thru: false,
      is_ed_program_dollars: false,
      is_contribution: false,
      sort_order: 0,
      is_active: true,
      notes: null,
    })
  })

  return { rows: out, rejected }
}

// ---- Public: full parse + normalize from CSV text ------------------------
//
// Returns `{ format, rows, rejected, error, foundColumns }`.
//   format        : 'generic' | 'quickbooks' | 'unknown'
//   rows          : valid budget-relevant rows ready for validation
//   rejected      : QBO rows whose Type is not Income/Expense; surfaced to
//                   the user with a skip-or-cancel choice
//   error         : null | 'empty-file' | 'unrecognized-format'
//   foundColumns  : when error === 'unrecognized-format', the columns from
//                   the first non-empty row of the file (for the error
//                   display)

export function parseAndNormalize(text) {
  const raw = parseCsv(text)
  if (raw.length === 0) {
    return {
      format: 'unknown',
      rows: [],
      rejected: [],
      error: 'empty-file',
      foundColumns: [],
    }
  }

  const headerInfo = findHeaderRow(raw)

  if (headerInfo.format === 'unknown') {
    const firstNonEmpty = raw.find((r) => r.some((c) => String(c).trim()))
    const foundColumns = firstNonEmpty
      ? firstNonEmpty
          .map((c) => String(c).trim())
          .filter((c) => c !== '')
      : []
    return {
      format: 'unknown',
      rows: [],
      rejected: [],
      error: 'unrecognized-format',
      foundColumns,
    }
  }

  const result =
    headerInfo.format === 'generic'
      ? normalizeGeneric(raw, headerInfo.idx)
      : normalizeQuickbooks(raw, headerInfo.idx)

  return {
    format: headerInfo.format,
    rows: result.rows,
    rejected: result.rejected,
    error: null,
    foundColumns: [],
  }
}

// ---- Validation ----------------------------------------------------------

export function validateRows(rows) {
  const errors = []
  const warnings = []

  // Build full-path map: "A:B:C" → row, where the path is the row's full
  // identity (ancestors + own name). Two rows can share a name as long as
  // their full paths differ.
  const pathMap = new Map()
  rows.forEach((r) => {
    const lineNo = r._lineNo
    if (!r.name) {
      errors.push(`Row ${lineNo}: missing name.`)
      return
    }
    if (r.account_type !== 'income' && r.account_type !== 'expense') {
      errors.push(
        `Row ${lineNo}: invalid account_type "${r.account_type}" (must be 'income' or 'expense').`
      )
    }
    const fullPath = r.subaccount_of ? `${r.subaccount_of}:${r.name}` : r.name
    if (pathMap.has(fullPath)) {
      errors.push(
        `Row ${lineNo}: duplicate path "${fullPath}" (each account must have a unique full path).`
      )
    } else {
      pathMap.set(fullPath, { row: r, lineNo })
    }
  })

  // Duplicate non-blank codes
  const codeMap = new Map()
  rows.forEach((r) => {
    if (!r.code) return
    const arr = codeMap.get(r.code) || []
    arr.push(r._lineNo)
    codeMap.set(r.code, arr)
  })
  for (const [code, lines] of codeMap.entries()) {
    if (lines.length > 1) {
      errors.push(
        `Code "${code}" appears in rows ${lines.join(', ')}. Each account code must be unique.`
      )
    }
  }
  // Warn on blank codes (non-blocking)
  const blankCount = rows.filter((r) => !r.code).length
  if (blankCount > 0) {
    warnings.push(
      `${blankCount} account${blankCount === 1 ? '' : 's'} ${blankCount === 1 ? 'has' : 'have'} no code. This is allowed; codes are optional.`
    )
  }

  // Path resolution + type consistency + cycle detection
  rows.forEach((r) => {
    const lineNo = r._lineNo
    if (!r.subaccount_of) return

    const ancestors = r.subaccount_of.split(':').map((s) => s.trim())

    // Cycle: own name in path
    if (ancestors.includes(r.name)) {
      errors.push(
        `Row ${lineNo}: account "${r.name}" appears in its own subaccount path (would create a loop).`
      )
      return
    }

    // Path resolution: each ancestor segment must exist as a row, building
    // the path incrementally to ensure each level is in the file.
    let walking = ''
    for (let j = 0; j < ancestors.length; j++) {
      walking = j === 0 ? ancestors[0] : `${walking}:${ancestors[j]}`
      const entry = pathMap.get(walking)
      if (!entry) {
        errors.push(
          `Row ${lineNo}: subaccount path references "${walking}" but no account with that path is in the file.`
        )
        return
      }
      if (entry.row.account_type !== r.account_type) {
        errors.push(
          `Row ${lineNo}: account "${r.name}" is ${r.account_type} but its primary "${walking}" is ${entry.row.account_type}. Subaccounts must match their primary's type.`
        )
        return
      }
    }
  })

  return { errors, warnings }
}

// ---- Export --------------------------------------------------------------

export const EXPORT_HEADERS = [
  'code',
  'subaccount_of',
  'name',
  'account_type',
  'posts_directly',
  'is_pass_thru',
  'is_ed_program_dollars',
  'is_contribution',
  'sort_order',
  'is_active',
  'notes',
]

export function generateExportCsv(accounts) {
  const byId = new Map()
  for (const a of accounts) byId.set(a.id, a)

  function pathFor(account) {
    const parts = []
    let cur = account.parent_id ? byId.get(account.parent_id) : null
    let safety = 0
    while (cur && safety < 50) {
      parts.unshift(cur.name)
      cur = cur.parent_id ? byId.get(cur.parent_id) : null
      safety += 1
    }
    return parts.join(':')
  }

  // Sort: depth ascending, then sort_order, then name. Ensures primaries
  // appear before subaccounts in the file (re-import friendly).
  const sorted = [...accounts].sort((a, b) => {
    const aPath = pathFor(a)
    const bPath = pathFor(b)
    const aDepth = aPath ? aPath.split(':').length : 0
    const bDepth = bPath ? bPath.split(':').length : 0
    if (aDepth !== bDepth) return aDepth - bDepth
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.name.localeCompare(b.name)
  })

  const rows = [EXPORT_HEADERS]
  for (const a of sorted) {
    rows.push([
      a.code || '',
      pathFor(a),
      a.name,
      a.account_type,
      String(a.posts_directly),
      String(a.is_pass_thru),
      String(a.is_ed_program_dollars),
      String(a.is_contribution),
      String(a.sort_order || 0),
      String(a.is_active),
      a.notes || '',
    ])
  }

  return serializeCsv(rows)
}

export function generateExportFilename(schoolSlug = 'libertas_academy') {
  const today = new Date().toISOString().slice(0, 10)
  return `coa_${schoolSlug}_${today}.csv`
}

// Generic-format example CSV with obviously-fake codes so users don't
// accidentally import the template as-is. Five rows demonstrating: top-level
// income, posting subaccount, summary subaccount, leaf posting under summary,
// and a top-level expense.
export function generateTemplateCsv() {
  const rows = [
    EXPORT_HEADERS,
    [
      'EXAMPLE_1000', '', 'Example Income Category', 'income',
      'false', 'false', 'false', 'false', '0', 'true',
      'Replace with a real top-level income account',
    ],
    [
      'EXAMPLE_1100', 'Example Income Category', 'Example Posting Subaccount', 'income',
      'true', 'false', 'true', 'false', '0', 'true',
      'Replace with a real posting subaccount (money posts here)',
    ],
    [
      'EXAMPLE_1190', 'Example Income Category', 'Example Summary Subaccount', 'income',
      'false', 'false', 'false', 'false', '1', 'true',
      'Replace with a real summary subaccount (rolls up its subaccounts)',
    ],
    [
      'EXAMPLE_1191', 'Example Income Category:Example Summary Subaccount', 'Example Leaf Posting', 'income',
      'true', 'false', 'true', 'false', '0', 'true',
      'Replace with a real posting subaccount under a summary',
    ],
    [
      'EXAMPLE_2000', '', 'Example Expense Category', 'expense',
      'false', 'false', 'false', 'false', '0', 'true',
      'Replace with a real top-level expense account',
    ],
  ]
  return serializeCsv(rows)
}

// ---- Import (writes to DB) ------------------------------------------------
//
// Best-effort transactional behavior. If any insert fails partway, rolls
// back already-inserted rows by id. Replace mode performs the wipe BEFORE
// any inserts, so a mid-flight insert failure leaves the COA empty (the
// user has the auto-downloaded backup CSV to restore from).

export async function runImport({
  rows,
  mode,
  existingAccounts,
  supabase,
  userId,
}) {
  // Pre-flight: collision check for append mode
  if (mode === 'append') {
    const existingCodes = new Set(
      existingAccounts.filter((a) => a.code).map((a) => a.code)
    )
    const collisions = rows
      .filter((r) => r.code && existingCodes.has(r.code))
      .map((r) => r.code)
    if (collisions.length > 0) {
      throw new Error(
        `Code(s) already exist in the COA: ${collisions.join(', ')}. Choose Replace mode, or remove these accounts from the CSV.`
      )
    }

    // Also check for full-path collisions (top-level name conflicts even if
    // codes differ)
    const existingPaths = new Set()
    const byId = new Map()
    for (const a of existingAccounts) byId.set(a.id, a)
    for (const a of existingAccounts) {
      const parts = []
      let cur = a
      let safety = 0
      while (cur && safety < 50) {
        parts.unshift(cur.name)
        cur = cur.parent_id ? byId.get(cur.parent_id) : null
        safety += 1
      }
      existingPaths.add(parts.join(':'))
    }
    const pathCollisions = rows
      .map((r) => (r.subaccount_of ? `${r.subaccount_of}:${r.name}` : r.name))
      .filter((p) => existingPaths.has(p))
    if (pathCollisions.length > 0) {
      throw new Error(
        `Account path(s) already exist in the COA: ${pathCollisions.slice(0, 5).join('; ')}${pathCollisions.length > 5 ? `; (and ${pathCollisions.length - 5} more)` : ''}. Choose Replace mode, or remove these from the CSV.`
      )
    }
  }

  // Replace mode: wipe first
  if (mode === 'replace') {
    const { error: delErr } = await supabase
      .from('chart_of_accounts')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')
    if (delErr) {
      throw new Error(`Could not delete existing accounts: ${delErr.message}`)
    }
  }

  // Sort rows by depth so primaries are inserted before their subaccounts
  const sorted = [...rows].sort((a, b) => {
    const aDepth = a.subaccount_of ? a.subaccount_of.split(':').length : 0
    const bDepth = b.subaccount_of ? b.subaccount_of.split(':').length : 0
    return aDepth - bDepth
  })

  const pathToId = new Map()
  const insertedIds = []

  // For append mode, seed pathToId with existing accounts so imports can
  // reference them as primaries (rare, but valid: e.g., a CSV with new
  // subaccounts under an existing parent).
  if (mode === 'append') {
    const byId = new Map()
    for (const a of existingAccounts) byId.set(a.id, a)
    for (const a of existingAccounts) {
      const parts = []
      let cur = a
      let safety = 0
      while (cur && safety < 50) {
        parts.unshift(cur.name)
        cur = cur.parent_id ? byId.get(cur.parent_id) : null
        safety += 1
      }
      pathToId.set(parts.join(':'), a.id)
    }
  }

  try {
    for (const r of sorted) {
      let parent_id = null
      if (r.subaccount_of) {
        parent_id = pathToId.get(r.subaccount_of) || null
        if (!parent_id) {
          throw new Error(
            `Could not resolve primary "${r.subaccount_of}" for "${r.name}". (Validation should have caught this; please report.)`
          )
        }
      }

      const { data, error } = await supabase
        .from('chart_of_accounts')
        .insert({
          parent_id,
          code: r.code,
          name: r.name,
          account_type: r.account_type,
          posts_directly: r.posts_directly,
          is_pass_thru: r.is_pass_thru,
          is_ed_program_dollars: r.is_ed_program_dollars,
          is_contribution: r.is_contribution,
          sort_order: r.sort_order,
          is_active: r.is_active,
          notes: r.notes,
          created_by: userId,
          updated_by: userId,
        })
        .select('id')
        .single()

      if (error) {
        throw new Error(`Failed to insert "${r.name}": ${error.message}`)
      }

      const myPath = r.subaccount_of ? `${r.subaccount_of}:${r.name}` : r.name
      pathToId.set(myPath, data.id)
      insertedIds.push(data.id)
    }
  } catch (err) {
    // Rollback: best-effort delete of inserted rows
    if (insertedIds.length > 0) {
      await supabase
        .from('chart_of_accounts')
        .delete()
        .in('id', insertedIds)
    }
    throw err
  }

  return { insertedCount: insertedIds.length, insertedIds }
}
