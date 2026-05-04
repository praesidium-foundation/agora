// Tuition import — client-side parsing helpers.
//
// v3.8.18 (Tuition-B2-import). The XLSX/CSV upload path produces an
// array of raw row objects keyed by column name. Each row passes
// through `normalizeRow` which:
//   - Maps display column names → snake_case schema column names
//   - Parses dates with format-fallback (MM/DD/YYYY, M/D/YY, ISO)
//   - Parses currency strings (strict positive; warns on parens or
//     leading minus)
//   - Parses booleans liberally (Yes/Y/TRUE/1; empty = false)
//
// Defense in depth: normalizeRow surfaces parse errors / warnings
// inline on each row, but the SECURITY DEFINER RPC
// (create_tuition_audit_import_batch) re-validates server-side.
// Client-side validation here is for UX (immediate feedback in the
// upload preview before the operator clicks "Stage Import"); server-
// side is the trust boundary.
//
// Returns shape per row:
//   {
//     normalized: { family_label, students_enrolled, ... },
//     errors:     [{ field, message }, ...],
//     warnings:   [{ field, message }, ...]
//   }
//
// The wrapper `parseSpreadsheetRows(rawRows)` runs `normalizeRow`
// over every input row and returns `{ rows, totalErrors, totalWarnings }`.

// Display-name → schema-column-name map. The XLSX template uses
// the display names; CSV save-as preserves them. Header detection
// is case-insensitive and tolerant of whitespace / punctuation.
const HEADER_MAP = {
  'family name':              'family_label',
  '# enrolled':               'students_enrolled',
  'enrolled':                 'students_enrolled',
  '# enr.':                   'students_enrolled',
  'students':                 'students_enrolled',
  'faculty':                  'is_faculty_family',
  'is faculty':               'is_faculty_family',
  'date enrolled':            'date_enrolled',
  'enrolled date':            'date_enrolled',
  'date withdrawn':           'date_withdrawn',
  'withdrawn date':           'date_withdrawn',
  'faculty discount':         'faculty_discount_amount',
  'faculty disc.':            'faculty_discount_amount',
  'other discount':           'other_discount_amount',
  'other disc.':              'other_discount_amount',
  'financial aid':            'financial_aid_amount',
  'financial aid amount':     'financial_aid_amount',
  'fa':                       'financial_aid_amount',
  'notes':                    'notes',
}

function canonicalHeader(name) {
  if (typeof name !== 'string') return null
  return name
    .toLowerCase()
    .replace(/[^\w\s%/+#.-]/g, '')   // strip odd punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

// Map a raw row (keyed by display column name) to a row keyed by
// schema column name. Unknown columns are dropped (with optional
// warning preserved on a private __unknown_columns key for the
// initial upload preview).
function mapHeaders(rawRow) {
  const mapped = {}
  const unknownColumns = []
  for (const [key, value] of Object.entries(rawRow)) {
    const canon = canonicalHeader(key)
    const schemaKey = HEADER_MAP[canon]
    if (schemaKey) {
      mapped[schemaKey] = value
    } else if (canon) {
      unknownColumns.push(key)
    }
  }
  if (unknownColumns.length > 0) {
    mapped.__unknown_columns = unknownColumns
  }
  return mapped
}

// ---- Date parsing -----------------------------------------------------
//
// Accepts (in priority order):
//   YYYY-MM-DD               (ISO)
//   MM/DD/YYYY  M/D/YYYY     (US long)
//   MM/DD/YY    M/D/YY       (US short, 20YY)
//   YYYY/MM/DD               (ISO with slashes — defensive)
//
// Excel may also pass through Date objects directly (when the cell
// is formatted as a date). SheetJS's `cellDates: true` option
// produces JS Date instances; we accept those too.
//
// Returns ISO date string ('YYYY-MM-DD') on success, or
// { error: '...' } on failure.

function parseDate(raw) {
  if (raw == null || raw === '') return null
  // Already a Date object (from SheetJS cellDates: true).
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      return { error: `Could not parse date: ${raw}` }
    }
    return formatISO(raw)
  }
  const s = String(raw).trim()
  if (s === '') return null

  // ISO YYYY-MM-DD
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return makeISO(m[1], m[2], m[3])

  // ISO YYYY/MM/DD (defensive)
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s)
  if (m) return makeISO(m[1], m[2], m[3])

  // US MM/DD/YYYY
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (m) return makeISO(m[3], m[1], m[2])

  // US MM/DD/YY  (20YY)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(s)
  if (m) return makeISO('20' + m[3], m[1], m[2])

  return { error: `Could not parse date "${raw}". Accepted formats: MM/DD/YYYY, M/D/YY, YYYY-MM-DD.` }
}

