// Audit-log query helpers (module-aware as of v3.8.10).
//
// Source of truth: the `change_log` table, populated by tg_log_changes()
// (Migration 001) which is attached to every scenario / line / snapshot
// table whose changes should appear in the per-scenario activity feed.
//
// v3.8.10 (Tuition-D) generalized this file from Budget-only to
// module-aware. The shape of the audit data is identical across
// modules — every scenario has a header table and a child table whose
// rows belong to a scenario via scenario_id — so the helpers that
// classify, group, and render events stay shared. The only piece
// that varies per module is the table-name pair (scenarios + child
// rows) and the optional account-resolution map. That variation is
// captured in MODULE_AUDIT_CONFIGS below.
//
// Trigger semantics (verified against Migration 001):
//   - INSERT  → 1 row, field_name = '__insert__', new_value = full row jsonb
//   - DELETE  → 1 row, field_name = '__delete__', old_value = full row jsonb
//   - UPDATE  → N rows, one per changed field, with old_value/new_value
//               for that field (jsonb scalars).
//
// Because UPDATEs fan out to multiple rows, the helpers below group rows
// by (target_table, target_id, changed_by, changed_at) so a single
// blur-save that the trigger emitted as N rows reads as ONE event in the
// UI. Within a grouped event, every changed field is preserved as a
// `fields` array so consumers can render diffs.
//
// Read access is gated by RLS — the change_log_read policy (Migration
// 023's rebuild adds tuition_worksheet_scenarios + family_details +
// snapshots to the existing budget arms). Callers don't need to add
// their own permission check.
//
// User-name resolution: change_log only stores `changed_by` as a uuid.
// Helpers resolve those uuids to display names via user_profiles in a
// single follow-up batch query, then attach `changed_by_name` to each
// event so the UI can render "Jenna Salazar" instead of a uuid.

import { supabase } from './supabase'

// ============================================================================
// Module audit configs.
//
// One entry per module with audit-feed support. Used by
// fetchScenarioActivity to know which tables to query.
//
// Schema:
//   scenarioTable    — the scenario header table (1 row per scenario)
//   lineTable        — the per-row child table whose insert events are
//                      filtered by scenario_id to enumerate the line
//                      ids belonging to a scenario. May be NULL for
//                      modules where the scenario has no child rows
//                      (e.g. the Tuition Stage 1 scenario row carries
//                      its data inline in jsonb columns; there is no
//                      separate line table at Stage 1).
//
// Adding a new module's audit feed: add an entry here, attach
// tg_log_changes to its scenario + line tables (if applicable), and
// extend the change_log_read RLS policy to include the new tables.
// ============================================================================
export const MODULE_AUDIT_CONFIGS = {
  budget: {
    scenarioTable: 'budget_stage_scenarios',
    lineTable:     'budget_stage_lines',
  },
  tuition: {
    scenarioTable: 'tuition_worksheet_scenarios',
    // Stage 1 has no per-row child table (configuration lives inline
    // in jsonb columns on the scenario row). Stage 2 has
    // tuition_worksheet_family_details, but per architecture §3.6
    // family-details rows are gated by can_view_family_details and
    // would need a separate audit affordance per RLS — out of scope
    // for the v3.8.10 generalization. Setting lineTable to null
    // means fetchScenarioActivity skips the line-enumeration step
    // for tuition; the activity feed shows scenario-row events only,
    // which is the right granularity for Stage 1 anyway.
    lineTable:     null,
  },
}

// Group fan-out UPDATE rows into single logical events.
function groupChangeLogRows(rows) {
  const events = []
  let current = null

  for (const row of rows) {
    const ts = new Date(row.changed_at).getTime()
    const sameEvent =
      current &&
      current.target_table === row.target_table &&
      current.target_id === row.target_id &&
      current.changed_by === row.changed_by &&
      Math.abs(ts - current.ts) <= 1

    if (sameEvent) {
      current.fields.push({
        field_name: row.field_name,
        old_value: row.old_value,
        new_value: row.new_value,
      })
    } else {
      current = {
        ts,
        changed_at: row.changed_at,
        target_table: row.target_table,
        target_id: row.target_id,
        changed_by: row.changed_by,
        reason: row.reason,
        fields: [
          {
            field_name: row.field_name,
            old_value: row.old_value,
            new_value: row.new_value,
          },
        ],
      }
      events.push(current)
    }
  }

  return events
}

