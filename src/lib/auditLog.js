// Audit-log query helpers for the Budget module.
//
// Source of truth: the `change_log` table, populated by tg_log_changes()
// (Migration 001) which is attached to budget_stage_scenarios and
// budget_stage_lines (Migration 011) plus budget_snapshots and
// budget_snapshot_lines.
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
// 011) requires `current_user_has_module_perm('budget', 'view')` for
// the four budget tables. Callers don't need to add their own check.
//
// User-name resolution: change_log only stores `changed_by` as a uuid.
// Helpers resolve those uuids to display names via user_profiles in a
// single follow-up batch query, then attach `changed_by_name` to each
// event so the UI can render "Jenna Salazar" instead of a uuid.

import { supabase } from './supabase'

// Group fan-out UPDATE rows into single logical events.
//
// A blur-save that touched multiple fields in one UPDATE produces N
// rows from the trigger, all sharing (target_table, target_id,
// changed_by, changed_at). We collapse them into one event per group
// with a `fields` array describing each field-level change.
//
// Coalesce window for grouping: rows with the same composite key but
// changed_at differing by ≤ 1ms are still treated as the same event
// (handles the rare edge case where the timestamp's microsecond
// component differs). Anything beyond 1ms is treated as a separate
// event, which is the correct call for distinct user actions.
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
//
// Unlock events are detected via `event.reason` (set by app.change_reason
// in the H1 RPC functions) BEFORE field-based heuristics, because
// unlock_completed transitions state from 'locked' → 'drafting' which
// doesn't match any of the existing state-based patterns and would
// otherwise fall through to 'edit'. Reason values:
//   'unlock_requested'             → kind 'unlock_requested'
//   'unlock_first_approval'        → kind 'unlock_first_approval'
//   'unlock_completed'             → kind 'unlock_completed'
//   'unlock_rejected: <text>'      → kind 'unlock_rejected'
//   'unlock_withdrawn: <text>'     → kind 'unlock_withdrawn'
//
// Multiple categories can apply to one event (a lock event also has
// state change AND locked_at AND locked_by AND locked_via in its
// fields list); we report the highest-priority single category in
// `kind` and let the renderer drill into `fields` for finer detail.
export function classifyEvent(event) {
  const fields = event.fields
  const fieldByName = Object.fromEntries(fields.map((f) => [f.field_name, f]))

  // Unlock workflow signatures take priority — they're identified by
  // the change_log.reason value rather than by field-shape, so they
  // need to be checked before state-transition heuristics.
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

// Extract the user-supplied reason text from a 'unlock_rejected' or
// 'unlock_withdrawn' event's reason marker. H1's reject function
// builds the reason as 'unlock_rejected: <text>' or
// 'unlock_withdrawn: <text>'; this strips the prefix and returns the
// raw user text. Returns empty string if no marker present.
export function extractUnlockReasonText(event) {
  if (!event?.reason) return ''
  const colonIdx = event.reason.indexOf(': ')
  if (colonIdx === -1) return ''
  return event.reason.slice(colonIdx + 2).trim()
}

// Resolve a set of user uuids to { id → full_name } via user_profiles.
// Single batch query. Missing or null ids return an empty map for
// those keys.
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
// Returns an array of events, newest first, with `changed_by_name`
// resolved. Each event has fields = [{ field_name, old_value,
// new_value }, ...] and a `kind` from classifyEvent.
export async function fetchLineHistory(lineId) {
  const { data, error } = await supabase
    .from('change_log')
    .select('target_table, target_id, field_name, old_value, new_value, changed_by, changed_at, reason')
    .eq('target_table', 'budget_stage_lines')
    .eq('target_id', lineId)
    .order('changed_at', { ascending: false })
    .order('field_name', { ascending: true })
  if (error) throw error

  // Order rows: newest first by changed_at, then stable by field_name
  // within each timestamp so the grouping pass below sees same-event
  // rows adjacent. The sort above already accomplishes this.
  const events = groupChangeLogRows(data || [])
  for (const e of events) e.kind = classifyEvent(e)

  const userMap = await resolveUserNames(events.map((e) => e.changed_by))
  for (const e of events) {
    e.changed_by_name = userMap[e.changed_by] || null
  }
  return events
}

// Fetch grouped events for an entire scenario: the scenario row itself
// plus every budget_stage_lines row belonging to it.
//
// Two-step query because change_log doesn't carry scenario_id directly:
//   1. Get all line ids for the scenario (lines, even soft-deleted ones,
//      via change_log __insert__ rows — but the simpler path is to
//      resolve membership via the live budget_stage_lines table for
//      currently-existing lines, which covers ~all of governance value).
//   2. Pull change_log rows for that scenario's row id PLUS the line ids.
//
// `limit` caps the result count after grouping (i.e., events, not raw
// rows). `null` / undefined means no limit.
//
// Returns events newest-first with `changed_by_name` and `kind`
// resolved. Each event also carries `target_kind`: 'scenario' | 'line'
// so the renderer knows which family of activity it's looking at.
//
// `accountsById` (optional) — a map of account_id → { code, name }
// used to render "Curriculum/Book Fees" in line events instead of a
// raw uuid. Pass it from the caller (BudgetStage already has accounts
// loaded). When a line's account_id resolves through this map, the
// event gets `account_code` and `account_name` attached for display.
export async function fetchScenarioActivity(scenarioId, { limit = null, accountsById = null } = {}) {
  // Step 1: Get every line id that's ever been associated with this
  // scenario. We read from change_log directly so deleted lines remain
  // visible in the activity feed (audit history shouldn't disappear
  // when a line is removed — the deletion itself is a logged event).
  const { data: lineInsertRows, error: insertErr } = await supabase
    .from('change_log')
    .select('target_id, new_value')
    .eq('target_table', 'budget_stage_lines')
    .eq('field_name', '__insert__')
  if (insertErr) throw insertErr

  const lineIds = (lineInsertRows || [])
    .filter((r) => r.new_value && r.new_value.scenario_id === scenarioId)
    .map((r) => r.target_id)

  // Step 2: Pull all change_log rows for the scenario row + its lines.
  const targets = [
    { table: 'budget_stage_scenarios', ids: [scenarioId] },
    { table: 'budget_stage_lines', ids: lineIds },
  ]

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
      // Secondary sort to keep grouping stable within a millisecond.
      if (a.target_id !== b.target_id) return a.target_id < b.target_id ? -1 : 1
      return a.field_name < b.field_name ? -1 : 1
    })

  const events = groupChangeLogRows(allRows)
  for (const e of events) {
    e.kind = classifyEvent(e)
    e.target_kind = e.target_table === 'budget_stage_scenarios' ? 'scenario' : 'line'

    // Account label resolution for line events.
    if (e.target_kind === 'line' && accountsById) {
      // For inserts we know the account_id from new_value; for updates
      // we need to look it up from the live row. We don't have the live
      // row here, so we cache account_id per line on first sighting.
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

  // Second-pass account resolution: for line events whose account
  // wasn't found on insert/delete (i.e., pure UPDATE-only events),
  // backfill from any other event on the same line that DID resolve.
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

// Format a USD amount the same way as the budget detail. Local copy so
// auditLog has no dependency on the tree library.
const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
function fmtUsd(n) {
  if (n == null) return ''
  return usd0.format(Number(n))
}

// Humanize a single field-change for display. Returns a short string
// suitable for an inline diff cell. Caller controls visual treatment
// via the event-level `kind`.
//
// Special-cased fields:
//   amount                       — "$0 → $5,000"
//   state                        — "drafting → pending_lock_review"
//   is_recommended               — "marked recommended" / "unmarked recommended"
//   locked_via                   — "lock method: normal" / "lock method: override"
//   override_justification       — "justification: <text>"
//   __insert__                   — "Created"
//   __delete__                   — "Deleted"
//
// Fallback: "<field>: <old> → <new>" for anything else.
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
  // Fallback for fields we haven't special-cased.
  const o = old_value === null || old_value === undefined ? '∅' : JSON.stringify(old_value)
  const n = new_value === null || new_value === undefined ? '∅' : JSON.stringify(new_value)
  return `${field_name}: ${o} → ${n}`
}

// Build a one-line summary of an event for the activity feed (where
// each event renders as a single row, not an expanded diff list).
//
// For 'amount' events on a line: "Curriculum/Book Fees: $0 → $9,750".
// For 'lock' events: "Scenario locked".
// For 'override' events: "Lock submitted with override".
// Etc.
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
      // Justification was set on this UPDATE; trigger captured the
      // null → '<text>' diff. Render it inline (no truncation —
      // §9.1 commitment, parallel to override events).
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
      // Reason text is folded into change_log.reason as
      // 'unlock_rejected: <text>'; extract via the helper.
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
      // Pick the first non-system field for the summary; fall back to
      // the count if multiple fields changed.
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

// Format a relative or absolute timestamp for the activity feed.
//
// Relative for the past 7 days ("5 minutes ago", "2 hours ago",
// "yesterday"); absolute for older ("Apr 15, 2026").
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
