import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (signInError) {
        setError(signInError.message)
        return
      }

      navigate('/dashboard')
    } catch (networkError) {
      setError(
        'Could not reach the server. Check your internet connection and try again.'
      )
      console.error(networkError)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-navy text-white flex items-center justify-center p-6 font-body">
      <div className="w-full text-center">
        <img
          src="/logo-mark-white.png"
          alt="Libertas Academy crest"
          className="h-40 mx-auto mb-8"
        />
        <p className="uppercase tracking-[0.3em] text-gold text-xs mb-4">
          Libertas Academy
        </p>
        <h1 className="font-display text-gold text-5xl md:text-6xl mb-12 whitespace-nowrap">
          Libertas Agora
        </h1>

        <form onSubmit={handleSubmit} className="w-full max-w-md mx-auto space-y-4 text-left">
          <div>
            <label htmlFor="email" className="block text-white/70 text-sm mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full bg-transparent border border-gold/40 text-white px-4 py-2 focus:border-gold focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-white/70 text-sm mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full bg-transparent border border-gold/40 text-white px-4 py-2 focus:border-gold focus:outline-none"
            />
          </div>

          {error && (
            <p className="text-red-300 text-sm" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full border border-gold text-gold px-8 py-3 hover:bg-gold hover:text-navy transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default LoginPage
