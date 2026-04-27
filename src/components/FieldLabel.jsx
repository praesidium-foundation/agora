// Small-caps muted label for form fields. Matches the AYE Management
// "PARENT" / "START DATE" pattern. Use as a sibling above each input.
function FieldLabel({ htmlFor, children, className = '' }) {
  return (
    <label
      htmlFor={htmlFor}
      className={`block font-body text-[11px] text-muted uppercase tracking-wider mb-1.5 ${className}`}
    >
      {children}
    </label>
  )
}

export default FieldLabel
