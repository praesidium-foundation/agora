import { useEffect, useState } from 'react'

// Scenario tab bar rendered in the page header zone. One tab per
// budget_stage_scenarios row for the active (AYE, Stage), plus a final
// "+ New scenario" tile.
//
// Each tab shows: scenario_label, optional ★ for is_recommended, and a
// compact kebab menu (visible on hover or when active) with:
//   - Rename
//   - Edit description
//   - Mark as recommended (only one per AYE — toggling on a different
//     scenario unmarks the previously-marked one; handled by parent)
//   - Delete (confirmation; disabled when state != 'drafting')
//
// Props:
//   scenarios       — full list of scenarios for the active AYE
//   activeId        — currently selected scenario id
//   onSelect(id)    — switch active
//   onAdd()         — open the New Scenario modal
//   onAction(id, action) — emit a tab action: 'rename' | 'description'
//                          | 'recommend' | 'delete'
//   canEdit         — gates Add + the kebab menu (read-only users see
//                     tabs but no actions)

function ScenarioTabs({ scenarios, activeId, onSelect, onAdd, onAction, canEdit }) {
  return (
    <div
      role="tablist"
      aria-label="Scenarios"
      className="flex items-end gap-1 flex-wrap"
    >
      {scenarios.map((s) => (
        <ScenarioTab
          key={s.id}
          scenario={s}
          active={s.id === activeId}
          onSelect={() => onSelect(s.id)}
          onAction={(action) => onAction(s.id, action)}
          canEdit={canEdit}
        />
      ))}
      {canEdit && (
        <button
          type="button"
          onClick={onAdd}
          className="ml-1 px-3 py-1.5 font-body text-[13px] text-status-blue hover:underline"
        >
          + New scenario
        </button>
      )}
    </div>
  )
}

function ScenarioTab({ scenario, active, onSelect, onAction, canEdit }) {
  const [menuOpen, setMenuOpen] = useState(false)

  // Outside-click close. Window-level listener is cheap given there's
  // typically a handful of tabs at most.
  useEffect(() => {
    if (!menuOpen) return
    function close() { setMenuOpen(false) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuOpen])

  const isLocked = scenario.state === 'locked' ||
                   scenario.state === 'pending_lock_review' ||
                   scenario.state === 'pending_unlock_review'

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-1.5 border-b-2 -mb-[0.5px] transition-colors ${
          active
            ? 'border-gold'
            : 'border-transparent hover:border-card-border'
        }`}
      >
        <button
          type="button"
          role="tab"
          aria-selected={active}
          onClick={onSelect}
          className={`px-3 py-1.5 font-body text-[13px] flex items-center gap-1.5 cursor-pointer ${
            active ? 'text-navy' : 'text-muted hover:text-navy'
          }`}
          title={scenario.description || undefined}
        >
          {scenario.is_recommended && (
            <span
              className="text-gold text-[12px] leading-none"
              aria-label="Recommended scenario"
              title="Recommended scenario"
            >
              ★
            </span>
          )}
          <span className="truncate max-w-[160px]">
            {scenario.scenario_label}
          </span>
        </button>

        {canEdit && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            aria-label={`Actions for ${scenario.scenario_label}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={`px-1.5 py-1 text-[14px] leading-none rounded transition-opacity ${
              active
                ? 'text-muted hover:text-navy hover:bg-cream-highlight'
                : 'opacity-0 hover:opacity-100 focus:opacity-100 group-hover:opacity-100 text-muted hover:bg-cream-highlight'
            }`}
          >
            ⋮
          </button>
        )}
      </div>

      {menuOpen && (
        // Dropdown anchors to the LEFT edge of the kebab and extends
        // right. The earlier `right-0` placement extended left, which
        // for the typical leftmost scenario tab pushed the dropdown
        // past the page's left edge and into the nav sidebar's space —
        // visible as clipped fragments. left-0 keeps the dropdown
        // within the page content. z-50 layers above the sticky
        // header (z-20) and the KPI sidebar (no explicit z), so the
        // dropdown is never clipped by other UI.
        <div
          onClick={(e) => e.stopPropagation()}
          role="menu"
          className="absolute left-0 top-full mt-1 w-56 bg-white border-[0.5px] border-card-border rounded-[8px] shadow-lg z-50 py-1"
        >
          {/* Recommended toggle pinned to the top with a star icon —
              recommendation is the most consequential action and
              the gate for the lock workflow (Section 8.9). */}
          {!scenario.is_recommended ? (
            <MenuItem
              onClick={() => { setMenuOpen(false); onAction('recommend') }}
              icon={<span className="text-gold text-[12px]">★</span>}
            >
              Mark as recommended
            </MenuItem>
          ) : (
            <MenuItem
              disabled
              icon={<span className="text-gold text-[12px]">★</span>}
            >
              Recommended scenario
            </MenuItem>
          )}
          <div className="border-t-[0.5px] border-card-border my-1" />
          <MenuItem
            onClick={() => { setMenuOpen(false); onAction('rename') }}
          >
            Rename…
          </MenuItem>
          <MenuItem
            onClick={() => { setMenuOpen(false); onAction('description') }}
          >
            Edit description…
          </MenuItem>
          <div className="border-t-[0.5px] border-card-border my-1" />
          <MenuItem
            danger
            onClick={() => { setMenuOpen(false); onAction('delete') }}
            disabled={isLocked}
            title={isLocked ? 'Locked scenarios cannot be deleted' : undefined}
          >
            Delete scenario…
          </MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({ children, onClick, disabled, danger, icon, title }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`w-full text-left px-4 py-2 font-body text-sm transition-colors ${
        disabled
          ? 'text-muted/50 cursor-not-allowed'
          : danger
            ? 'text-status-red hover:bg-status-red-bg'
            : 'text-body hover:bg-cream-highlight'
      }`}
    >
      <span className="flex items-center gap-2">
        {icon && <span className="flex-shrink-0">{icon}</span>}
        <span>{children}</span>
      </span>
    </button>
  )
}

export default ScenarioTabs
