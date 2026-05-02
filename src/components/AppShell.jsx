import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthProvider'
import AYEBadge from './AYEBadge'

// Sidebar configuration. `enabled: false` items render greyed out and
// are not clickable. `lockKey` ties an item to a module code so the
// lock indicator can light up when that module's instance is locked
// for the current AYE. `subItems` makes an item expandable with nested
// sub-routes.
//
// Two parent-with-children patterns coexist:
//   - Navigable parent (current Admin / School Settings pattern):
//     parent has `to` and `subItems`; clicking the row navigates;
//     clicking the chevron toggles expand. `toggleOnly: true` is NOT
//     set for these.
//   - Toggle-only parent (Planning / Tuition + Budget pattern,
//     architecture §3.2): parent has `subItems` and `toggleOnly: true`,
//     no `to`. Clicking the row toggles expand; navigation happens
//     only via clicking a child. The pattern matches section-header
//     collapse behavior at one level of nesting deeper.
//
// Each labeled section has an explicit `id` used as the localStorage
// key for collapsed-state persistence. Dashboard (label: null) has no
// id because it isn't collapsible.
//
// Budget stage children are SLOTTED dynamically. The Budget module
// supports configurable workflows (Migration 010); each school's
// stages are loaded from `get_module_workflow_stages('budget')` and
// merged into the Budget parent's subItems at runtime. The static
// config below uses {budgetStageSlot: N} markers indicating where
// stages 1, 2, 3... should drop in. Schools with N stages: the first
// N markers are filled; remaining markers vanish; extra stages
// append after the last slot. For Libertas (two stages), markers 1
// and 2 are filled with the Preliminary and Final stages.
//
// Stage child labels strip the trailing " Budget" off the workflow's
// display_name so the parent ("Budget") carries the module name and
// the children carry the stage names ("Preliminary" / "Final"). This
// is a sidebar-render-only transform; other UI surfaces continue to
// read display_name / short_name as canonical per CLAUDE.md.
const NAV_SECTIONS = [
  {
    id: null,
    label: null,
    items: [{ label: 'Dashboard', to: '/dashboard', enabled: true }],
  },
  {
    id: 'governance',
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
    id: 'operations',
    label: 'Operations',
    items: [
      { label: 'Head of School Report', to: '#', enabled: false },
      { label: 'Strategic Plan', to: '#', enabled: false },
      { label: 'Operations Policies', to: '#', enabled: false },
      { label: 'Documents', to: '#', enabled: false },
    ],
  },
  {
    id: 'planning',
    label: 'Planning',
    items: [
      { label: 'Enrollment Estimator', to: '/modules/enrollment', enabled: false, lockKey: 'enrollment_estimator' },
      // Tuition collapsible parent. Today only the Planning child has
      // an implemented destination; the Audit child appears when
      // Phase 4d (Tuition Stage 2 setup) ships. Architecture §7.3
      // commits to both stages.
      {
        label: 'Tuition',
        toggleOnly: true,
        enabled: true,
        lockKey: 'tuition_worksheet',
        subItems: [
          { label: 'Planning', to: '/modules/tuition', enabled: true },
          // { label: 'Audit', to: '/modules/tuition/audit', enabled: true } — Phase 4 follow-on
        ],
      },
      { label: 'Staffing', to: '/modules/staffing', enabled: false, lockKey: 'staffing' },
      // Budget collapsible parent. Both stage children render today via
      // the budgetStageSlot resolver below; their labels are derived
      // from the workflow loader (display_name with " Budget" stripped).
      {
        label: 'Budget',
        toggleOnly: true,
        enabled: true,
        lockKey: 'budget',
        subItems: [
          { budgetStageSlot: 1 },
          { budgetStageSlot: 2 },
        ],
      },
    ],
  },
  {
    id: 'actuals',
    label: 'Actuals',
    items: [
      // Both items are placeholder/future. Advancement is Phase 5; Cash Flow is
      // Phase 9+. Per the user's design call, both render in the disabled state
      // until the actual modules ship — no point being clickable when there's
      // nothing useful behind the click.
      { label: 'Advancement', to: '/modules/advancement', enabled: false },
      { label: 'Cash Flow',   to: '/modules/cash-flow',   enabled: false },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    adminOnly: true,
    items: [
      { label: 'Academic Years',  to: '/admin/ayes', enabled: true },
      { label: 'Users & Access',  to: '#',           enabled: false },
      {
        label: 'School Settings',
        to: '/admin/settings',
        enabled: true,
        subItems: [
          { label: 'Organization',         to: '/admin/settings/organization',         enabled: true },
          { label: 'Brand',                to: '/admin/settings/brand',                enabled: true },
          { label: 'Financial',            to: '/admin/settings/financial',            enabled: true },
          { label: 'Module Configuration', to: '/admin/settings/module-configuration', enabled: true },
        ],
      },
    ],
  },
]

const COLLAPSED_STORAGE_KEY = 'agora.sidebar.collapsedSections'

// Read the persisted collapsed-section IDs from localStorage. Returns a Set
// of section IDs that should render collapsed on first paint.
function loadCollapsedFromStorage() {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed)
  } catch {
    return new Set()
  }
}

