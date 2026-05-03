import { useEffect, useRef, useState } from 'react'

// Tuition Fees section — fee fields per architecture §7.3 (renamed
// from "Per-student fees" in v3.8.2; the Before & After School Care
// line is hourly, not per-student). Configured at Stage 1; immutable
// in Stage 2 (the DB trigger enforces; this UI's read-only mode
// mirrors).
//
// Currency formatting on display, raw numeric input on focus.
// Direct-edit-with-undo: click an amount → inline numeric input →
// Enter or blur saves; Escape cancels.
//
// v3.8.3 (B1.2) extends the Before & After School Care row with a
// sub-line capturing projected annual B&A hours. Indents under the
// hourly-rate row at the four-tier hierarchy's leaf rhythm; help
// text uses italic muted treatment consistent with other field hints.
// Saves separately from the hourly rate field (the rate is the per-
// hour decision; the hours are the volume estimate). Stage 2 audit
// captures actual hours, which lives on a different column
// (actual_before_after_school_hours).
//
// Props:
//   curriculumFee                          numeric
//   enrollmentFee                          numeric
//   beforeAfterSchoolHourlyRate            numeric
//   projectedBAHours                       int | null  (v3.8.3)
//   onChangeCurriculumFee                  (next) => void
//   onChangeEnrollmentFee                  (next) => void
//   onChangeBeforeAfterSchoolHourlyRate    (next) => void
//   onChangeProjectedBAHours               (next | null) => void  (v3.8.3)
//   readOnly                               boolean

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

