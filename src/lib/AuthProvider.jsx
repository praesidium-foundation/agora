import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabase'

const AuthContext = createContext(null)

async function fetchProfile(userId) {
  const { data } = await supabase
    .from('user_profiles')
    .select('full_name, is_system_admin')
    .eq('id', userId)
    .single()
  return data
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    // Initial session check — guaranteed to resolve, even when signed out.
    supabase.auth.getSession().then(async ({ data: { session: initial } }) => {
      if (!mounted) return
      setSession(initial)

      if (initial) {
        try {
          const p = await fetchProfile(initial.user.id)
          if (mounted) setProfile(p)
        } catch (e) {
          console.error('Failed to load profile:', e)
        }
      }

      if (mounted) setLoading(false)
    })

    // Subscribe to future auth changes (sign-in, sign-out, token refresh).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!mounted) return
      // Skip INITIAL_SESSION — already handled by getSession() above.
      if (event === 'INITIAL_SESSION') return

      setSession(newSession)

      // Defer supabase queries out of this callback to avoid a documented
      // deadlock with Supabase's internal auth lock during sign-in/out.
      setTimeout(async () => {
        if (!mounted) return

        if (newSession) {
          try {
            const p = await fetchProfile(newSession.user.id)
            if (mounted) setProfile(p)
          } catch (e) {
            console.error('Failed to load profile:', e)
          }
        } else {
          setProfile(null)
        }
      }, 0)
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    loading,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (ctx === null) {
    throw new Error('useAuth must be used inside an <AuthProvider>')
  }
  return ctx
}
