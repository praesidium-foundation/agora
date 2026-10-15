import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import { useToast } from '../../lib/Toast'
import AppShell from '../../components/AppShell'
import Card from '../../components/Card'
import Badge from '../../components/Badge'
import SectionLabel from '../../components/SectionLabel'
import FieldLabel from '../../components/FieldLabel'
import Breadcrumb from '../../components/Breadcrumb'

const inputCls =
  'w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none'

const inlineInputCls =
  'w-full bg-white border-[0.5px] border-card-border text-body px-2 py-1 rounded text-sm focus:border-navy focus:outline-none'

const navyBtnCls =
  'inline-block bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed'

// v3.8.27: date-derived status (M048). Called at render time; result
// is not stored. Returns 'current' | 'upcoming' | 'past'. Dates are
// parsed with the +T00:00:00 local-time suffix so day-boundary
// comparisons don't shift across timezones (matches Dashboard.jsx's
// formatDate pattern).
function getAyeStatus(aye) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = new Date(aye.start_date + 'T00:00:00')
  const end = new Date(aye.end_date + 'T00:00:00')
  if (today < start) return 'upcoming'
  if (today > end) return 'past'
  return 'current'
}

function StatusBadge({ status }) {
  if (status === 'current') return <Badge variant="green">Current</Badge>
  if (status === 'upcoming') return <Badge variant="blue">Upcoming</Badge>
  return <Badge variant="muted">Past</Badge>
}

