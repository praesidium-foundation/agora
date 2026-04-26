// Small inline badge for table cells / inline labels.
// Match to .la-badge variants in design-reference.html, plus a `red` variant.
const VARIANTS = {
  navy:  { bg: '#192A4F', color: '#D7BF67' },
  green: { bg: '#EAF3DE', color: '#27500A' },
  amber: { bg: '#FAEEDA', color: '#633806' },
  red:   { bg: '#FCEBEB', color: '#6F1F1F' },
}

function Badge({ variant = 'navy', children }) {
  const v = VARIANTS[variant] || VARIANTS.navy
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-[11px]"
      style={{ backgroundColor: v.bg, color: v.color }}
    >
      {children}
    </span>
  )
}

export default Badge
