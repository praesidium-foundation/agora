// Tuition import — XLSX template generator.
//
// v3.8.18 (Tuition-B2-import). Produces a multi-tab XLSX workbook
// for download via the upload modal:
//
//   Sheet 1: "Instructions" — readable reference content with
//            step-by-step usage, column descriptions, important
//            rules, and reference values pulled live from the
//            active scenario (tier rates, fees).
//
//   Sheet 2: "Family Data" — empty data tab with formatted column
//            headers in row 1. Operators paste their family list
//            here.
//
// Filename convention:
//   Libertas_Agora_AYE_{year}_Tuition_Audit_Import_Template.xlsx
//
// The generated workbook is browser-side only (no server roundtrip).
// SheetJS's `write` function returns a Buffer-like array which we
// convert to a Blob for the download link.

import * as XLSX from 'xlsx'
import { formatCurrency } from './format'

// Display column names used as header row in the "Family Data" tab
// AND keyed in the parser's HEADER_MAP. Keep the two in sync.
const FAMILY_DATA_COLUMNS = [
  'Family Name',
  '# Enrolled',
  'Faculty',
  'Date Enrolled',
  'Date Withdrawn',
  'Faculty Discount',
  'Other Discount',
  'Financial Aid',
  'Notes',
]

// Build the Instructions sheet content. Returns an array-of-arrays
// (AOA) which SheetJS converts to a worksheet via aoa_to_sheet.
function buildInstructionsAOA(scenario, ayeLabel) {
  const rates = Array.isArray(scenario?.tier_rates) ? [...scenario.tier_rates] : []
  rates.sort((a, b) => (Number(a.tier_size) || 0) - (Number(b.tier_size) || 0))

  const baseRow = rates.find((r) => Number(r.tier_size) === 1)
  const baseRate = baseRow ? Number(baseRow.per_student_rate) || 0 : 0

  const rateRows = rates.map((r) => {
    const tierSize = Number(r.tier_size)
    const rate = Number(r.per_student_rate) || 0
    const label = tierSize === 1
      ? 'Base (1 student)'
      : `${tierSize}${tierSize >= 4 ? '+' : ''} students`
    return [label, formatCurrency(rate)]
  })

  const aoa = [
    ['Libertas Agora — Tuition Audit Import Template'],
    [`AYE: ${ayeLabel || '(not specified)'}`],
    [],
    ['How to use this template'],
    ['Step 1', 'Read these instructions.'],
    ['Step 2', 'Fill out the "Family Data" tab with your enrolled families, one row per family.'],
    ['Step 3', 'Save the file. You can save as XLSX or CSV — both formats are accepted.'],
    ['Step 4', 'Upload via the "+ Import CSV" button on the Tuition Audit page.'],
    ['Step 5', 'Review the parsed data in the staging window before accepting.'],
    [],
    ['Column descriptions'],
    ['Column Name', 'Required?', 'Description', 'Example'],
    ['Family Name', 'Required', 'Last name, with disambiguator in parentheses if multiple families share a last name.', 'Smith / Smith (Junior) / Davis (Walczak)'],
    ['# Enrolled', 'Required', 'Number of children from this family enrolled this year.', '1 / 2 / 3 / 4'],
    ['Faculty', 'Optional', 'Mark "Yes" if this family qualifies for the faculty discount; otherwise leave blank.', 'Yes / (blank)'],
    ['Date Enrolled', 'Optional', 'Date the family’s children began attending. Blank means "enrolled at start of school year."', '9/3/2025 / 2025-09-03'],
    ['Date Withdrawn', 'Optional', 'Date the family withdrew, if applicable. Blank means still enrolled.', '(blank) / 1/15/2026'],
    ['Faculty Discount', 'Optional', 'Faculty discount amount. Auto-calculates for faculty families if left blank.', '(blank) / 6720'],
    ['Other Discount', 'Optional', 'Other discretionary discount amount.', '(blank) / 500'],
    ['Financial Aid', 'Optional', 'Financial aid amount.', '(blank) / 1000'],
    ['Notes', 'Optional', 'Audit-trail context for this family’s specific situation.', '"Board awarded discount of $500 on 6/2/25"'],
    [],
    ['Important rules'],
    ['', 'All discount amounts are entered as POSITIVE numbers. The system displays them as negative on the page (parens convention).'],
    ['', 'The Faculty rule: faculty families pay base_rate × students × (1 − faculty_discount_pct). Multi-student tier discount does NOT apply on top.'],
    ['', 'Dates can be in MM/DD/YYYY, MM/DD/YY, or YYYY-MM-DD format.'],
    ['', 'Faculty column accepts: Yes, Y, TRUE, 1 (case insensitive). Leave blank for non-faculty families.'],
    [],
    ['After upload'],
    ['', 'The system parses your file and shows the staged rows for review.'],
    ['', 'Each row is checked for errors (red) and warnings (amber).'],
    ['', 'You choose at acceptance whether to APPEND to existing families or REPLACE all existing families.'],
    ['', 'REPLACE permanently deletes all current family rows; use carefully.'],
    [],
    [`Reference values for AYE ${ayeLabel || ''}`],
    ['Tier rate', 'Per student'],
  ]

  // Append tier rate rows.
  for (const r of rateRows) aoa.push(r)

  aoa.push([])
  aoa.push(['Faculty discount', `${Number(scenario?.faculty_discount_pct) || 0}% off base rate`])
  aoa.push(['Curriculum fee', `${formatCurrency(Number(scenario?.curriculum_fee_per_student) || 0)} per student`])
  aoa.push(['B&A care rate', `${formatCurrency(Number(scenario?.before_after_school_hourly_rate) || 0)} per hour`])
  aoa.push([])
  aoa.push(['', `Faculty discount calculation example: ${formatCurrency(baseRate)} × students × ${Number(scenario?.faculty_discount_pct) || 0}% = the auto-populated faculty discount amount.`])

  return aoa
}