function AYEManagement() {
  const { session, profile } = useAuth()
  const toast = useToast()

  const [ayes, setAyes] = useState([])
  const [listLoading, setListLoading] = useState(true)

  // Add-form state (new AYE)
  const [showForm, setShowForm] = useState(false)
  const [label, setLabel] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState(null)

  // Edit-in-place state (existing AYE) — v3.8.27. Scoped separately
  // from the add form so one doesn't clobber the other. Only one row
  // can be in edit mode at a time; opening Edit on a different row
  // while one is already open warns and keeps the first open.
  const [editingId, setEditingId] = useState(null)
  const [editLabel, setEditLabel] = useState('')
  const [editStartDate, setEditStartDate] = useState('')
  const [editEndDate, setEditEndDate] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [editError, setEditError] = useState(null)

  async function loadAyes() {
    setListLoading(true)
    // v3.8.27: is_current column dropped by M048; status is date-
    // derived at render via getAyeStatus. Notes added to the SELECT
    // so edit-in-place can hydrate the field from existing data.
    const { data, error } = await supabase
      .from('academic_years')
      .select('id, label, start_date, end_date, notes, is_locked')
      .order('start_date', { ascending: false })
    if (error) {
      toast.error(`Could not load academic years: ${error.message}`)
    } else {
      setAyes(data || [])
    }
    setListLoading(false)
  }

  useEffect(() => {
    if (profile?.is_system_admin) loadAyes()
  }, [profile])

  function resetForm() {
    setLabel('')
    setStartDate('')
    setEndDate('')
    setFormError(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setFormError(null)
    setSubmitting(true)

    // v3.8.27: p_set_current removed by M048 — current AYE is now
    // date-derived, not operator-flagged.
    const { error: rpcError } = await supabase.rpc('bootstrap_aye', {
      p_label: label,
      p_start_date: startDate,
      p_end_date: endDate,
    })

    setSubmitting(false)

    if (rpcError) {
      setFormError(rpcError.message)
      return
    }

    toast.success(`Created ${label}.`)
    resetForm()
    setShowForm(false)
    loadAyes()
  }

  function handleEdit(aye) {
    setEditingId(aye.id)
    setEditLabel(aye.label)
    setEditStartDate(aye.start_date)
    setEditEndDate(aye.end_date)
    setEditNotes(aye.notes || '')
    setEditError(null)
  }

  function handleCancelEdit() {
    setEditingId(null)
    setEditLabel('')
    setEditStartDate('')
    setEditEndDate('')
    setEditNotes('')
    setEditError(null)
  }

  async function handleSaveEdit(e) {
    e.preventDefault()
    setEditError(null)
    setEditSubmitting(true)

    const { data, error: rpcError } = await supabase.rpc('update_academic_year', {
      p_id: editingId,
      p_label: editLabel,
      p_start_date: editStartDate,
      p_end_date: editEndDate,
      p_notes: editNotes.trim() === '' ? null : editNotes,
    })

    setEditSubmitting(false)

    if (rpcError) {
      // The aye_dates_valid CHECK constraint (001:133) raises with a
      // Postgres-level message when end_date <= start_date; surface it
      // inline for the operator rather than silently dropping.
      setEditError(rpcError.message)
      return
    }

    // Optimistically replace the row in local state so the table
    // reflects the save without waiting for a reload.
    if (data) {
      setAyes((prev) => prev.map((a) => (a.id === data.id ? data : a)))
    }
    toast.success(`Updated ${editLabel}.`)
    handleCancelEdit()
  }

  if (session && !profile) {
    return (
      <AppShell>
        <p className="text-muted">Loading…</p>
      </AppShell>
    )
  }

  if (!profile?.is_system_admin) {
    return (
      <AppShell>
        <Breadcrumb items={[{ label: 'Admin' }, { label: 'Academic Years' }]} />
        <h1 className="font-display text-navy text-[28px] mb-3 leading-tight">
          You do not have access to this page.
        </h1>
        <p className="text-body mb-6">
          Academic Year management is restricted to system admins.
        </p>
        <Link to="/dashboard" className={navyBtnCls}>
          Back to Dashboard
        </Link>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <Breadcrumb items={[{ label: 'Admin' }, { label: 'Academic Years' }]} />
      <h1 className="font-display text-navy text-[28px] mb-1 leading-tight">
        Academic Years
      </h1>
      <p className="font-body italic text-muted mb-8">
        Create and manage academic years. Each new AYE seeds a draft module
        instance for every active module. The current AYE is derived from
        today's date — the row whose window covers today.
      </p>

      <div className="mb-8">
        {showForm ? (
          <button
            type="button"
            onClick={() => {
              setShowForm(false)
              resetForm()
            }}
            className="font-body text-muted hover:text-navy text-sm"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setShowForm(true)
            }}
            className={navyBtnCls}
          >
            + Create AYE
          </button>
        )}
      </div>

      {showForm && (
        <section className="mb-10">
          <SectionLabel>New Academic Year</SectionLabel>
          <div className="max-w-2xl">
            <Card>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <FieldLabel htmlFor="label">Label</FieldLabel>
                  <input
                    id="label"
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    required
                    placeholder="AYE 2027"
                    className={inputCls}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <FieldLabel htmlFor="start">Start date</FieldLabel>
                    <input
                      id="start"
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      required
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <FieldLabel htmlFor="end">End date</FieldLabel>
                    <input
                      id="end"
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      required
                      className={inputCls}
                    />
                  </div>
                </div>

                {formError && (
                  <p className="text-status-red text-sm" role="alert">
                    {formError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className={navyBtnCls}
                >
                  {submitting ? 'Creating…' : 'Create'}
                </button>
              </form>
            </Card>
          </div>
        </section>
      )}

      {/* Status messages route via global Toast (top-right of viewport). */}

      <section>
        <SectionLabel>Academic Years</SectionLabel>
        {listLoading ? (
          <p className="text-muted">Loading…</p>
        ) : ayes.length === 0 ? (
          <p className="text-muted italic">
            No academic years yet. Create one to get started.
          </p>
        ) : (
          <Card className="!p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-cream-highlight">
                  <th className="px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">
                    Label
                  </th>
                  <th className="px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">
                    Start
                  </th>
                  <th className="px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">
                    End
                  </th>
                  <th className="px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">
                    Notes
                  </th>
                  <th className="px-4 py-3 text-left font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right font-display text-[13px] tracking-[0.08em] uppercase font-normal text-navy/80" />
                </tr>
              </thead>
              <tbody>
                {ayes.map((aye, i) => {
                  const isEditing = editingId === aye.id
                  const rowBg = i % 2 === 1 ? 'bg-alt-row' : 'bg-white'
                  const rowCls = `border-t-[0.5px] border-card-border font-body text-body transition-colors ${
                    isEditing ? 'bg-cream-highlight/60' : `hover:bg-cream-highlight ${rowBg}`
                  }`

                  if (isEditing) {
                    // Compute status from the edit-form values so the
                    // badge previews the saved state live as the operator
                    // adjusts dates. Only computes when both dates parse.
                    const previewAye =
                      editStartDate && editEndDate
                        ? { start_date: editStartDate, end_date: editEndDate }
                        : null
                    return (
                      <tr key={aye.id} className={rowCls}>
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            value={editLabel}
                            onChange={(e) => setEditLabel(e.target.value)}
                            required
                            className={inlineInputCls}
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="date"
                            value={editStartDate}
                            onChange={(e) => setEditStartDate(e.target.value)}
                            required
                            className={inlineInputCls}
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="date"
                            value={editEndDate}
                            onChange={(e) => setEditEndDate(e.target.value)}
                            required
                            className={inlineInputCls}
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            value={editNotes}
                            onChange={(e) => setEditNotes(e.target.value)}
                            placeholder="Optional"
                            className={inlineInputCls}
                          />
                        </td>
                        <td className="px-4 py-2 space-x-2">
                          {previewAye && <StatusBadge status={getAyeStatus(previewAye)} />}
                          {aye.is_locked && <Badge variant="amber">Locked</Badge>}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <div className="flex items-center justify-end gap-3">
                            {editError && (
                              <span
                                className="text-status-red text-xs"
                                role="alert"
                                title={editError}
                              >
                                {editError}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={handleSaveEdit}
                              disabled={editSubmitting}
                              className="font-body text-navy hover:underline text-sm disabled:opacity-50"
                            >
                              {editSubmitting ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              onClick={handleCancelEdit}
                              disabled={editSubmitting}
                              className="font-body text-muted hover:text-navy text-sm disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  }

                  return (
                    <tr key={aye.id} className={rowCls}>
                      <td className="px-4 py-3 text-navy">{aye.label}</td>
                      <td className="px-4 py-3 tabular-nums">{aye.start_date}</td>
                      <td className="px-4 py-3 tabular-nums">{aye.end_date}</td>
                      <td className="px-4 py-3 text-muted">
                        {aye.notes ? aye.notes : <span className="italic">—</span>}
                      </td>
                      <td className="px-4 py-3 space-x-2">
                        <StatusBadge status={getAyeStatus(aye)} />
                        {aye.is_locked && <Badge variant="amber">Locked</Badge>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleEdit(aye)}
                          disabled={editingId !== null}
                          className="font-body text-navy hover:underline text-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
                          title={
                            editingId !== null
                              ? 'Finish editing the other row first.'
                              : undefined
                          }
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </AppShell>
  )
}

export default AYEManagement
