import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthProvider'
import AppShell from '../components/AppShell'
import Card from '../components/Card'
import Badge from '../components/Badge'

// Format a YYYY-MM-DD string as "July 1, 2026". The +T00:00:00 forces
// local-time interpretation so the day doesn't shift across timezones.
function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function Field({ label, children }) {
  return (
    <div className="flex items-baseline gap-4">
      <span className="font-body text-[11px] text-muted uppercase tracking-wider w-20 flex-shrink-0">
        {label}
      </span>
      <span className="text-body">{children}</span>
    </div>
  )
}

function Dashboard() {
  const { user, profile } = useAuth()
  const [aye, setAye] = useState(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      const { data } = await supabase
        .from('academic_years')
        .select('label, start_date, end_date')
        .eq('is_current', true)
        .maybeSingle()
      if (mounted) setAye(data ?? null)
    }
    load()
    return () => {
      mounted = false
    }
  }, [])

  const greetingName =
    profile?.full_name || user?.email?.split('@')[0] || 'Friend'

  const subtitle = aye
    ? `${aye.label} — Academic year ${formatDate(aye.start_date)} – ${formatDate(aye.end_date)}`
    : null

  return (
    <AppShell>
      <h1 className="font-display text-navy text-[28px] mb-1 leading-tight">
        Welcome, {greetingName}
      </h1>
      {subtitle && (
        <p className="font-body italic text-muted mb-8">{subtitle}</p>
      )}

      <div className="max-w-2xl">
        <Card title="Account">
          <div className="space-y-3">
            <Field label="Email">{user?.email}</Field>
            {profile?.is_system_admin && (
              <Field label="Role">
                <Badge variant="navy">System Admin</Badge>
              </Field>
            )}
          </div>
        </Card>
      </div>
    </AppShell>
  )
}

export default Dashboard