// Find the section ID whose items contain the given pathname. Returns null
// if no section matches (e.g., on /dashboard which has no labeled section).
//
// Dynamic routes (currently /modules/budget/<stage-uuid>) aren't in
// NAV_SECTIONS — they're filled at runtime by the workflow loader. Match
// those by URL prefix here so route changes auto-expand the right section
// even before the workflow data has loaded.
function findSectionForPath(pathname) {
  if (pathname.startsWith('/modules/budget/')) return 'planning'
  for (const section of NAV_SECTIONS) {
    if (!section.id) continue
    for (const item of section.items) {
      if (item.to && item.to !== '#' && (pathname === item.to || pathname.startsWith(item.to + '/'))) {
        return section.id
      }
      if (item.subItems) {
        for (const sub of item.subItems) {
          if (sub.to && sub.to !== '#' && (pathname === sub.to || pathname.startsWith(sub.to + '/'))) {
            return section.id
          }
        }
      }
    }
  }
  return null
}

const baseClasses =
  'flex items-center gap-2.5 px-4 py-[7px] text-[13px] border-l-2 font-body'

function NavRow({ item, depth = 0, active, locked, onClick, onChevronClick, expanded }) {
  // Inner content shared by all nav-row variants. `depth` shifts left padding
  // for sub-items.
  const inner = (
    <>
      {item.subItems ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onChevronClick?.()
          }}
          className="w-4 text-gold/70 text-[10px] leading-none cursor-pointer"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span className="font-display text-[10px] text-gold min-w-[14px]">
          {item.step ?? ''}
        </span>
      )}
      <span className="flex-1 truncate">{item.label}</span>
      {locked && (
        <span className="text-gold/70 text-[10px] leading-none" aria-label="Locked">
          ●
        </span>
      )}
    </>
  )

  // Indent depth shows sub-item nesting via extra left padding.
  const indentStyle = depth > 0 ? { paddingLeft: `${16 + depth * 16}px` } : undefined

  if (!item.enabled) {
    return (
      <div className={`${baseClasses} border-transparent text-white/30 cursor-default select-none`} style={indentStyle}>
        {inner}
      </div>
    )
  }

  // Toggle-only parent: clicking the row toggles expand/collapse, no
  // navigation. Architecture §3.2 — children own navigation; parent
  // owns the section grouping. Render as a button for keyboard
  // accessibility and aria-expanded semantics.
  if (item.toggleOnly && item.subItems) {
    return (
      <button
        type="button"
        onClick={onChevronClick}
        aria-expanded={expanded}
        className={`${baseClasses} w-full text-left border-transparent text-white/70 hover:text-white hover:bg-white/[0.04] transition-colors`}
        style={indentStyle}
      >
        {inner}
      </button>
    )
  }

  if (active) {
    return (
      <div className={`${baseClasses} border-gold bg-gold/[0.10] text-white`} style={indentStyle}>
        {/* Wrap navigable parents in a Link even when active so the parent stays clickable */}
        <Link to={item.to} className="contents" onClick={onClick}>
          {inner}
        </Link>
      </div>
    )
  }

  return (
    <Link
      to={item.to}
      onClick={onClick}
      className={`${baseClasses} border-transparent text-white/70 hover:text-white hover:bg-white/[0.04] transition-colors`}
      style={indentStyle}
    >
      {inner}
    </Link>
  )
}

