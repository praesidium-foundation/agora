import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

function AYESelector({ value, onChange }) {
  const [ayes, setAyes] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let mounted = true

    async function load() {
      // v3.8.27: date-driven current AYE via get_current_academic_year()
      // RPC (M048) — fetches the full list and the current row in
      // parallel; the current id drives both the default-pick on first
      // load and the "(current)" suffix at render time.
      const [listResult, currentResult] = await Promise.all([
        supabase
          .from('academic_years')
          .select('id, label')
          .order('start_date', { ascending: false }),
        supabase.rpc('get_current_academic_year'),
      ])

      if (!mounted) return

      if (listResult.error) {
        setError(listResult.error.message)
        setLoading(false)
        return
      }

      const list = listResult.data || []
      const currentAyeId = currentResult.data?.id ?? null
      setAyes(list)
      setCurrentId(currentAyeId)
      setLoading(false)

      // If parent hasn't picked a value yet, default to the current AYE
      // (or the most recent one if no row covers today).
      if (!value && list.length > 0) {
        const fallbackId = currentAyeId && list.some((a) => a.id === currentAyeId)
          ? currentAyeId
          : list[0].id
        onChange(fallbackId)
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
            {aye.id === currentId ? ' (current)' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

export default AYESelector
