// Minimal CSV parser / serializer. No dependencies. Handles:
//   - UTF-8 BOM (stripped on parse, prepended on serialize for Excel)
//   - Quoted fields with embedded commas, newlines, and escaped quotes ("")
//   - CRLF and LF line endings
//   - Trailing blank lines (ignored)
//
// This is small on purpose — Papa Parse would do the same job, but the
// project policy is no new dependencies. If parser quirks cause real
// problems we can swap to a library later.

const BOM = '﻿'

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false
  let i = 0

  function pushCell() {
    row.push(cell)
    cell = ''
  }
  function pushRow() {
    pushCell()
    // Skip purely-empty rows (e.g., trailing blank line)
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }

  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      cell += c
      i += 1
      continue
    }
    if (c === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (c === ',') {
      pushCell()
      i += 1
      continue
    }
    if (c === '\r' || c === '\n') {
      pushRow()
      // Consume CRLF as one line ending
      if (c === '\r' && text[i + 1] === '\n') i += 2
      else i += 1
      continue
    }
    cell += c
    i += 1
  }
  // Final row (no trailing newline)
  if (cell.length > 0 || row.length > 0) pushRow()

  return rows
}

function escapeCell(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export function serializeCsv(rows, { withBom = true } = {}) {
  const body = rows.map((r) => r.map(escapeCell).join(',')).join('\r\n')
  return (withBom ? BOM : '') + body + '\r\n'
}

// Trigger a browser download of CSV content.
export function downloadCsv(filename, csvString) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Defer revoke so the click has time to register the download
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
