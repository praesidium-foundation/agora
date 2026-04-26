import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthProvider'
import AYEBadge from './AYEBadge'

// Sidebar configuration. `enabled: false` items render greyed out and
// are not clickable. `lockKey` ties an item to a module code so the
// lock indicator can light up when that module's instance is locked
// for the current AYE. The first section has no label — Dashboard sits
// at the top alone with extra spacing below.
const NAV_SECTIONS = [
  {
    label: null,
    items: [{ label: 'Dashboard', to: '/dashboard', enabled: true }],
  },
  {
    label: 'Governance',
    items: [
      { label: 'Board Calendar', to: '#', enabled: false },
      { label: 'Monitoring Calendar', to: '#', enabled: false },
      { label: 'Board Policies', to: '#', enabled: false },
      { label: 'Meetings', to: '#', enabled: false },
      { label: 'Documents', to: '#', enabled: false },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Head of School Report', to: '#', enabled: false },
      { label: 'Strategic Plan', to: '#', enabled: false },
      { label: 'Operations Policies', to: '#', enabled: false },
      { label: 'Documents', to: '#', enabled: false },
    ],
  },
  {
    label: 'Budget',
    items: [
      { step: 1, label: 'Enrollment',       to: '/modules/enrollment',          enabled: false, lockKey: 'enrollment_estimator' },
      { step: 2, label: 'Tuition',          to: '/modules/tuition',             enabled: true,  lockKey: 'tuition_worksheet' },
      { step: 3, label: 'Staffing',         to: '/modules/staffing',            enabled: false, lockKey: 'staffing' },
      { step: 4, label: 'Prelim. Budget',   to: '/modules/preliminary-budget',  enabled: false, lockKey: 'preliminary_budget' },
      { step: 5, label: 'Enrollment Audit', to: '/modules/enrollment-audit',    enabled: false, lockKey: 'enrollment_audit' },
      { step: 6, label: 'Final Budget',     to: '/modules/final-budget',        enabled: false, lockKey: 'final_budget' },
    ],
  },
  {
    label: 'Admin',
    adminOnly: true,
    items: [
      { label: 'Academic Years',  to: '/admin/ayes', enabled: true },
      { label: 'Users & Access',  to: '#',           enabled: false },
      { label: 'School Settings', to: '#',           enabled: false },
    ],
  },
]

function NavItem({ item, lockedCodes }) {
  const { pathname } = useLocation()
  const active = item.enabled && pathname === item.to
  const locked = item.lockKey && lockedCodes.has(item.lockKey)

  const inner = (
    <>
      <span className="font-display text-[10px] text-gold min-w-[14px]">
        {item.step ?? ''}
      </span>
      <span className="flex-1 truncate">{item.label}</span>
      {locked && (
        <span className="text-gold/70 text-[10px] leading-none" aria-label="Locked">
          ●
        </span>
      )}
    </>
  )

  const baseClasses =
    'flex items-center gap-2.5 px-4 py-[7px] text-[13px] border-l-2 font-body'

  if (!item.enabled) {
    return (
      <div
        className={`${baseClasses} border-transparent text-white/30 cursor-default select-none`}
      >
        {inner}
      </div>
    )
  }

  if (active) {
    return (
      <div className={`${baseClasses} border-gold bg-gold/[0.10] text-white`}>
        {inner}
      </div>
    )
  }

  return (
    <Link
      to={item.to}
      className={`${baseClasses} border-transparent text-white/70 hover:text-white hover:bg-white/[0.04] transition-colors`}
    >
      {inner}
    </Link>
  )
}

function SectionHeader({ children }) {
  return (
    <div className="font-display text-[14px] tracking-[0.14em] text-gold/75 uppercase px-4 mt-[18px] mb-2">
      {children}
    </div>
  )
}

function AppShell({ children }) {
  const { user, profile } = useAuth()
  const [aye, setAye] = useState(null)
  const [lockedCodes, setLockedCodes] = useState(new Set())

  // Load current AYE + which of its module instances are locked.
  useEffect(() => {
    let mounted = true
    async function load() {
      const { data } = await supabase
        .from('academic_years')
        .select('id, label, module_instances(state, modules(code))')
        .eq('is_current', true)
        .maybeSingle()

      if (!mounted) return

      if (!data) {
        setAye(null)
        setLockedCodes(new Set())
        return
      }

      setAye({ id: data.id, label: data.label })

      const locked = new Set()
      for (const mi of data.module_instances || []) {
        if (mi.state === 'locked' && mi.modules?.code) {
          locked.add(mi.modules.code)
        }
      }
      setLockedCodes(locked)
    }
    load()
    return () => {
      mounted = false
    }
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    // Auth state change → ProtectedRoute will bounce to /login.
  }

  const displayName = profile?.full_name || user?.email || ''

  return (
    <div className="h-screen flex flex-col font-body bg-cream">
      {/* Header (navy chrome) */}
      <header className="h-14 flex-shrink-0 bg-navy flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <img src="/logo-mark-white.png" alt="" className="h-9" />
          <span className="font-display text-[26px] text-gold tracking-[0.08em]">
            Libertas Agora
          </span>
        </div>
        <div className="flex items-center gap-4">
          <AYEBadge label={aye?.label} />
          {displayName && (
            <span className="text-[13px] text-white/60">
              Signed in as <strong className="text-white font-medium">{displayName}</strong>
            </span>
          )}
          <button
            type="button"
            onClick={handleSignOut}
            className="text-[13px] text-gold/80 hover:text-gold"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Body: sidebar + main */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar (navy, matches header) */}
        <aside className="w-[204px] flex-shrink-0 bg-navy flex flex-col">
          <nav className="flex-1 overflow-y-auto py-4">
            {NAV_SECTIONS.map((section, sIdx) => {
              if (section.adminOnly && !profile?.is_system_admin) return null
              return (
                <div key={section.label ?? `top-${sIdx}`}>
                  {section.label ? (
                    <SectionHeader>{section.label}</SectionHeader>
                  ) : (
                    // Dashboard sits alone at top — render its items with
                    // mt-1 baseline; the next section gets its own mt-[18px]
                    // via SectionHeader's margin, providing the extra gap.
                    <div className="mt-1" />
                  )}
                  {section.items.map((item) => (
                    <NavItem
                      key={`${section.label ?? 'top'}-${item.label}`}
                      item={item}
                      lockedCodes={lockedCodes}
                    />
                  ))}
                </div>
              )
            })}
          </nav>
          <div className="font-body italic text-[10px] text-white/30 px-4 py-3 border-t-[0.5px] border-white/[0.08] text-center">
            Agora by Praesidium
          </div>
        </aside>

        {/* Main working area (cream) */}
        <main className="flex-1 overflow-y-auto bg-cream">
          <div className="px-6 py-6">{children}</div>
        </main>
      </div>
    </div>
  )
}

export default AppShell
