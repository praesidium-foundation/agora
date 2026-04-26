// White card with optional header (uppercase Cinzel small-caps title +
// right-aligned action node, typically a blue text link). When a header
// is present, a 0.5px divider separates it from the content.
function Card({ title, action, children, className = '' }) {
  const hasHeader = title || action
  return (
    <div
      className={`bg-white border-[0.5px] border-card-border rounded-[10px] px-5 py-[18px] ${className}`}
    >
      {hasHeader && (
        <div className="flex items-center justify-between pb-3 mb-4 border-b-[0.5px] border-card-border">
          {title ? (
            <span className="font-display text-[13px] text-navy tracking-[0.08em] uppercase font-normal">
              {title}
            </span>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
      {children}
    </div>
  )
}

export default Card
