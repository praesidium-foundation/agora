import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/AuthProvider'

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

  // Profile still loading after sign-in (session exists, profile fetch pending)
  if (session && !profile) {
    return (
      <div className="min-h-screen bg-navy text-white flex items-center justify-center font-body">
        <p className="text-gold">Loading…</p>
      </div>
    )
  }

  // Authenticated but not an admin
  if (!profile?.is_system_admin) {
    return (
      <div className="min-h-screen bg-navy text-white font-body">
        <header className="border-b border-gold/20 px-6 py-4 flex items-center gap-3">
          <img src="/logo-mark-white.png" alt="" className="h-10" />
          <span className="font-display text-gold text-xl">Libertas Agora</span>
        </header>
        <main className="max-w-3xl mx-auto px-6 py-12 text-center">
          <h1 className="font-display text-gold text-3xl mb-4">
            You don't have access to this page.
          </h1>
          <p className="text-white/70 mb-8">
            Academic Year management is restricted to system admins.
          </p>
          <Link
            to="/dashboard"
            className="inline-block border border-gold text-gold px-6 py-2 hover:bg-gold hover:text-navy transition-colors"
          >
            Back to Dashboard
          </Link>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-navy text-white font-body">
      <header className="border-b border-gold/20 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo-mark-white.png" alt="" className="h-10" />
          <span className="font-display text-gold text-xl">Libertas Agora</span>
        </div>
        <Link
          to="/dashboard"
          className="text-gold/80 hover:text-gold text-sm"
        >
          ← Dashboard
        </Link>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12">
        <p className="uppercase tracking-[0.3em] text-gold text-xs mb-2">
          Libertas Academy
        </p>
        <h1 className="font-display text-gold text-4xl md:text-5xl mb-8">
          Academic Years
        </h1>

        <div className="mb-6">
          {showForm ? (
            <button
              type="button"
              onClick={() => {
                setShowForm(false)
                resetForm()
              }}
              className="text-gold/80 hover:text-gold text-sm"
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
              className="border border-gold text-gold px-6 py-2 hover:bg-gold hover:text-navy transition-colors"
            >
              + Create AYE
            </button>
          )}
        </div>

        {showForm && (
          <form
            onSubmit={handleSubmit}
            className="border border-gold/30 p-6 mb-8 space-y-4"
          >
            <div>
              <label htmlFor="label" className="block text-white/70 text-sm mb-1">
                Label
              </label>
              <input
                id="label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
                placeholder="AYE 2027"
                className="w-full bg-transparent border border-gold/40 text-white px-4 py-2 focus:border-gold focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="start" className="block text-white/70 text-sm mb-1">
                  Start date
                </label>
                <input
                  id="start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                  className="w-full bg-transparent border border-gold/40 text-white px-4 py-2 focus:border-gold focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="end" className="block text-white/70 text-sm mb-1">
                  End date
                </label>
                <input
                  id="end"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  required
                  className="w-full bg-transparent border border-gold/40 text-white px-4 py-2 focus:border-gold focus:outline-none"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-white/80 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={setCurrent}
                onChange={(e) => setSetCurrent(e.target.checked)}
                className="accent-gold"
              />
              Set as current
            </label>

            {formError && (
              <p className="text-red-300 text-sm" role="alert">
                {formError}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="border border-gold text-gold px-6 py-2 hover:bg-gold hover:text-navy transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </form>
        )}

        {success && (
          <p className="text-green-300 text-sm mb-6" role="status">
            {success}
          </p>
        )}

        {listError && (
          <p className="text-red-300 text-sm mb-6" role="alert">
            Could not load AYEs: {listError}
          </p>
        )}

        {listLoading ? (
          <p className="text-gold/70">Loading…</p>
        ) : ayes.length === 0 ? (
          <p className="text-white/60 italic">
            No academic years yet. Create one to get started.
          </p>
        ) : (
          <table className="w-full border border-gold/20">
            <thead>
              <tr className="bg-gold/10 text-gold text-left text-sm uppercase tracking-wider">
                <th className="px-4 py-3">Label</th>
                <th className="px-4 py-3">Start</th>
                <th className="px-4 py-3">End</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {ayes.map((aye) => (
                <tr
                  key={aye.id}
                  className="border-t border-gold/20 text-white/90"
                >
                  <td className="px-4 py-3">{aye.label}</td>
                  <td className="px-4 py-3">{aye.start_date}</td>
                  <td className="px-4 py-3">{aye.end_date}</td>
                  <td className="px-4 py-3 space-x-2">
                    {aye.is_current && (
                      <span className="inline-block bg-gold text-navy px-2 py-0.5 text-xs uppercase tracking-wider">
                        Current
                      </span>
                    )}
                    {aye.is_locked && (
                      <span className="inline-block border border-white/40 text-white/60 px-2 py-0.5 text-xs uppercase tracking-wider">
                        Locked
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  )
}

export default AYEManagement
