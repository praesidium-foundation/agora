import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

function AYESelector({ value, onChange }) {
  const [ayes, setAyes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let mounted = true

    async function load() {
      const { data, error: fetchError } = await supabase
        .from('academic_years')
        .select('id, label, is_current')
        .order('start_date', { ascending: false })

      if (!mounted) return

      if (fetchError) {
        setError(fetchError.message)
        setLoading(false)
        return
      }

      const list = data || []
      setAyes(list)
      setLoading(false)

      // If parent hasn't picked a value yet, default to the current AYE
      // (or the most recent one if none is flagged current).
      if (!value && list.length > 0) {
        const fallback = list.find((a) => a.is_current) || list[0]
        onChange(fallback.id)
      }
    }

    load()
    return () => {
      mounted = false
    }
    // Intentionally fetch only once on mount; value/onChange handled at first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loading) {
    return <p className="text-muted text-sm">Loading academic years…</p>
  }

  if (error) {
    return (
      <p className="text-status-red text-sm">
        Could not load academic years: {error}
      </p>
    )
  }

  if (ayes.length === 0) {
    return (
      <p className="text-muted text-sm italic">No academic years exist yet.</p>
    )
  }

  return (
    <div>
      <label
        htmlFor="aye-select"
        className="block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5"
      >
        Academic Year
      </label>
      <select
        id="aye-select"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="bg-white border-[0.5px] border-card-border text-body px-3 py-2 rounded text-sm focus:border-navy focus:outline-none cursor-pointer min-w-[180px]"
      >
        {ayes.map((aye) => (
          <option key={aye.id} value={aye.id}>
            {aye.label}
            {aye.is_current ? ' (current)' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

export default AYESelector
