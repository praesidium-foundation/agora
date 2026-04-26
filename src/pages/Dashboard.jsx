import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthProvider'
import { useModulePermission } from '../lib/usePermission'

function Dashboard() {
  const navigate = useNavigate()
  const { user, profile } = useAuth()
  const { allowed: canViewTuition } = useModulePermission(
    'tuition_worksheet',
    'view'
  )

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/')
  }

  const greetingName =
    profile?.full_name || user?.email?.split('@')[0] || 'Friend'

  return (
    <div className="min-h-screen bg-navy text-white font-body">
      <header className="border-b border-gold/20 px-6 py-4 flex items-center gap-3">
        <img src="/logo-mark-white.png" alt="" className="h-10" />
        <span className="font-display text-gold text-xl">Libertas Agora</span>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <p className="uppercase tracking-[0.3em] text-gold text-xs mb-2">
          Libertas Academy
        </p>
        <h1 className="font-display text-gold text-4xl md:text-5xl mb-8">
          Welcome, {greetingName}
        </h1>

        <div className="space-y-3 mb-10">
          <p className="text-white/80">
            Signed in as <span className="text-white">{user?.email}</span>
          </p>
          {profile?.is_system_admin && (
            <span className="inline-block border border-gold text-gold px-3 py-1 text-xs uppercase tracking-widest">
              System Admin
            </span>
          )}
        </div>

        {canViewTuition && (
          <div className="mb-6">
            <Link
              to="/modules/tuition"
              className="text-gold hover:text-white underline underline-offset-4"
            >
              Tuition Worksheet →
            </Link>
          </div>
        )}

        {profile?.is_system_admin && (
          <div className="mb-10">
            <Link
              to="/admin/ayes"
              className="text-gold hover:text-white underline underline-offset-4"
            >
              Manage Academic Years →
            </Link>
          </div>
        )}

        <button
          type="button"
          onClick={handleSignOut}
          className="border border-gold text-gold px-6 py-2 hover:bg-gold hover:text-navy transition-colors"
        >
          Sign Out
        </button>
      </main>
    </div>
  )
}

export default Dashboard