// Classify a grouped event into one of the high-level categories the UI
// renders distinctly:
//
//   'insert'              — first appearance of the row
//   'delete'              — row removed
//   'lock'                — scenario state transition INTO 'locked'
//   'submit'              — scenario state transition INTO 'pending_lock_review'
//   'reject'              — scenario state transition pending_lock_review → drafting
//   'recommend'           — is_recommended toggled
//   'override'            — locked_via set to 'override' OR override_justification populated
//   'unlock_requested'    — unlock workflow: request initiated
//   'unlock_first_approval' — unlock workflow: first of two approvals recorded
//   'unlock_completed'    — unlock workflow: second approval recorded; state flipped to drafting
//   'unlock_rejected'     — unlock workflow: an approver rejected the request
//   'unlock_withdrawn'    — unlock workflow: requester withdrew their own request
//   'amount'              — pure amount change on a budget line
//   'edit'                — anything else (notes, label, description, etc.)
export function classifyEvent(event) {
  const fields = event.fields
  const fieldByName = Object.fromEntries(fields.map((f) => [f.field_name, f]))

  if (event.reason) {
    if (event.reason === 'unlock_requested')      return 'unlock_requested'
    if (event.reason === 'unlock_first_approval') return 'unlock_first_approval'
    if (event.reason === 'unlock_completed')      return 'unlock_completed'
    if (event.reason.startsWith('unlock_rejected'))  return 'unlock_rejected'
    if (event.reason.startsWith('unlock_withdrawn')) return 'unlock_withdrawn'
  }

  if (fieldByName.__insert__) return 'insert'
  if (fieldByName.__delete__) return 'delete'

  const stateField = fieldByName.state
  if (stateField) {
    const newState = stateField.new_value
    if (newState === 'locked') return 'lock'
    if (newState === 'pending_lock_review') return 'submit'
    if (newState === 'drafting' && stateField.old_value === 'pending_lock_review') {
      return 'reject'
    }
  }

  const lockedViaField = fieldByName.locked_via
  if (lockedViaField && lockedViaField.new_value === 'override') return 'override'
  if (fieldByName.override_justification && fieldByName.override_justification.new_value) {
    return 'override'
  }

  if (fieldByName.is_recommended) return 'recommend'
  if (fieldByName.amount) return 'amount'
  return 'edit'
}

export function extractUnlockReasonText(event) {
  if (!event?.reason) return ''
  const colonIdx = event.reason.indexOf(': ')
  if (colonIdx === -1) return ''
  return event.reason.slice(colonIdx + 2).trim()
}

// Resolve a set of user uuids to { id → full_name } via user_profiles.
async function resolveUserNames(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (ids.length === 0) return {}
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, full_name')
    .in('id', ids)
  if (error) throw error
  return Object.fromEntries((data || []).map((u) => [u.id, u.full_name]))
}

// Fetch grouped events touching a single budget_stage_lines row.
//
// Budget-only today — line-level history is a per-line affordance
// that only makes sense for modules whose scenarios have a child
// line table (Budget). Tuition Stage 1 has no line table; Stage 2's
// family_details rows have row-level audit but a different
// permission model (gated by can_view_family_details) and a
// different UI treatment. When/if Tuition Stage 2 grows a per-row
// history modal, this function generalizes the same way
// fetchScenarioActivity did.
export async function fetchLineHistory(lineId) {
  const { data, error } = await supabase
    .from('change_log')
    .select('target_table, target_id, field_name, old_value, new_value, changed_by, changed_at, reason')
    .eq('target_table', 'budget_stage_lines')
    .eq('target_id', lineId)
    .order('changed_at', { ascending: false })
    .order('field_name', { ascending: true })
  if (error) throw error

  const events = groupChangeLogRows(data || [])
  for (const e of events) e.kind = classifyEvent(e)

  const userMap = await resolveUserNames(events.map((e) => e.changed_by))
  for (const e of events) {
    e.changed_by_name = userMap[e.changed_by] || null
  }
  return events
}

