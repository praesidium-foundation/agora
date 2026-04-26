// Pill chip with colored dot. Used on dashboard status bar to show per-module
// state across the AYE workflow. Match to .la-chip variants in design-reference.html.
const VARIANTS = {
  done:    { bg: '#eaf3de', border: '#3B6D11', text: '#27500A', dot: '#3B6D11', dotOpacity: 1 },
  lock:    { bg: '#f5f0e0', border: '#D7BF67', text: '#192A4F', dot: '#D7BF67', dotOpacity: 1 },
  active:  { bg: '#e6f1fb', border: '#185FA5', text: '#0C447C', dot: '#185FA5', dotOpacity: 1 },
  pending: { bg: '#FAFAF7', border: '#E5E0D5', text: '#6B7280', dot: '#6B7280', dotOpacity: 0.4 },
}

function StatusChip({ variant = 'pending', children }) {
  const v = VARIANTS[variant] || VARIANTS.pending
  return (
    <div
      className="inline-flex items-center gap-[5px] px-[10px] py-1 rounded-[20px] text-xs"
      style={{
        backgroundColor: v.bg,
        border: `0.5px solid ${v.border}`,
        color: v.text,
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: v.dot, opacity: v.dotOpacity }}
      />
      {children}
    </div>
  )
}

export default StatusChip
