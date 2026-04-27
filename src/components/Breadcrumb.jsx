import { Link } from 'react-router-dom'

// Page-level breadcrumb. Renders a left arrow plus a "/"-separated trail
// of crumb labels. The arrow navigates one level up (to the most recent
// crumb that has a `to`, or to /dashboard if none does). Crumbs with a
// `to` are clickable; the last crumb is the current page and renders
// non-clickable, slightly more muted than the rest.
//
// items: [
//   { label: 'Admin' },                             // section, non-clickable
//   { label: 'Settings', to: '/admin/settings' },   // clickable parent
//   { label: 'Financial' },                         // current page
// ]
function Breadcrumb({ items }) {
  if (!items || items.length === 0) return null

  // Find back target: walk back from current page to the most recent
  // crumb that has a `to`. If none exist, fall back to /dashboard.
  let backTarget = '/dashboard'
  for (let i = items.length - 2; i >= 0; i--) {
    if (items[i].to) {
      backTarget = items[i].to
      break
    }
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-2 text-[13px] mb-4 flex-wrap"
    >
      <Link
        to={backTarget}
        aria-label="Back"
        className="text-navy hover:opacity-70 text-[18px] leading-none mr-1 -mt-px"
      >
        ←
      </Link>
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1
        return (
          <span key={idx} className="flex items-center gap-2">
            {idx > 0 && <span className="text-muted/50" aria-hidden="true">/</span>}
            {!isLast && item.to ? (
              <Link to={item.to} className="text-muted hover:underline">
                {item.label}
              </Link>
            ) : (
              <span
                className={isLast ? 'text-muted/70' : 'text-muted'}
                aria-current={isLast ? 'page' : undefined}
              >
                {item.label}
              </span>
            )}
          </span>
        )
      })}
    </nav>
  )
}

export default Breadcrumb
