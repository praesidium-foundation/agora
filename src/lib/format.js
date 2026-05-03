// Currency formatting with the universal accounting parentheses
// convention (architecture §10.4, v3.8.4 addendum).
//
// Subtractive currency values — discounts, losses, negative revenue —
// render with parentheses rather than negative signs throughout the
// application: ($53,655) for a discount, never -$53,655.
//
// Two ways a value can render with parens:
//   1. The caller passes options.subtractive = true. Always parens.
//      Used for known-subtractive contexts: discount values, Total
//      Projected Discounts subtotals, sidebar discount stats. The
//      magnitude renders inside parens regardless of sign — a
//      negative discount (rare; would indicate a data error) still
//      renders as parens around the absolute value.
//   2. The value is itself negative. Parens applied automatically.
//      Used for non-subtractive currency that may legitimately go
//      negative (e.g., Net Projected Ed Program Revenue if expenses
//      exceed revenue).
//
// Null / undefined / non-finite values render the em-dash sentinel
// "—" so callers do not need to guard before calling.
//
// Precision: 0-decimal by default. precision=2 for fields where the
// cents are meaningful (e.g., the B&A hourly rate at $10.00).
//
// The "-" character is never rendered for currency values; parens
// replace it universally. This is standard accounting convention and
// matches the visual language of the Tuition Committee's existing
// spreadsheets.

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatCurrency(value, options = {}) {
  const { subtractive = false, precision = 0 } = options

  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'

  const formatter = precision === 2 ? usd2 : usd0
  // Always feed the formatter a positive magnitude. Parens treatment
  // happens here, not via the locale's negative-currency-pattern.
  const formatted = formatter.format(Math.abs(n))

  if (subtractive || n < 0) {
    return `(${formatted})`
  }
  return formatted
}

// Convenience integer formatter for places that previously used
// inline Intl.NumberFormat. No parens / subtractive treatment —
// integer counts (Projected Families, Projected Students) are
// non-negative by domain.
const int0 = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
})

export function formatInteger(value) {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return int0.format(n)
}