function makeISO(yyyy, mm, dd) {
  const y = Number(yyyy), m = Number(mm), d = Number(dd)
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return { error: 'Date components must be integers.' }
  }
  if (m < 1 || m > 12) return { error: `Month ${m} is out of range.` }
  if (d < 1 || d > 31) return { error: `Day ${d} is out of range.` }
  // Defensive: build a Date and re-check (catches Feb 30 etc.)
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return { error: `Date ${m}/${d}/${y} is not a valid calendar date.` }
  }
  return formatISO(dt)
}

function formatISO(dt) {
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const d = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// ---- Currency parsing -------------------------------------------------
//
// Strict positive integer. Strips '$', commas, whitespace. Rejects
// parens, leading minus, and explicit negative formats — the parens
// convention is a DISPLAY affordance only; storage is positive.
//
// Returns:
//   number on success
//   null   on empty input
//   { error: '...' }   on hard failure (non-numeric content)
//   { warning: '...', value: number }   on soft failure (negative
//                                        format detected; value
//                                        coerced to absolute, warning
//                                        surfaced)

function parseCurrency(raw) {
  if (raw == null || raw === '') return null
  let s = String(raw).trim()
  if (s === '') return null

  // SheetJS may pass through native number cells.
  if (typeof raw === 'number') {
    if (raw < 0) {
      return {
        warning: 'Discount amounts must be entered as positive numbers; the system displays them as negative on the page.',
        value: Math.abs(raw),
      }
    }
    return raw
  }

  let negativeFormat = false
  // Detect parens: ($1,234.56)
  if (/^\(.*\)$/.test(s)) {
    negativeFormat = true
    s = s.slice(1, -1).trim()
  }
  // Detect leading minus.
  if (s.startsWith('-')) {
    negativeFormat = true
    s = s.slice(1).trim()
  }

  // Strip $, commas, whitespace.
  s = s.replace(/[$,\s]/g, '')
  if (s === '') return null

  const n = Number(s)
  if (!Number.isFinite(n)) {
    return { error: `Could not parse currency value "${raw}".` }
  }
  if (n < 0) {
    return {
      warning: 'Discount amounts must be entered as positive numbers; the system displays them as negative on the page.',
      value: Math.abs(n),
    }
  }
  if (negativeFormat) {
    return {
      warning: 'Discount amounts should be entered as positive numbers; the system displays them as negative on the page. Treated as positive.',
      value: n,
    }
  }
  return n
}

// ---- Integer parsing --------------------------------------------------

function parseInteger(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') {
    if (Number.isInteger(raw)) return raw
    return { error: `Could not parse "${raw}" as a whole number.` }
  }
  const s = String(raw).trim()
  if (s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { error: `Could not parse "${raw}" as a whole number.` }
  }
  return n
}

// ---- Boolean parsing --------------------------------------------------
//
// Liberal: TRUE/FALSE, true/false, 1/0, Y/N, Yes/No, T/F.
// Empty cell → false (non-faculty default).
// Anything else → parse error.

const TRUE_VALUES = new Set(['true', 't', 'yes', 'y', '1'])
const FALSE_VALUES = new Set(['false', 'f', 'no', 'n', '0'])

