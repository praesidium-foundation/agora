// Gold-bordered AYE pill for the header. Match to .la-aye-badge in
// design-reference.html.
function AYEBadge({ label }) {
  if (!label) return null
  return (
    <div
      className="font-display text-[11px] text-gold tracking-[0.08em] rounded px-2.5 py-[3px]"
      style={{
        backgroundColor: 'rgba(215,191,103,0.15)',
        border: '0.5px solid rgba(215,191,103,0.6)',
      }}
    >
      {label}
    </div>
  )
}

export default AYEBadge
