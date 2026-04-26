// Horizontal tab navigation for record pages.
// Active tab: navy text + 2px gold bottom border. Inactive: muted text.
// Uses Cinzel per design reference (.la-scen-tab).
function Tabs({ tabs, activeId, onChange }) {
  return (
    <div className="flex border-b-[0.5px] border-card-border">
      {tabs.map((tab) => {
        const active = tab.id === activeId
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`px-4 py-[7px] font-display text-[14px] tracking-[0.04em] cursor-pointer border-b-2 -mb-[0.5px] transition-colors ${
              active
                ? 'text-navy border-gold'
                : 'text-muted border-transparent hover:text-navy/80'
            }`}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

export default Tabs