function parseBoolean(raw) {
  if (raw == null || raw === '') return false
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') {
    if (raw === 0) return false
    if (raw === 1) return true
    return { error: `Boolean column "${raw}" must be Yes/Y/TRUE/1 or empty.` }
  }
  const s = String(raw).toLowerCase().trim()
  if (s === '') return false
  if (TRUE_VALUES.has(s)) return true
  if (FALSE_VALUES.has(s)) return false
  return { error: `Boolean column "${raw}" must be Yes/Y/TRUE/1 or empty.` }
}

// ---- Per-row normalizer -----------------------------------------------

export function normalizeRow(rawRow, rowIndex) {
  const errors = []
  const warnings = []
  const mapped = mapHeaders(rawRow)

  // Surface unknown columns once per upload (the upload modal shows
  // them as a soft warning so operators understand which columns
  // were ignored).
  if (Array.isArray(mapped.__unknown_columns) && mapped.__unknown_columns.length > 0) {
    warnings.push({
      field: '__row__',
      message: `Unknown columns ignored: ${mapped.__unknown_columns.join(', ')}.`,
    })
  }

  const out = {
    family_label: null,
    students_enrolled: null,
    is_faculty_family: false,
    date_enrolled: null,
    date_withdrawn: null,
    faculty_discount_amount: null,
    other_discount_amount: null,
    financial_aid_amount: null,
    notes: null,
  }

  // Family label.
  if (mapped.family_label != null) {
    const label = String(mapped.family_label).trim()
    if (label.length > 0) {
      if (label.length > 200) {
        errors.push({ field: 'family_label', message: 'Family Name is longer than 200 characters; please shorten.' })
      } else {
        out.family_label = label
      }
    }
  }

  // Students enrolled.
  const enrolledResult = parseInteger(mapped.students_enrolled)
  if (enrolledResult != null && typeof enrolledResult === 'object' && 'error' in enrolledResult) {
    errors.push({ field: 'students_enrolled', message: enrolledResult.error })
  } else {
    out.students_enrolled = enrolledResult
  }

  // Faculty boolean.
  const facultyResult = parseBoolean(mapped.is_faculty_family)
  if (facultyResult != null && typeof facultyResult === 'object' && 'error' in facultyResult) {
    errors.push({ field: 'is_faculty_family', message: facultyResult.error })
  } else {
    out.is_faculty_family = facultyResult
  }

  // Dates.
  for (const f of ['date_enrolled', 'date_withdrawn']) {
    const r = parseDate(mapped[f])
    if (r != null && typeof r === 'object' && 'error' in r) {
      errors.push({ field: f, message: r.error })
    } else {
      out[f] = r
    }
  }

  // Currencies.
  for (const f of ['faculty_discount_amount', 'other_discount_amount', 'financial_aid_amount']) {
    const r = parseCurrency(mapped[f])
    if (r != null && typeof r === 'object') {
      if ('error' in r) {
        errors.push({ field: f, message: r.error })
      } else if ('warning' in r) {
        warnings.push({ field: f, message: r.message || r.warning })
        out[f] = r.value
      }
    } else {
      out[f] = r
    }
  }

  // Notes.
  if (mapped.notes != null) {
    const notes = String(mapped.notes).trim()
    if (notes.length > 0) out.notes = notes
  }

  return {
    rowIndex: rowIndex + 1,  // 1-indexed for operator-facing display
    normalized: out,
    errors,
    warnings,
    raw_row: rawRow,
  }
}

// Top-level wrapper. Pass the rawRows array (from the XLSX/CSV
// parser) and receive the normalized + validated package the
// upload modal posts to create_tuition_audit_import_batch.
export function parseSpreadsheetRows(rawRows) {
  if (!Array.isArray(rawRows)) {
    return { rows: [], totalErrors: 0, totalWarnings: 0 }
  }
  const rows = rawRows.map((r, i) => normalizeRow(r, i))
  let totalErrors = 0
  let totalWarnings = 0
  for (const r of rows) {
    totalErrors += r.errors.length
    totalWarnings += r.warnings.length
  }
  return { rows, totalErrors, totalWarnings }
}
