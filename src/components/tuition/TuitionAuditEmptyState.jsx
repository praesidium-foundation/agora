import { Link } from 'react-router-dom'
import Card from '../Card'

// Setup-view empty state for Tuition Audit (Stage 2 / 'final').
//
// Architecture §3.4 + §7.3. Tuition Audit requires a locked Tuition
// Planning (Stage 1) snapshot in the same AYE before it can be set
// up — Stage 2's per-family detail records realize the projections
// the locked Stage 1 captured. Without a Stage 1 lock there is no
// projection to realize against, so the gateway is a hard gate
// (no override option, no fresh-start option).
//
// This component renders the gate-blocked path: no locked Stage 1
// for the active AYE. The post-gate path (Stage 1 IS locked, ready
// to seed Stage 2 from the snapshot) ships in a future commit when
// the Stage 2 editing surface itself ships — for now Tuition Audit
// is intentionally limited to the gateway, surfacing the cascade
// rule cleanly without drawing the user into a half-built editing
// page.
//
// Mirrors the pattern of src/components/budget/PredecessorSelector.jsx's
// "no locked predecessors" branch.
//
// Props:
//   ayeLabel              — display label for the active AYE
//   stageDisplayName      — Stage 2's display name (e.g. "Tuition Audit")
//   stage1DisplayName     — Stage 1's display name (e.g. "Tuition Planning")
//   stage1AnyLocked       — bool: is there a locked Stage 1 snapshot
//                           in this AYE? (parent loads this) When true,
//                           the gateway shows the "ready to set up
//                           Stage 2 — feature ships later" copy. When
//                           false, the cascade-blocked copy.
export default function TuitionAuditEmptyState({
  ayeLabel,
  stageDisplayName,
  stage1DisplayName,
  stage1AnyLocked,
}) {
  if (stage1AnyLocked) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] py-6">
        <Card className="max-w-2xl w-full">
          <h2 className="font-display text-navy text-[22px] mb-2 leading-tight">
            Set up your {stageDisplayName}
          </h2>
          <p className="font-body text-body text-sm leading-relaxed mb-4">
            <strong className="font-medium">{stage1DisplayName}</strong> is
            locked for {ayeLabel || 'this academic year'} — the Stage 2 audit
            would seed from that snapshot.
          </p>
          <p className="font-body italic text-muted text-sm leading-relaxed mb-2">
            The Stage 2 editing surface (per-family rows, Faculty / Other /
            FA discount allocations against the locked envelopes) ships in a
            follow-on commit. The cascade gate is in place; the editor
            arrives when it's ready.
          </p>
        </Card>
      </div>
    )
  }

  // Gate-blocked: no Stage 1 lock yet.
  return (
    <div className="flex items-center justify-center min-h-[60vh] py-6">
      <Card className="max-w-2xl w-full">
        <h2 className="font-display text-navy text-[22px] mb-2 leading-tight">
          Set up your {stageDisplayName}
        </h2>
        <p className="font-body text-body text-sm leading-relaxed mb-4">
          <strong className="font-medium">{stageDisplayName}</strong>{' '}
          requires a locked{' '}
          <strong className="font-medium">{stage1DisplayName}</strong>{' '}
          snapshot as its starting point. No locked {stage1DisplayName}{' '}
          exists yet for {ayeLabel || 'this academic year'}.
        </p>
        <p className="font-body italic text-muted text-sm leading-relaxed mb-5">
          Lock the {stage1DisplayName} first — the projected tier rates,
          discount envelopes, and family distribution become the per-family
          allocation baseline that Stage 2 reconciles against.
        </p>
        <Link
          to="/modules/tuition"
          className="inline-block bg-navy text-gold border-[0.5px] border-navy px-4 py-2 rounded text-sm font-body hover:opacity-90 transition-opacity"
        >
          Go to {stage1DisplayName}
        </Link>
      </Card>
    </div>
  )
}