function NavItem({ item, lockedCodes }) {
  const { pathname } = useLocation()

  // Auto-expand when current path is the parent or any of its descendants.
  const matchesSubItem = item.subItems?.some(
    (s) => pathname === s.to || pathname.startsWith(s.to + '/')
  )
  const matchesSelf = pathname === item.to
  const initiallyExpanded = !!(matchesSubItem || matchesSelf)

  const [expanded, setExpanded] = useState(initiallyExpanded)

  // If the user navigates to a sub-route by other means, keep the section open.
  useEffect(() => {
    if (matchesSubItem || matchesSelf) setExpanded(true)
  }, [matchesSubItem, matchesSelf])

  const active = item.enabled && pathname === item.to
  const locked = item.lockKey && lockedCodes.has(item.lockKey)

  if (!item.subItems) {
    return <NavRow item={item} active={active} locked={locked} />
  }

  return (
    <>
      <NavRow
        item={item}
        active={active}
        locked={locked}
        expanded={expanded}
        onChevronClick={() => setExpanded((v) => !v)}
      />
      {expanded && item.subItems.map((sub, idx) => {
        const subActive = sub.enabled && pathname === sub.to
        // Slot-resolved children carry a stable _slotKey so the React
        // identity survives across the async workflow load (placeholder
        // and resolved label share the same slot key). Other children
        // key off label.
        return (
          <NavRow
            key={sub._slotKey || `${sub.label}-${idx}`}
            item={sub}
            depth={1}
            active={subActive}
            locked={false}
          />
        )
      })}
    </>
  )
}

// Top-level category header. Acts as a button that toggles the section's
// collapsed state. Both the chevron and the label are click targets.
function SectionHeader({ id, label, expanded, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={`section-body-${id}`}
      className="w-full flex items-center gap-2 font-display text-[14px] tracking-[0.14em] text-gold/75 uppercase px-4 mt-[18px] mb-2 hover:text-gold transition-colors text-left"
    >
      {/* Chevron rotates 0deg expanded, -90deg collapsed. Single character
          + transform avoids layout shifts that two glyphs would cause. */}
      <span
        className="inline-block text-[10px] text-gold/70 leading-none transition-transform duration-200"
        style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        aria-hidden="true"
      >
        ▼
      </span>
      <span className="flex-1">{label}</span>
    </button>
  )
}

