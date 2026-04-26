import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { useAuth } from './AuthProvider'

// Wraps the Postgres function current_user_has_module_perm(code, level).
// That function already handles the enum hierarchy and short-circuits for
// system admins, so the hook is just a thin async wrapper for React state.
export function useModulePermission(moduleCode, requiredLevel) {
  const { session, loading: authLoading } = useAuth()
  const [allowed, setAllowed] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Wait until AuthProvider has settled.
    if (authLoading) return

    if (!session) {
      setAllowed(false)
      setLoading(false)
      return
    }

    let mounted = true
    async function check() {
      const { data, error } = await supabase.rpc(
        'current_user_has_module_perm',
        { p_module_code: moduleCode, p_required_level: requiredLevel }
      )

      if (!mounted) return

      if (error) {
        console.error('Permission check failed:', error)
        setAllowed(false)
      } else {
        setAllowed(data === true)
      }
      setLoading(false)
    }

    check()
    return () => {
      mounted = false
    }
  }, [session, authLoading, moduleCode, requiredLevel])

  return { allowed, loading }
}
