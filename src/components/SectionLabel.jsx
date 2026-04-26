// Small Cinzel small-caps label with a thin gold underline.
// Used above each major content block on a page (e.g., "KEY METRICS",
// "TUITION", "SCENARIOS") so groupings don't float "naked" on the cream.
function SectionLabel({ children, className = '' }) {
  return (
    <div className={`mb-3 ${className}`}>
      <div className="font-display text-[18px] tracking-[0.10em] uppercase text-navy/55 mb-2">
        {children}
      </div>
      <div className="border-t-[0.5px] border-gold/60" />
    </div>
  )
}

export default SectionLabel