// Apply formatting to specific cells in the Instructions sheet.
// SheetJS supports cell styles in the community version via the
// "s" property on each cell, but format/style support is partial.
// Here we apply minimum formatting: bold on title rows, larger
// font on the title, italic on the example sentences. Width tweaks
// via "!cols".
function styleInstructionsSheet(ws) {
  const cols = [
    { wch: 22 }, // Column A — labels / step / column name
    { wch: 14 }, // Column B — required?
    { wch: 70 }, // Column C — description
    { wch: 30 }, // Column D — example
  ]
  ws['!cols'] = cols

  // Bold the section header rows (rows 1, 4, 11, 23, 30, 36 by
  // 1-indexed AOA position; SheetJS's A1 references are 1-indexed).
  // SheetJS-CE doesn't render styles in some viewers — this is
  // best-effort visual hierarchy; the content is the primary signal.
  const titleRows = [1, 4, 11, 23, 30, 36]
  for (const r of titleRows) {
    const cell = ws[`A${r}`]
    if (cell) {
      cell.s = {
        font: { bold: true, sz: r === 1 ? 14 : 12 },
      }
    }
  }
}

// Build the Family Data sheet content. Single header row; otherwise
// empty. Operators fill rows below.
function buildFamilyDataAOA() {
  return [FAMILY_DATA_COLUMNS]
}