// Fetch grouped events for an entire scenario: the scenario row itself
// plus every line row belonging to it (when the module has a line
// table; see MODULE_AUDIT_CONFIGS).
//
// v3.8.10 generalization: first arg is now `moduleId` (e.g. 'budget',
// 'tuition'). Existing Budget call sites must pass 'budget' as the
// first arg.
//
// `limit` caps the result count after grouping. `null`/undefined =
// no limit. `accountsById` (optional) — a map of account_id →
// { code, name } used to render account labels in line events; only
// applicable to budget. Pass null for modules without a line table.
//
// Returns events newest-first with `changed_by_name` and `kind`
// resolved. Each event also carries `target_kind`: 'scenario' | 'line'
// so the renderer knows which family of activity it's looking at.
export async function fetchScenarioActivity(moduleId, scenarioId, { limit = null, accountsById = null } = {}) {
  const config = MODULE_AUDIT_CONFIGS[moduleId]
  if (!config) {
    throw new Error(`fetchScenarioActivity: unknown moduleId "${moduleId}". Add an entry to MODULE_AUDIT_CONFIGS.`)
  }
  const { scenarioTable, lineTable } = config

  // Step 1: Get every line id that's ever been associated with this
  // scenario. Skip when the module has no line table.
  let lineIds = []
  if (lineTable) {
    const { data: lineInsertRows, error: insertErr } = await supabase
      .from('change_log')
      .select('target_id, new_value')
      .eq('target_table', lineTable)
      .eq('field_name', '__insert__')
    if (insertErr) throw insertErr

    lineIds = (lineInsertRows || [])
      .filter((r) => r.new_value && r.new_value.scenario_id === scenarioId)
      .map((r) => r.target_id)
  }

  // Step 2: Pull all change_log rows for the scenario row + its lines
  // (if any).
  const targets = [
    { table: scenarioTable, ids: [scenarioId] },
  ]
  if (lineTable) {
    targets.push({ table: lineTable, ids: lineIds })
  }

  const queries = targets.map(({ table, ids }) => {
    if (ids.length === 0) return Promise.resolve({ data: [], error: null })
    return supabase
      .from('change_log')
      .select('target_table, target_id, field_name, old_value, new_value, changed_by, changed_at, reason')
      .eq('target_table', table)
      .in('target_id', ids)
  })

  const results = await Promise.all(queries)
  for (const r of results) if (r.error) throw r.error

  // Merge, sort newest-first, then group adjacent same-event rows.
  const allRows = results
    .flatMap((r) => r.data || [])
    .sort((a, b) => {
      const at = new Date(a.changed_at).getTime()
      const bt = new Date(b.changed_at).getTime()
      if (bt !== at) return bt - at
      if (a.target_id !== b.target_id) return a.target_id < b.target_id ? -1 : 1
      return a.field_name < b.field_name ? -1 : 1
    })

  const events = groupChangeLogRows(allRows)
  for (const e of events) {
    e.kind = classifyEvent(e)
    e.target_kind = e.target_table === scenarioTable ? 'scenario' : 'line'

    // Account label resolution for line events (budget only).
    if (e.target_kind === 'line' && accountsById) {
      const insertField = e.fields.find((f) => f.field_name === '__insert__')
      const deleteField = e.fields.find((f) => f.field_name === '__delete__')
      const accountId =
        (insertField && insertField.new_value && insertField.new_value.account_id) ||
        (deleteField && deleteField.old_value && deleteField.old_value.account_id) ||
        null
      if (accountId && accountsById[accountId]) {
        e.account_code = accountsById[accountId].code
        e.account_name = accountsById[accountId].name
      } else {
        e.account_id_unresolved = accountId
      }
    }
  }

  // Second-pass account resolution.
  if (accountsById) {
    const resolvedByLine = {}
    for (const e of events) {
      if (e.target_kind === 'line' && e.account_code) {
        resolvedByLine[e.target_id] = {
          code: e.account_code,
          name: e.account_name,
        }
      }
    }
    for (const e of events) {
      if (e.target_kind === 'line' && !e.account_code && resolvedByLine[e.target_id]) {
        e.account_code = resolvedByLine[e.target_id].code
        e.account_name = resolvedByLine[e.target_id].name
      }
    }
  }

  const userMap = await resolveUserNames(events.map((e) => e.changed_by))
  for (const e of events) {
    e.changed_by_name = userMap[e.changed_by] || null
  }

  return limit ? events.slice(0, limit) : events
}

