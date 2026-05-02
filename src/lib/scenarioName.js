// Canonical naming of locked governance artifacts.
//
// Architecture §8.15. A locked Budget snapshot is the official approved
// artifact for a (school, AYE, stage) slot. It deserves a canonical
// name that reads as a real governance document — "Libertas Academy
// AYE 2026 Preliminary Budget" — rather than a working scenario label
// like "Scenario 1" that was useful when the budget was being drafted
// but is meaningless to a board chair reading the PDF in a binder.
//
// School name comes from src/lib/schoolConfig.js (single source of
// truth — when multi-tenancy lands and the school name moves to
// school_brand_settings, only schoolConfig.js needs to change).
//
// Working-tool surfaces (scenario tabs, drafting-mode UI, audit log
// entries) continue to use the scenario's stored working name. This
// preserves the historical truth of what the scenario was called when
// each action happened.
//
// Implementation: render-time computation. No schema change. No
// snapshot data backfill. The canonical name is derived from data the
// caller has already loaded — school name, AYE label, stage display
// name. Callers that want canonical naming pass those three pieces;
// callers that want the working name read scenario.scenario_label
// directly.
//
// Surfaces using canonical name (locked artifacts only):
//   - Operating Budget Detail PDF letterhead (locked variant only)
//   - LockedBanner heading (the morphing banner; canonical applies in
//     all three locked-state variants — the underlying artifact
//     identity does not change while unlock is pending)
//   - Future dashboard "locked artifacts" surfaces (none yet)
//
// Surfaces using working name (scenario.scenario_label):
//   - Scenario tabs (even when the active tab is a locked scenario —
//     the tab is a working-tool affordance for switching between
//     scenarios)
//   - Audit log entries (LineHistoryModal, ActivityFeedPanel, the two
//     audit print pages) — historical records preserve the truth of
//     what the scenario was called when the action happened
//   - Drafting-mode UI (page header, banners, modals during drafting)
//   - DRAFT-marked PDF letterheads (the PDF is a draft of a still-
//     working scenario; the working name is what matters)

import { getSchoolName } from './schoolConfig'

// Compute the canonical name for a locked artifact in a (AYE, stage)
// slot. Format: "{school} {aye_label} {stage_display_name}".
//
// Inputs are objects already loaded by the caller. None of the three
// pieces are looked up here — the caller is responsible for having
// loaded the AYE record and the stage record.
//
// Examples:
//   getCanonicalLockedArtifactName(
//     { label: 'AYE 2026' },
//     { display_name: 'Preliminary Budget' }
//   )
//   → "Libertas Academy AYE 2026 Preliminary Budget"
//
//   getCanonicalLockedArtifactName(
//     { label: 'AYE 2027' },
//     { display_name: 'Final Budget' }
//   )
//   → "Libertas Academy AYE 2027 Final Budget"
//
// Defensive: if either piece is missing, falls back to the working
// scenario label so we never show an empty heading. The caller should
// pass complete data; this is a safety net for edge cases (e.g.,
// loading state where the stage record is still in flight).
export function getCanonicalLockedArtifactName(aye, stage, scenarioFallback = null) {
  const ayeLabel = aye?.label
  const stageDisplay = stage?.display_name
  if (!ayeLabel || !stageDisplay) {
    return scenarioFallback?.scenario_label || 'Locked budget'
  }
  return `${getSchoolName()} ${ayeLabel} ${stageDisplay}`
}

// Pick the right name based on rendering context. Single dispatch
// point so callers do not have to reason about canonical-vs-working
// every time a name is rendered.
//
// Contexts that map to canonical (locked artifacts only):
//   - 'pdf_letterhead'    — Operating Budget Detail letterhead
//                            (locked variant; DRAFT variant uses working)
//   - 'locked_banner'     — LockedBanner heading
//   - 'dashboard_artifact'— dashboard locked-artifact surfaces (future)
//
// Contexts that map to working name (scenario_label):
//   - 'scenario_tab'
//   - 'audit_entry'
//   - 'drafting_view'
//   - any context not recognized (defensive default)
//
// For canonical contexts, the function returns canonical only when the
// scenario is actually locked. Pre-lock or post-unlock, we always show
// the working name — there is no canonical artifact yet (or anymore).
export function getDisplayNameForContext(context, { scenario, aye, stage } = {}) {
  const isCanonicalContext =
    context === 'pdf_letterhead' ||
    context === 'locked_banner' ||
    context === 'dashboard_artifact'

  if (isCanonicalContext && scenario?.state === 'locked') {
    return getCanonicalLockedArtifactName(aye, stage, scenario)
  }

  // Working-name contexts (and pre/post-locked scenarios in canonical
  // contexts) all fall through here.
  return scenario?.scenario_label || 'Untitled scenario'
}
