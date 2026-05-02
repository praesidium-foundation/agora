// School-level configuration. Single home for values that are
// hardcoded today and will become per-school configurable when the
// second school onboards (or when admin/settings/Brand.jsx graduates
// from its current "Coming soon" placeholder).
//
// Today: every value here is a constant for Libertas Academy.
//
// Future: this module either reads from `school_brand_settings`
// (architecture §10.7) loaded once at app boot, or its consumers call
// async getters that hit the DB and cache. The function-shaped exports
// below leave both upgrade paths open without forcing call sites to
// change shape today.
//
// Why a single file: PrintShell letterheads, audit-log footers, the
// canonical-name helper, and any future dashboard "this school is X"
// affordance all reference the same school name today. Centralizing
// avoids the "search and replace across 30 files" cost when multi-
// tenancy lands.

const SCHOOL_NAME = 'Libertas Academy'

// The school's official name as it appears in formal contexts (PDF
// letterheads, canonical artifact names, audit-log "school" labels).
// Use this rather than hardcoding "Libertas Academy" anywhere in
// component code.
export function getSchoolName() {
  return SCHOOL_NAME
}
