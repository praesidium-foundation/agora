import { createContext, useCallback, useContext, useEffect, useState } from 'react'

// Toast notification system.
//
// Architecture Section 10's "long-list controls and feedback" practice:
// status messages on long-scroll pages must remain visible regardless
// of scroll position. Inline messages rendered at the top of a content
// area become invisible when a user is deep in a 122-row tree or a
// hundreds-of-lines budget. Toasts solve this by rendering in fixed
// position relative to the viewport.
//
// Usage:
//
//   // 1. Wrap the app at the root (main.jsx):
//   <ToastProvider>
//     <App />
//   </ToastProvider>
//
//   // 2. In any component, get the imperative show() function:
//   const { show } = useToast()
//
//   // 3. Call it with a kind and a message:
//   show({ kind: 'success', message: 'Added Curriculum/Book Fees.' })
//   show({ kind: 'error',   message: 'Could not delete: ...' })
//
// Behavior:
//   - kind 'success' auto-dismisses after 4 seconds
//   - kind 'error'   stays until the user clicks the × button
//                    (errors are more important to read than to clear)
//   - Multiple simultaneous toasts stack vertically with 8px spacing
//   - Top-right of viewport, offset 80px from top to clear the global
//     header
//
// Inline form-field validation errors (e.g., "Name is required" below
// a form input) STAY inline. Toasts are for status messages — the
// outcome of an action — not for field-specific feedback.

const ToastContext = createContext(null)

const AUTO_DISMISS_MS = 4000

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const show = useCallback(({ kind, message }) => {
    if (!message) return
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    setToasts((prev) => [...prev, { id, kind: kind || 'info', message }])
    return id
  }, [])

  // Convenience wrappers — the most common call shapes.
  const success = useCallback(
    (message) => show({ kind: 'success', message }),
    [show]
  )
  const error = useCallback(
    (message) => show({ kind: 'error', message }),
    [show]
  )

  return (
    <ToastContext.Provider value={{ show, success, error, dismiss }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    // Defensive — surface a helpful error rather than silent no-op when
    // someone forgets to wrap the app in <ToastProvider>.
    throw new Error('useToast must be used inside a <ToastProvider>')
  }
  return ctx
}

function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) return null
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed top-[72px] right-6 z-[1000] flex flex-col gap-2 pointer-events-none"
      style={{ maxWidth: 'min(400px, calc(100vw - 48px))' }}
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  )
}

function Toast({ toast, onDismiss }) {
  const { kind, message } = toast

  // Auto-dismiss success toasts after AUTO_DISMISS_MS. Errors stay
  // until the user clicks ×.
  useEffect(() => {
    if (kind !== 'success') return
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [kind, onDismiss])

  // Animation polish (gentle slide-in from right) deferred — toast
  // appears immediately. Cheap to add later via a small Tailwind
  // keyframe in index.css if it grates.
  const accent =
    kind === 'success'
      ? 'border-l-status-green'
      : kind === 'error'
        ? 'border-l-status-red'
        : 'border-l-status-blue'

  const role = kind === 'error' ? 'alert' : 'status'

  return (
    <div
      role={role}
      className={`pointer-events-auto bg-cream border-[0.5px] border-card-border border-l-4 ${accent} rounded-[6px] shadow-lg px-4 py-3 flex items-start gap-3`}
    >
      <p className="font-body text-sm text-body leading-relaxed flex-1 whitespace-pre-line">
        {message}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="font-body text-muted hover:text-navy text-[16px] leading-none flex-shrink-0"
      >
        ×
      </button>
    </div>
  )
}
