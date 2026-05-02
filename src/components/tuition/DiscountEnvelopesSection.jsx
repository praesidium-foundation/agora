import { useEffect, useRef, useState } from 'react'

// Discount Envelopes section — three of the four discount mechanisms
// in the layered taxonomy (architecture §7.3). The multi-student tier
// discount is implicit in the tier rates (handled by TierRatesSection);
// these three are the explicit envelopes:
//
//   Faculty discount rate  — fixed percentage off gross tuition for
//                            qualifying faculty children. Default 50%
//                            at Libertas. Configured here as a rule;
//                            the per-family allocation happens in
//                            Stage 2 (Tuition Audit).
//   Other discount         — board-granted budget envelope for ad-hoc
//                            tuition awards. Per-family allocation
//                            happens in Stage 2.
//   Financial Aid          — committee-managed budget envelope. Per-
//                            family allocation happens in Stage 2.
//
// Visual hierarchy: Tier 1 section header (Cinzel 17px navy with gold
// border-bottom). Three rows below as Tier 4-equivalent leaf rows.
//
// Props:
//   facultyDiscountPct                    numeric (0–100)
//   otherDiscountEnvelope                 numeric
//   financialAidEnvelope                  numeric
//   onChangeFacultyDiscountPct            (next) => void
//   onChangeOtherDiscountEnvelope         (next) => void
//   onChangeFinancialAidEnvelope          (next) => void
//   readOnly                              boolean

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function fmtUsd(n) {
  return usd0.format(Number(n) || 0)
}

function fmtPct(n) {
  if (n === null || n === undefined) return '—'
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  return `${num.toFixed(2)}%`
}

function parseCurrency(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return 0
  const cleaned = s.replace(/[$,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('Envelope must be a non-negative number')
  }
  return n
}

function parsePercent(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return 0
  const cleaned = s.replace(/[%\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error('Percentage must be between 0 and 100')
  }
  return n
}

function ValueEditor({ initial, parser, onSave, onCancel, ariaLabel }) {
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
      onSave(parser(draft))
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
        aria-label={ariaLabel}
      />
      {error && (
        <span className="text-status-red text-[11px] italic mt-0.5">
          {error}
        </span>
      )}
    </span>
  )
}

function DiscountRow({ label, hint, value, display, parser, fieldKey, editingKey, setEditing, onSave, readOnly }) {
  const editing = editingKey === fieldKey
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
        <ValueEditor
          initial={Number(value) || 0}
          parser={parser}
          onSave={(v) => { onSave(v); setEditing(null) }}
          onCancel={() => setEditing(null)}
          ariaLabel={label}
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

function DiscountEnvelopesSection({
  facultyDiscountPct,
  otherDiscountEnvelope,
  financialAidEnvelope,
  onChangeFacultyDiscountPct,
  onChangeOtherDiscountEnvelope,
  onChangeFinancialAidEnvelope,
  readOnly = false,
}) {
  const [editing, setEditing] = useState(null)

  return (
    <section className="mb-8">
      {/* Tier 1 section header */}
      <div className="flex items-center gap-3 px-2 py-3 border-b-2 border-gold/60 mb-2">
        <span className="font-display text-navy text-[17px] tracking-[0.08em] uppercase flex-1">
          Discount envelopes
        </span>
      </div>

      <p className="font-body italic text-muted text-[12px] mb-3 px-2">
        Three of the four discount mechanisms in the layered taxonomy. The
        multi-student tier discount is configured implicitly through the tier
        rates above. Per-family allocation of Faculty / Other / Financial Aid
        awards happens in Stage 2 (Tuition Audit).
      </p>

      <div className="px-2">
        <DiscountRow
          label="Faculty discount rate"
          hint="Percentage off gross tuition for qualifying faculty children. Default 50%."
          value={facultyDiscountPct}
          display={fmtPct(facultyDiscountPct)}
          parser={parsePercent}
          fieldKey="faculty_pct"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeFacultyDiscountPct}
          readOnly={readOnly}
        />
        <DiscountRow
          label="Other discount envelope"
          hint="Board-granted budget for ad-hoc tuition awards. Per-family allocation happens in Tuition Audit (Stage 2)."
          value={otherDiscountEnvelope}
          display={fmtUsd(otherDiscountEnvelope)}
          parser={parseCurrency}
          fieldKey="other_envelope"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeOtherDiscountEnvelope}
          readOnly={readOnly}
        />
        <DiscountRow
          label="Financial Aid envelope"
          hint="Committee-managed budget for Financial Aid awards. Per-family allocation happens in Tuition Audit (Stage 2)."
          value={financialAidEnvelope}
          display={fmtUsd(financialAidEnvelope)}
          parser={parseCurrency}
          fieldKey="fa_envelope"
          editingKey={editing}
          setEditing={setEditing}
          onSave={onChangeFinancialAidEnvelope}
          readOnly={readOnly}
        />
      </div>
    </section>
  )
}

export default DiscountEnvelopesSection