function styleFamilyDataSheet(ws) {
  const cols = [
    { wch: 28 }, // Family Name
    { wch: 12 }, // # Enrolled
    { wch: 10 }, // Faculty
    { wch: 14 }, // Date Enrolled
    { wch: 14 }, // Date Withdrawn
    { wch: 16 }, // Faculty Discount
    { wch: 14 }, // Other Discount
    { wch: 14 }, // Financial Aid
    { wch: 50 }, // Notes
  ]
  ws['!cols'] = cols

  // Bold + navy fill on the header row.
  for (let i = 0; i < FAMILY_DATA_COLUMNS.length; i++) {
    const colLetter = String.fromCharCode(65 + i)  // A, B, C, ...
    const cell = ws[`${colLetter}1`]
    if (cell) {
      cell.s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '192A4F' }, patternType: 'solid' },
        alignment: { horizontal: 'center', vertical: 'center' },
      }
    }
  }

  // Freeze the header row.
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }
}

// Public entry point. Builds the workbook and triggers a browser
// download via SheetJS's writeFile equivalent (writeArrayBuffer +
// Blob URL).
//
// scenario:  the active Stage 2 scenario row (for reference values
//            in the Instructions tab)
// ayeLabel:  e.g. "AYE 2026"
export function downloadTuitionImportTemplate(scenario, ayeLabel) {
  const wb = XLSX.utils.book_new()

  const instructionsWs = XLSX.utils.aoa_to_sheet(buildInstructionsAOA(scenario, ayeLabel))
  styleInstructionsSheet(instructionsWs)
  XLSX.utils.book_append_sheet(wb, instructionsWs, 'Instructions')

  const familyDataWs = XLSX.utils.aoa_to_sheet(buildFamilyDataAOA())
  styleFamilyDataSheet(familyDataWs)
  XLSX.utils.book_append_sheet(wb, familyDataWs, 'Family Data')

  // Filename: AYE label sanitized to underscores.
  const ayeSafe = (ayeLabel || 'current')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
  const filename = `Libertas_Agora_${ayeSafe}_Tuition_Audit_Import_Template.xlsx`

  // SheetJS recommends `writeFile` with a string filename in browser
  // contexts — it triggers a download via a Blob URL internally.
  XLSX.writeFile(wb, filename, { compression: true })
}

// Parse an uploaded file (XLSX or CSV) and return the rows from the
// "Family Data" sheet (or the first non-empty sheet if the user
// renamed it). Returns:
//   { rows: [{<headerName>: cellValue, ...}, ...], format: 'csv' | 'xlsx' }
// or { error: '...' } on parse failure.
//
// Accepts a File object (from a <input type="file"> change event).
export async function parseUploadedFile(file) {
  if (!file) return { error: 'No file provided.' }
  const lowerName = file.name.toLowerCase()
  const format = lowerName.endsWith('.csv') ? 'csv' : (lowerName.endsWith('.xlsx') ? 'xlsx' : null)
  if (format == null) {
    return { error: 'Unsupported file format. Please upload an XLSX or CSV file.' }
  }

  let buffer
  try {
    buffer = await file.arrayBuffer()
  } catch (e) {
    return { error: `Could not read file: ${e.message || String(e)}` }
  }

  let wb
  try {
    wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  } catch (e) {
    return { error: `Could not parse ${format.toUpperCase()} file: ${e.message || String(e)}` }
  }

  // Prefer "Family Data" tab; otherwise the first sheet that has
  // any data after the header.
  let sheetName = null
  if (wb.SheetNames.includes('Family Data')) {
    sheetName = 'Family Data'
  } else if (wb.SheetNames.length > 0) {
    sheetName = wb.SheetNames[0]
  }
  if (!sheetName) {
    return { error: 'The uploaded workbook contains no sheets.' }
  }

  const ws = wb.Sheets[sheetName]
  // sheet_to_json with header:1 returns AOA; with default returns
  // array-of-objects keyed by the header row. We use the default
  // here so downstream code can map columns by display name.
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true })

  // Filter out completely empty rows (operator may have left
  // trailing blank rows in the spreadsheet).
  const nonEmpty = rows.filter((r) => {
    if (!r || typeof r !== 'object') return false
    return Object.values(r).some((v) => v != null && String(v).trim() !== '')
  })

  return { rows: nonEmpty, format, sheetName }
}
