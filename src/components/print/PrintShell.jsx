import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import './print.css'

// Shared layout shell for every /print/... route.
//
// On screen the shell renders:
//   - A top toolbar (Print, Back) — hidden during actual print
//   - The document body with the school's letterhead
//
// On print the shell renders:
//   - The letterhead (logo + title + generation timestamp) at the top of
//     the first page
//   - The body content
//   - A running header (date + document title) repeated on every page
//     via @page rules in print.css
//   - A running footer (page N of M, school name, generation date)
//   - A diagonal "DRAFT" watermark when `draft = true`
//
// On mount: PrintShell auto-fires window.print() once. If the user
// dismisses the dialog, the page stays put with a "Print again" button
// in the on-screen toolbar.
//
// Props:
//   title        — document title rendered in the letterhead
//                  (e.g., "AYE 2026 Preliminary Budget")
//   subtitle     — optional second-line subtitle (scenario name, etc.)
//   draft        — boolean; when true, render watermark + DRAFT header
//                  banner + "preliminary working version" footer note
//   draftLabel   — text rendered in the small DRAFT banner across the
//                  top of every page (e.g., "DRAFT — Pending Lock Review")
//   approvedNote — when locked: an object {locked_at, locked_by_name,
//                  snapshot_id, override_justification?} rendered as a
//                  small footer block on every page
//   schoolName   — for the running footer
//   generatedAt  — Date object captured at render time
//   generatedByName — full name of the printing user
//   children     — body content
//   backTo       — path to navigate to on Back click
export default function PrintShell({
  title,
  subtitle,
  draft = false,
  draftLabel,
  approvedNote = null,
  schoolName = 'Libertas Academy',
  generatedAt,
  generatedByName,
  children,
  backTo = '/dashboard',
}) {
  const navigate = useNavigate()
  const printedRef = useRef(false)

  // Auto-fire print dialog once after content mounts. Wrapped in a small
  // setTimeout so React commits the layout and the browser renders fonts
  // before the dialog snapshots the page (Cinzel + EB Garamond are
  // loaded via Google Fonts, so on a cold cache the first paint can
  // still be using the fallback serif).
  useEffect(() => {
    if (printedRef.current) return
    printedRef.current = true
    const id = setTimeout(() => {
      try { window.print() } catch (_e) { /* Silently ignore — user can
        click Print again. */ }
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
    <div className="print-page bg-white text-body min-h-screen">
      {/* On-screen-only toolbar. Hidden in print via .no-print. */}
      <div className="no-print sticky top-0 z-10 bg-cream border-b-[0.5px] border-card-border px-6 py-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => navigate(backTo)}
          className="font-body text-sm text-muted hover:text-navy"
        >
          ← Back
        </button>
        <span className="font-display text-navy text-[14px]">
          Print preview — {title}
        </span>
        <button
          type="button"
          onClick={reprint}
          className="bg-navy text-gold border-[0.5px] border-navy px-4 py-1.5 rounded text-sm font-body hover:opacity-90 transition-opacity"
        >
          Print again
        </button>
      </div>

      {/* DRAFT diagonal watermark — fixed position so it sits behind
          every printed page. CSS in print.css handles repeat-on-page
          via position:fixed which the browser interprets per-page. */}
      {draft && (
        <div aria-hidden="true" className="print-watermark">
          DRAFT
        </div>
      )}

      {/* Page running header. CSS positions this absolutely on each
          printed page via @page rules — but since real per-page running
          headers in CSS Paged Media require the rarely-supported
          `position: running()` model, we rely on a fixed-position
          element that the browser repeats on every page. Tested in
          Chrome (works), Safari (works), Firefox (works with a small
          gap on multi-page docs). */}
      {draft && draftLabel && (
        <div className="print-running-header" aria-hidden="true">
          {draftLabel}
        </div>
      )}

      {/* The document body. Letterhead first, then page content. */}
      <article className="print-document max-w-[7in] mx-auto px-8 py-10">
        <header className="print-letterhead pb-4 mb-6 border-b-[1px] border-navy/40">
          <div className="flex items-start justify-between gap-6">
            <img
              src="/logo-mark.png"
              alt={schoolName}
              className="h-16 w-auto print-logo"
            />
            <div className="text-right">
              <h1 className="font-display text-navy text-[22px] leading-tight">
                {title}
              </h1>
              {subtitle && (
                <p className="font-body italic text-muted text-[13px] mt-1">
                  {subtitle}
                </p>
              )}
              <p className="font-body text-[10px] text-muted mt-2 tracking-wider uppercase">
                Generated {generatedDateStr} at {generatedTimeStr}
                {generatedByName ? ` by ${generatedByName}` : ''}
              </p>
            </div>
          </div>
        </header>

        <div className="print-body">{children}</div>

        {/* Footer block. Approved-by block (Section 2.6) for locked
            outputs; "preliminary, subject to change" note for drafts.
            Rendered inline at the end of the document — the running
            page-number footer is handled by @page CSS rules. */}
        <footer className="print-footer mt-10 pt-4 border-t-[0.5px] border-navy/30 text-[10px] text-muted">
          {draft && (
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
          <p className="mt-1">
            {schoolName} · Generated {generatedDateStr}
          </p>
        </footer>
      </article>
    </div>
  )
}