function parseFeeInput(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return 0
  const cleaned = s.replace(/[$,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('Fees must be a non-negative number')
  }
  return n
}

// v3.8.3 (B1.2): integer-hours parser for projected B&A hours. Empty
// input → null (clears the field; the column accepts NULL). Non-empty
// must be a non-negative whole number.
function parseHoursInput(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return null
  const cleaned = s.replace(/[,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error('Hours must be a non-negative whole number')
  }
  return n
}

const int0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function fmtHoursDisplay(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return '—'
  }
  return int0.format(Number(value))
}

function FeeEditor({ initial, onSave, onCancel }) {
  const [draft, setDraft] = useState(
    Number.isFinite(Number(initial)) ? String(Number(initial)) : ''
  )
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function commit() {
    try {
      const value = parseFeeInput(draft)
      onSave(value)
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          if (error) setError(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        className="w-32 text-right border-[0.5px] border-navy/40 px-2 py-1 rounded text-sm tabular-nums focus:outline-none focus:border-navy bg-white"
        aria-label="Fee amount"
      />
      {error && (
        <span className="text-status-red text-[11px] italic mt-0.5">
          {error}
        </span>
      )}
    </span>
  )
}

// v3.8.3 (B1.2): hours editor — integer parser; empty input clears
// the field (returns null).
function HoursEditor({ initial, onSave, onCancel }) {
  const [draft, setDraft] = useState(
    initial === null || initial === undefined ? '' : String(initial)
  )
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function commit() {
    try {
      onSave(parseHoursInput(draft))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          if (error) setError(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        className="w-32 text-right border-[0.5px] border-navy/40 px-2 py-1 rounded text-sm tabular-nums focus:outline-none focus:border-navy bg-white"
        aria-label="Projected annual hours"
      />
      {error && (
        <span className="text-status-red text-[11px] italic mt-0.5">
          {error}
        </span>
      )}
    </span>
  )
}

function FeeRow({ label, hint, value, format = 'usd0', editingKey, fieldKey, setEditing, onSave, readOnly }) {
  const editing = editingKey === fieldKey
  const display = format === 'usd2'
    ? usd2.format(Number(value) || 0)
    : usd0.format(Number(value) || 0)

  return (
    <div className="flex items-center gap-3 pr-3 py-2 border-b-[0.5px] border-card-border hover:bg-cream-highlight/40">
      <div className="flex-1 min-w-0">
        <p className="font-body text-[13px] text-navy/85">{label}</p>
        {hint && (
          <p className="font-body italic text-muted text-[11px] mt-0.5">{hint}</p>
        )}
      </div>

      {readOnly ? (
        <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
          {display}
        </span>
      ) : editing ? (
        <FeeEditor
          initial={Number(value) || 0}
          onSave={(v) => { onSave(v); setEditing(null) }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(fieldKey)}
          className="text-right tabular-nums px-2 py-1 rounded font-body text-[13px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy/85"
          aria-label={`Edit ${label}`}
          title="Click to edit"
        >
          {display}
        </button>
      )}
    </div>
  )
}

function FeesSection({
  curriculumFee,
  enrollmentFee,
  beforeAfterSchoolHourlyRate,
  projectedBAHours,
  onChangeCurriculumFee,
  onChangeEnrollmentFee,
  onChangeBeforeAfterSchoolHourlyRate,
  onChangeProjectedBAHours,
  readOnly = false,
}) {
  const [editing, setEditing] = useState(null)
  const editingHours = editing === 'projected_ba_hours'

  return (
    <section className="mb-8">
      {/* Tier 1 section header. v3.8.2 (B1.1): renamed "Per-student fees"
          → "Tuition fees" since the Before & After School Care line is
          hourly, not per-student. */}
      <div className="flex items-center gap-3 px-2 py-3 border-b-2 border-gold/60 mb-2">
        <span className="font-display text-navy text-[17px] tracking-[0.08em] uppercase flex-1">
          Tuition fees
        </span>
      </div>

      <p className="font-body italic text-muted text-[12px] mb-3 px-2">
        Curriculum fees and enrollment fees roll into Budget revenue per
        enrolled student. The Before &amp; After School Care hourly rate
        applies to projected hours at Stage 1; Stage 2 audit captures
        the actual hours.
      </p>

      <div className="px-2">
        <FeeRow
          label="Curriculum fee (per student)"
          hint="Annual curriculum fee charged once per enrolled student."
          value={curriculumFee}
          fieldKey="curriculum"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeCurriculumFee}
          readOnly={readOnly}
        />
        <FeeRow
          label="Enrollment fee (per student)"
          hint="One-time enrollment fee, charged at registration."
          value={enrollmentFee}
          fieldKey="enrollment"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeEnrollmentFee}
          readOnly={readOnly}
        />
        <FeeRow
          label="Before &amp; After School Care hourly rate"
          hint="Per-hour rate. Multiplies against the projected hours below to compute Stage 1 B&A revenue. Stage 2 audit captures actual hours."
          value={beforeAfterSchoolHourlyRate}
          format="usd2"
          fieldKey="ba_rate"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeBeforeAfterSchoolHourlyRate}
          readOnly={readOnly}
        />

        {/* v3.8.3 (B1.2): projected annual B&A hours sub-line. Indents
            under the hourly-rate row at the four-tier hierarchy's leaf
            rhythm (24px past the parent row's left edge). Saves
            separately from the hourly rate; null when not yet entered. */}
        <div className="flex items-center gap-3 pr-3 pl-6 py-1.5 border-b-[0.5px] border-card-border/60 hover:bg-cream-highlight/40">
          <div className="flex-1 min-w-0">
            <p className="font-body text-[12.5px] text-navy/85">
              Projected annual hours (Stage 1)
            </p>
            <p className="font-body italic text-muted text-[11px] mt-0.5">
              Estimate total B&amp;A hours across all enrolled students.
              Stage 2 audit captures the actual hours.
            </p>
          </div>
          {readOnly ? (
            <span className="text-right tabular-nums px-2 py-1 font-body text-[13px] w-32 flex-shrink-0 text-navy/85">
              {fmtHoursDisplay(projectedBAHours)}
            </span>
          ) : editingHours ? (
            <HoursEditor
              initial={projectedBAHours}
              onSave={(v) => { onChangeProjectedBAHours(v); setEditing(null) }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing('projected_ba_hours')}
              className="text-right tabular-nums px-2 py-1 rounded font-body text-[13px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy/85"
              aria-label="Edit projected annual hours"
              title="Click to edit. Empty input clears the projection."
            >
              {fmtHoursDisplay(projectedBAHours)}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

export default FeesSection
