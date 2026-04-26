import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'
import AppShell from '../../components/AppShell'
import Card from '../../components/Card'
import Badge from '../../components/Badge'
import SectionLabel from '../../components/SectionLabel'

const inputCls =
  'w-full bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none'

const navyBtnCls =
  'inline-block bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed'

function FieldLabel({ htmlFor, children }) {
  return (
    <label
      htmlFor={htmlFor}
      className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5"
    >
      {children}
    </label>
  )
}

function AYEManagement() {
  const { session, profile } = useAuth()

  const [ayes, setAyes] = useState([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState(null)

  const [showForm, setShowForm] = useState(false)
  const [label, setLabel] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [setCurrent, setSetCurrent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState(null)
  const [success, setSuccess] = useState(null)

  async function loadAyes() {
    setListLoading(true)
    setListError(null)
    const { data, error } = await supabase
      .from('academic_years')
      .select('id, label, start_date, end_date, is_current, is_locked')
      .order('start_date', { ascending: false })
    if (error) {
      setListError(error.message)
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
    setSetCurrent(false)
    setFormError(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setFormError(null)
    setSuccess(null)
    setSubmitting(true)

    const { error: rpcError } = await supabase.rpc('bootstrap_aye', {
      p_label: label,
      p_start_date: startDate,
      p_end_date: endDate,
      p_set_current: setCurrent,
    })

    setSubmitting(false)

    if (rpcError) {
      setFormError(rpcError.message)
      return
    }

    setSuccess(`Created ${label}.`)
    resetForm()
    setShowForm(false)
    loadAyes()
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
        <h1 className="font-display text-navy text-[28px] mb-3 leading-tight">
          You don't have access to this page.
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
      <h1 className="font-display text-navy text-[28px] mb-1 leading-tight">
        Academic Years
      </h1>
      <p className="font-body italic text-muted mb-8">
        Create and manage academic years. Each new AYE seeds a draft module
        instance for every active module.
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
              setSuccess(null)
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

                <label className="flex items-center gap-2 font-body text-body text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={setCurrent}
                    onChange={(e) => setSetCurrent(e.target.checked)}
                    className="accent-navy"
                  />
                  Set as current
                </label>

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

      {success && (
        <p className="text-status-green text-sm mb-6" role="status">
          {success}
        </p>
      )}

      {listError && (
        <p className="text-status-red text-sm mb-6" role="alert">
          Could not load AYEs: {listError}
        </p>
      )}

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
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {ayes.map((aye, i) => (
                  <tr
                    key={aye.id}
                    className={`border-t-[0.5px] border-card-border font-body text-body hover:bg-cream-highlight transition-colors ${
                      i % 2 === 1 ? 'bg-alt-row' : 'bg-white'
                    }`}
                  >
                    <td className="px-4 py-3 text-navy">{aye.label}</td>
                    <td className="px-4 py-3 tabular-nums">{aye.start_date}</td>
                    <td className="px-4 py-3 tabular-nums">{aye.end_date}</td>
                    <td className="px-4 py-3 space-x-2">
                      {aye.is_current && <Badge variant="navy">Current</Badge>}
                      {aye.is_locked && <Badge variant="amber">Locked</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </AppShell>
  )
}

export default AYEManagement