function AppShell({ children }) {
  const { user, profile } = useAuth()
  const { pathname } = useLocation()
  const [aye, setAye] = useState(null)
  const [lockedCodes, setLockedCodes] = useState(new Set())

  // Workflow stages for the Budget module. Loaded from
  // get_module_workflow_stages('budget') on mount; used to fill the
  // budgetStageSlot markers in NAV_SECTIONS. While loading, slot
  // positions render as disabled placeholders so the layout stays
  // stable on first paint.
  const [budgetStages, setBudgetStages] = useState([])

  // Top-level section collapse state. Default: all expanded (empty Set).
  // Hydrated from localStorage on first render.
  const [collapsedSections, setCollapsedSections] = useState(() =>
    loadCollapsedFromStorage()
  )

  // Persist collapse state on every change.
  useEffect(() => {
    try {
      localStorage.setItem(
        COLLAPSED_STORAGE_KEY,
        JSON.stringify([...collapsedSections])
      )
    } catch {
      // localStorage unavailable (private browsing, etc.) — silently ignore.
    }
  }, [collapsedSections])

  // Auto-expand the section containing the current route. Runs on every
  // pathname change, so deep-links and back-navigation both surface the
  // user's location.
  useEffect(() => {
    const sectionId = findSectionForPath(pathname)
    if (!sectionId) return
    setCollapsedSections((prev) => {
      if (!prev.has(sectionId)) return prev
      const next = new Set(prev)
      next.delete(sectionId)
      return next
    })
  }, [pathname])

  function toggleSection(id) {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Load current AYE + locked module instances + budget workflow stages
  // in parallel. The three calls are independent of each other; running
  // them together keeps first-paint snappy.
  useEffect(() => {
    let mounted = true
    async function load() {
      const [ayeResult, stagesResult] = await Promise.all([
        supabase
          .from('academic_years')
          .select('id, label, module_instances(state, modules(code))')
          .eq('is_current', true)
          .maybeSingle(),
        supabase.rpc('get_module_workflow_stages', { p_module_code: 'budget' }),
      ])

      if (!mounted) return

      if (!ayeResult.data) {
        setAye(null)
        setLockedCodes(new Set())
      } else {
        setAye({ id: ayeResult.data.id, label: ayeResult.data.label })
        const locked = new Set()
        for (const mi of ayeResult.data.module_instances || []) {
          if (mi.state === 'locked' && mi.modules?.code) {
            locked.add(mi.modules.code)
          }
        }
        setLockedCodes(locked)
      }

      // Workflow stages — silently fall back to empty list on failure
      // (the slot markers will render as "Pending workflow" placeholders).
      if (!stagesResult.error && stagesResult.data) {
        setBudgetStages(stagesResult.data)
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [])

  // Merge static NAV_SECTIONS with dynamic budget workflow stages. Slot
  // markers ({budgetStageSlot: N}) live inside the Budget parent's
  // subItems (planning section). Each marker is replaced with the Nth
  // stage in the workflow's sort_order, OR rendered as a disabled
  // placeholder when the workflow has fewer stages than slots. Extra
  // stages beyond the last slot append after the last child.
  //
  // Stage child label is derived from display_name with the trailing
  // " Budget" stripped. Parent ("Budget") carries the module name;
  // children ("Preliminary" / "Final") carry the stage names. For
  // schools whose display_name does not suffix with " Budget", the
  // strip is a no-op and the original label renders.
  function deriveBudgetStageLabel(stage) {
    const source = stage.display_name || stage.short_name || ''
    return source.replace(/\s*Budget$/i, '').trim() || stage.short_name || '—'
  }

  function fillBudgetSlots(parentItem) {
    const filled = []
    let highestSlot = 0
    for (const sub of parentItem.subItems) {
      if (typeof sub.budgetStageSlot === 'number') {
        highestSlot = Math.max(highestSlot, sub.budgetStageSlot)
        const stage = budgetStages[sub.budgetStageSlot - 1]
        if (stage) {
          filled.push({
            label: deriveBudgetStageLabel(stage),
            to: `/modules/budget/${stage.stage_id}`,
            enabled: true,
            // Stage-level lock indicator deferred — module_instances
            // is per-module, not per-stage. Phase R2 wires real
            // per-stage lock indicators from budget_stage_scenarios.
            lockKey: null,
            // Stable key: the slot number survives across renders even
            // while the async workflow load is in flight (placeholder
            // and resolved label both share the slot).
            _slotKey: `slot-${sub.budgetStageSlot}`,
          })
        } else {
          // Workflow has fewer stages than slots — render disabled
          // placeholder so the slot stays present during async load.
          filled.push({
            label: '—',
            to: '#',
            enabled: false,
            lockKey: null,
            _slotKey: `slot-${sub.budgetStageSlot}`,
          })
        }
      } else {
        filled.push(sub)
      }
    }
    // Extra stages (beyond the static slots) append after the last
    // declared child.
    for (let i = highestSlot; i < budgetStages.length; i++) {
      const stage = budgetStages[i]
      filled.push({
        label: deriveBudgetStageLabel(stage),
        to: `/modules/budget/${stage.stage_id}`,
        enabled: true,
        lockKey: null,
        _slotKey: `slot-extra-${i}`,
      })
    }
    return { ...parentItem, subItems: filled }
  }

  const navSections = NAV_SECTIONS.map((section) => {
    if (section.id !== 'planning') return section
    return {
      ...section,
      items: section.items.map((item) =>
        item.label === 'Budget' && item.subItems ? fillBudgetSlots(item) : item
      ),
    }
  })

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
            {navSections.map((section, sIdx) => {
              if (section.adminOnly && !profile?.is_system_admin) return null
              const isCollapsible = !!section.id
              const expanded =
                isCollapsible ? !collapsedSections.has(section.id) : true

              return (
                <div key={section.id ?? `top-${sIdx}`}>
                  {section.label ? (
                    <SectionHeader
                      id={section.id}
                      label={section.label}
                      expanded={expanded}
                      onToggle={() => toggleSection(section.id)}
                    />
                  ) : (
                    <div className="mt-1" />
                  )}
                  {/* Collapsible body. grid-template-rows transitions from 0fr
                      → 1fr animate height changes without measuring content.
                      Inner overflow-hidden clips children mid-transition. */}
                  {isCollapsible ? (
                    <div
                      id={`section-body-${section.id}`}
                      className="grid transition-all duration-200 ease-out"
                      style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
                    >
                      <div className="overflow-hidden">
                        {section.items.map((item, idx) => (
                          // Stable key strategy: section id + index + label.
                          // Index is the primary disambiguator (handles
                          // duplicate labels across sections); label is the
                          // tiebreaker for clarity in React DevTools.
                          <NavItem
                            key={`${section.id}-${idx}-${item.label}`}
                            item={item}
                            lockedCodes={lockedCodes}
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    section.items.map((item, idx) => (
                      <NavItem
                        key={`top-${idx}-${item.label}`}
                        item={item}
                        lockedCodes={lockedCodes}
                      />
                    ))
                  )}
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
