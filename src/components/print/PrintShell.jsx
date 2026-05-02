import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSchoolName } from '../../lib/schoolConfig'
import './print.css'

// Shared layout shell for every /print/... route.
//
// On screen the shell renders:
//   - A clean preview chrome bar (cream-highlight surface): "← Back to
//     budget" link on the left, "Print" button on the right. The
//     document title is NOT in the chrome — it lives inside the document
//     itself. Hidden during actual print via .no-print.
//   - The document body with the school's full horizontal letterhead.
//
// On print the shell renders:
//   - First-page letterhead: full horizontal color logo (top-left) +
//     document title block (top-right) on every first page
//   - Subsequent-page running header: smaller text-only header with
//     document title and "page N of M" — the full-bleed horizontal logo
//     would be too heavy to repeat on every page
//   - Running footer (page number) via @page CSS counter
//   - Approved-by / "preliminary working version" block at end of document
//   - Diagonal "DRAFT" watermark when `draft = true`
//
// On mount: PrintShell auto-fires window.print() once. If the user
// dismisses the dialog, the page stays put with a "Print" button in
// the chrome bar.
//
// Props:
//   title         — document title rendered in the letterhead
//                   (e.g., "AYE 2026 Preliminary Budget")
//   subtitle      — optional second-line subtitle. Accepts string OR
//                   React node so callers can style fragments (e.g.,
//                   highlight a "— DRAFT" suffix).
//   draft         — boolean; when true, render watermark + DRAFT header
//                   banner + (in non-compact mode) "preliminary working
//                   version" footer note
//   draftLabel    — text rendered in the small DRAFT banner across the
//                   top of every page (e.g., "DRAFT — Pending Lock Review")
//   approvedNote  — when locked: an object {locked_at, locked_by_name,
//                   snapshot_id, override_justification?} rendered as a
//                   small footer block
//   schoolName    — for the running footer
//   generatedAt   — Date object captured at render time
//   generatedByName — full name of the printing user
//   compact       — when true (audit log PDFs, v3.6.1):
//                     · the header "Generated [date] at [time] by [name]"
//                       line is suppressed (caller carries DRAFT in
//                       subtitle instead)
//                     · the footer "Preliminary working version..."
//                       sentence is suppressed
//                     · the footer attribution line expands to include
//                       time + generator name
//                   When false (Operating Budget Detail and similar
//                   primary-record PDFs): existing header + footer
//                   structure preserved.
//   children      — body content
//   backTo        — path to navigate to on Back click
//   backLabel     — link label (default "Back to budget")
export default function PrintShell({
  title,
  subtitle,
  draft = false,
  draftLabel,
  approvedNote = null,
  schoolName = getSchoolName(),
  generatedAt,
  generatedByName,
  compact = false,
  children,
  backTo = '/dashboard',
  backLabel = 'Back to budget',
}) {
  const navigate = useNavigate()
  const printedRef = useRef(false)

  // Auto-fire print dialog once after content mounts. Wrapped in a small
  // setTimeout so React commits the layout and the browser renders fonts
  // before the dialog snapshots the page (Cinzel + EB Garamond load via
  // Google Fonts, so on a cold cache the first paint can still be using
  // the fallback serif).
  useEffect(() => {
    if (printedRef.current) return
    printedRef.current = true
    const id = setTimeout(() => {
      try { window.print() } catch (_e) { /* Silently ignore — user can
        click Print. */ }
    }, 300)
    return () => clearTimeout(id)
  }, [])

  function reprint() {
    try { window.print() } catch (_e) { /* ignore */ }
  }

  const generated = generatedAt || new Date()
  const generatedDateStr = generated.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
  const generatedTimeStr = generated.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
  })

  return (
    // Outer wrap uses cream-highlight on screen so the white document
    // surface inside reads as a distinct artifact (the "page"). In
    // print, the @media print rules in print.css revert this to white.
    <div className="print-page bg-cream-highlight min-h-screen">
      {/* On-screen-only preview chrome. Single line: Back link, Print
          button. Document title is intentionally NOT here — it belongs
          inside the document. The bar styling lives in print.css under
          .print-preview-chrome so the @media print suppression rule
          can reliably target the same selector. */}
      <div className="print-preview-chrome no-print">
        <button
          type="button"
          onClick={() => navigate(backTo)}
          className="print-preview-back-link"
        >
          ← {backLabel}
        </button>
        <button
          type="button"
          onClick={reprint}
          className="print-preview-print-button"
        >
          Print
        </button>
      </div>

      {/* DRAFT diagonal watermark — fixed position so it sits behind
          every printed page. The browser repeats position:fixed
          elements per printed page when @page is active. */}
      {draft && (
        <div aria-hidden="true" className="print-watermark">
          DRAFT
        </div>
      )}

      {/* Per-page running header. Renders on screen as a thin band at
          the top of each "page" preview; in print, the browser repeats
          fixed-position elements per page. We use a text-based header
          for subsequent pages — the full horizontal logo would be too
          heavy to repeat on every page. The fixed-position header is
          present on EVERY page including the first; the first page's
          letterhead sits below it. */}
      <div className="print-running-header" aria-hidden="true">
        <span className="print-running-header-title">{title}</span>
        {draft && draftLabel && (
          <span className="print-running-header-draft"> · {draftLabel}</span>
        )}
      </div>

      {/* Document body. Surface is white inside the cream-highlight
          screen wrap; in print the cream-highlight is suppressed. */}
      <article className="print-document bg-white max-w-[7.5in] mx-auto my-6 px-10 py-10 shadow-sm">
        <header className="print-letterhead pb-3 mb-4 border-b-[1px] border-navy/40">
          {/* Letterhead row uses items-start (NOT items-center, NOT
              items-stretch) so the image's intrinsic aspect ratio is
              preserved. align-items: stretch in flex would force the
              image to fill the row's computed height — which combined
              with a fixed width would distort the wordmark. */}
          <div className="flex items-start justify-between gap-6">
            {/* Full horizontal color logo on the first page. Width is
                set explicitly; height is auto so the browser computes
                it from the image's intrinsic aspect ratio. NO fixed
                height anywhere in the chain — that was the cause of
                the wordmark vertical compression in the previous pass.
                The print stylesheet preserves aspect ratio defensively
                with object-fit: contain. */}
            <img
              src="/logo-horizontal-color.png"
              alt={schoolName}
              className="print-logo"
              style={{ width: '220px', height: 'auto' }}
            />
            <div className="text-right">
              <h1 className="font-display text-navy text-[22px] leading-tight">
                {title}
              </h1>
              {subtitle && (
                <p className="font-body italic text-muted text-[13px]" style={{ marginTop: '4pt' }}>
                  {subtitle}
                </p>
              )}
              {/* Header generation line. Suppressed in compact mode
                  (audit log PDFs, v3.6.1) — that attribution moves to
                  the footer where it reads as document metadata
                  rather than competing for the subtitle's place. */}
              {!compact && (
                <p className="font-body text-[10px] text-muted tracking-wider uppercase" style={{ marginTop: '4pt' }}>
                  Generated {generatedDateStr} at {generatedTimeStr}
                  {generatedByName ? ` by ${generatedByName}` : ''}
                </p>
              )}
            </div>
          </div>
        </header>

        <div className="print-body">{children}</div>

        <footer className="print-footer mt-10 pt-4 border-t-[0.5px] border-navy/30 text-[10px] text-muted">
          {/* Verbose draft footnote — shown only on non-compact PDFs
              (Operating Budget Detail). Compact mode (audit logs)
              carries DRAFT in the header subtitle instead, so the
              footnote here would be redundant. */}
          {draft && !compact && (
            <p className="italic mb-1">
              Preliminary working version, subject to change. Generated{' '}
              {generatedDateStr}. Not for distribution.
            </p>
          )}
          {approvedNote && (
            <div className="font-body text-navy">
              <p>
                Approved {approvedNote.locked_at_display} by{' '}
                {approvedNote.locked_by_name || 'unknown user'}. Snapshot
                ID: {approvedNote.snapshot_id}.
              </p>
              {approvedNote.override_justification && (
                <p className="text-muted italic mt-1">
                  Override justification: "{approvedNote.override_justification}"
                </p>
              )}
            </div>
          )}
          {/* Footer attribution line. In compact mode (audit log
              PDFs) the header omits generation metadata, so this
              footer line carries the full attribution: school +
              date + time + generator name. In non-compact mode
              (Operating Budget Detail) the full attribution lives
              in the header; this line keeps its date-only form to
              avoid duplication. */}
          <p className="mt-1">
            {schoolName} · Generated {generatedDateStr}
            {compact && (
              <>
                {' '}at {generatedTimeStr}
                {generatedByName ? ` by ${generatedByName}` : ''}
              </>
            )}
          </p>
        </footer>
      </article>
    </div>
  )
}
