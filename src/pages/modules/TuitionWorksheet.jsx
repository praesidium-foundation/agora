// Placeholder for the Tuition module.
//
// Tuition-A2 (v3.8.1) landed the schema and lock/unlock workflow RPCs
// — `tuition_worksheet_scenarios`, `tuition_worksheet_family_details`,
// snapshot tables, and the SECURITY DEFINER functions — but UI work
// is deferred to Tuition-B as a separate session.
//
// This page exists to prevent a runtime error on the `/modules/tuition`
// route (the sidebar's Tuition → Planning child links here). The
// previous implementation queried the legacy `tuition_worksheet` and
// `tuition_scenarios` tables, both of which were dropped in Migration
// 022 as part of the two-stage refactor.
//
// Replaced wholesale in Tuition-B.

export default function TuitionWorksheet() {
  return (
    <div className="max-w-3xl mx-auto py-12">
      <header className="mb-6">
        <h1 className="font-display text-navy text-[28px] tracking-[0.04em] mb-2">
          Tuition
        </h1>
        <p className="text-body text-sm leading-relaxed">
          Two-stage workflow: Tuition Planning (January) feeds Preliminary Budget;
          Tuition Audit (September) feeds Final Budget. Architecture §7.3.
        </p>
      </header>

      <div className="bg-cream-highlight border-[0.5px] border-card-border rounded-[10px] p-6">
        <p className="font-display text-[13px] tracking-[0.08em] uppercase text-status-amber mb-2">
          Schema landed · UI in Tuition-B
        </p>
        <p className="text-body text-sm leading-relaxed mb-3">
          The Tuition module schema and lock/unlock workflow RPCs are in
          place (Migrations 022–026). The configuration UI for Stage 1
          (tier rates, discount envelopes, fee rates, projected family
          distribution) and the per-family detail editor for Stage 2
          ship in the next session.
        </p>
        <p className="text-body text-sm leading-relaxed">
          Lock cascade: Tuition Stage 1 lock will become an upstream
          gate for Preliminary Budget lock; Tuition Stage 2 lock will
          gate Final Budget lock (per architecture §7.5). Today both
          Budget stages still allow override-with-justification because
          Tuition is not yet contributing live data.
        </p>
      </div>
    </div>
  )
}