// ----- Per-field humanizer + per-event summarizer -------------------------

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
function fmtUsd(n) {
  if (n == null) return ''
  return usd0.format(Number(n))
}

export function describeField(field) {
  const { field_name, old_value, new_value } = field
  if (field_name === '__insert__') return 'Created'
  if (field_name === '__delete__') return 'Deleted'
  if (field_name === 'amount') {
    return `${fmtUsd(old_value)} → ${fmtUsd(new_value)}`
  }
  if (field_name === 'state') {
    return `${old_value || '∅'} → ${new_value || '∅'}`
  }
  if (field_name === 'is_recommended') {
    return new_value === true ? 'marked recommended' : 'unmarked recommended'
  }
  if (field_name === 'locked_via') {
    return `lock method: ${new_value || 'normal'}`
  }
  if (field_name === 'override_justification' && new_value) {
    return `justification: "${new_value}"`
  }
  if (field_name === 'scenario_label') {
    return `name: "${old_value ?? ''}" → "${new_value ?? ''}"`
  }
  if (field_name === 'description') {
    return `description updated`
  }
  if (field_name === 'narrative') {
    return `narrative updated`
  }
  if (field_name === 'notes') {
    return `notes updated`
  }
  const o = old_value === null || old_value === undefined ? '∅' : JSON.stringify(old_value)
  const n = new_value === null || new_value === undefined ? '∅' : JSON.stringify(new_value)
  return `${field_name}: ${o} → ${n}`
}

export function summarizeEvent(event) {
  const accountLabel =
    event.account_code && event.account_name
      ? `${event.account_name} (${event.account_code})`
      : event.account_name ||
        (event.target_kind === 'line' ? 'a line' : 'the scenario')

  switch (event.kind) {
    case 'insert':
      return event.target_kind === 'line'
        ? `Added ${accountLabel} to the budget`
        : `Created scenario`
    case 'delete':
      return event.target_kind === 'line'
        ? `Removed ${accountLabel} from the budget`
        : `Deleted scenario`
    case 'lock':
      return `Scenario locked`
    case 'submit':
      return `Submitted for lock review`
    case 'reject':
      return `Lock submission rejected; returned to drafting`
    case 'recommend': {
      const f = event.fields.find((x) => x.field_name === 'is_recommended')
      return f && f.new_value === true
        ? `Marked scenario as recommended`
        : `Unmarked recommended`
    }
    case 'override':
      return `Lock submitted with override`
    case 'unlock_requested': {
      const f = event.fields.find((x) => x.field_name === 'unlock_request_justification')
      const justification = f && f.new_value ? String(f.new_value) : null
      return justification
        ? `Unlock requested. Reason: "${justification}"`
        : `Unlock requested`
    }
    case 'unlock_first_approval':
      return `First unlock approval recorded`
    case 'unlock_completed':
      return `Unlock approved. Scenario returned to drafting.`
    case 'unlock_rejected': {
      const reasonText = extractUnlockReasonText(event)
      return reasonText
        ? `Unlock request rejected. Reason: "${reasonText}"`
        : `Unlock request rejected`
    }
    case 'unlock_withdrawn': {
      const reasonText = extractUnlockReasonText(event)
      return reasonText
        ? `Unlock request withdrawn. Reason: "${reasonText}"`
        : `Unlock request withdrawn`
    }
    case 'amount': {
      const f = event.fields.find((x) => x.field_name === 'amount')
      return `${accountLabel}: ${describeField(f)}`
    }
    case 'edit':
    default: {
      const real = event.fields.filter(
        (f) => f.field_name !== '__insert__' && f.field_name !== '__delete__'
      )
      if (real.length === 1) {
        const prefix =
          event.target_kind === 'line' ? `${accountLabel}: ` : ''
        return prefix + describeField(real[0])
      }
      return event.target_kind === 'line'
        ? `${accountLabel}: ${real.length} fields updated`
        : `Scenario: ${real.length} fields updated`
    }
  }
}

export function formatActivityTimestamp(iso) {
  const t = new Date(iso)
  const now = new Date()
  const diffMs = now - t
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr  = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`
  if (diffHr  < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`
  if (diffDay === 1) return 'yesterday'
  if (diffDay < 7)  return `${diffDay} days ago`
  return t.toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

export function formatAbsoluteTimestamp(iso) {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}
