import { useEffect, useRef, useState } from 'react'

// Projected Enrollment section — Stage 1 page-leading input
// (architecture §7.3 "Stage 1 page section ordering," v3.8.6 / B1.5).
//
// Single-input section containing only Total students. Real-data
// walkthrough surfaced that Stage 1 planning starts with projecting
// enrollment, then sets per-student rates, then layers discounts —
// the load-bearing decision is the headcount, not the rate. Placing
// this section above Tier Rates puts the load-bearing input at the
// top of the page, matching how the school actually thinks through
// Stage 1 decisions.
//
// Total students drives every downstream computation — tier-blended
// tuition, fee revenue, B&A revenue, discount projections, family
// count derivation. Edit path is exclusive to this section: Family
// Distribution displays a read-only mirror but does not allow edits
// to total_students. Single source of truth for editing.
//
// Visual hierarchy:
//   - Section header: standard Tier 1 treatment (Cinzel 17px navy
//     with gold border-bottom), matching peer sections.
//   - Help paragraph: italic muted, matching other section help text.
//   - Total students input: bold typography in label and value, in
//     display / focus / read-only states. The bold weight is the
//     visual differentiator that signals "load-bearing input"; the
//     section's placement at the top of the page reinforces the
//     same signal.
//
// Save-on-blur identical to other inputs. The save handler triggers
// the same applyDerivedFamilyCounts recomputation that v3.8.2's
// total_students edits in Family Distribution triggered — total
// families and family-distribution rows continue to derive from
// total_students × breakdown_pct exactly as before. The page handler
// (TuitionWorksheet.handleUpdateField) handles the "tracking derived"
// recomputation transparently.
//
// Props:
//   totalStudents          — number | null
//   onChangeTotalStudents  — (next: number | null) => void
//                            null clears the field; the column accepts
//                            NULL.
//   readOnly               — boolean

const int0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function fmtInt(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  return int0.format(Number(n))
}

function parseInt0(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return null
  const cleaned = s.replace(/[,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error('Total students must be a non-negative whole number')
  }
  return n
}

// Bold inline editor — same on-blur-saves / Escape-cancels pattern as
// the page's other ScalarEditor instances. The bold typography
// distinguishes this load-bearing input from standard editable rows.
function StudentsEditor({ initial, onSave, onCancel }) {
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
      onSave(parseInt0(draft))
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
        className="w-32 text-right font-body font-semibold border-[0.5px] border-navy/40 px-2 py-1 rounded text-sm tabular-nums focus:outline-none focus:border-navy bg-white"
        aria-label="Total students"
      />
      {error && (
        <span className="text-status-red text-[11px] italic mt-0.5">
          {error}
        </span>
      )}
    </span>
  )
}

function ProjectedEnrollmentSection({
  totalStudents,
  onChangeTotalStudents,
  readOnly = false,
}) {
  const [editing, setEditing] = useState(false)

  function handleSave(value) {
    setEditing(false)
    onChangeTotalStudents(value)
  }

  return (
    <section className="mb-8">
      {/* Tier 1 section header (architecture §10.4 in-app extension). */}
      <div className="flex items-center gap-3 px-2 py-3 border-b-2 border-gold/60 mb-2">
        <span className="font-display text-navy text-[17px] tracking-[0.08em] uppercase flex-1">
          Projected enrollment
        </span>
      </div>

      <p className="font-body italic text-muted text-[12px] mb-4 px-2 leading-relaxed">
        Project total enrollment for the academic year. Total students drives
        every downstream calculation — tier-blended tuition, fee revenue, and
        discount projections. Stage 2 audit captures actual enrollment.
      </p>

      <div className="px-2">
        <div className="flex items-center gap-3 pr-3 py-2">
          <span className="font-body font-semibold text-navy text-[14px] flex-1 min-w-0">
            Total students
          </span>

          {readOnly ? (
            // Read-only state: bold value, no input chrome. Em-dash when
            // total_students is null.
            <span className="text-right tabular-nums px-2 py-1 font-body font-semibold text-[14px] w-32 flex-shrink-0 text-navy">
              {fmtInt(totalStudents)}
            </span>
          ) : editing ? (
            <StudentsEditor
              initial={totalStudents}
              onSave={handleSave}
              onCancel={() => setEditing(false)}
            />
          ) : (
            // Display button: bold value to match the editor and the
            // load-bearing visual signal.
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-right tabular-nums px-2 py-1 rounded font-body font-semibold text-[14px] w-32 flex-shrink-0 bg-white border-[0.5px] border-card-border cursor-text hover:border-navy/40 hover:bg-cream-highlight/40 transition-colors text-navy"
              aria-label="Edit total students"
              title="Click to edit. Empty input clears the projection."
            >
              {fmtInt(totalStudents)}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

export default ProjectedEnrollmentSection
