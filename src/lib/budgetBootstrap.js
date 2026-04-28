// Bootstrap helpers for Preliminary Budget scenarios.
//
// Three entry paths, all of which create a single preliminary_budget_scenarios
// row plus an initial set of preliminary_budget_lines:
//
//   1. createBlankScenario  — Start with $0. Pre-populates one line per
//      posting non-pass-thru active account in the COA, all amounts at 0.
//   2. createScenarioFromPriorAye — Bootstrap from prior AYE. Copies lines
//      from the most recent prior locked snapshot (preliminary or final),
//      mapped back to current COA accounts by code (then by name as
//      fallback). Returns a list of skipped accounts so the caller can
//      surface them.
//   3. createScenarioFromCsvRows — Insert a parsed-and-validated CSV row
//      set as the initial line list. Caller is responsible for parsing,
//      format detection, and validation; this function trusts what it's
//      handed.
//
// All three return { scenarioId, importedCount, skippedNames? }. Errors
// bubble up as thrown — callers handle.
//
// Scenario_label defaults to "Scenario 1" when no other scenario exists
// for the AYE; otherwise increments based on existing labels. Caller may
// override via the `label` option.

import { supabase } from './supabase'

// Pick the next scenario label given the existing ones for this AYE.
// "Scenario 1" / "Scenario 2" / etc. — purely advisory; user can rename.
async function nextScenarioLabel(ayeId) {
  const { data, error } = await supabase
    .from('preliminary_budget_scenarios')
    .select('scenario_label')
    .eq('aye_id', ayeId)
  if (error) throw error
  const n = (data || []).length
  return `Scenario ${n + 1}`
}

// Insert the scenario row and return its id. Centralized so the three
// paths share the same shape (created_by, created/updated audit, etc.).
async function insertScenario({ ayeId, label, description, userId }) {
  const { data, error } = await supabase
    .from('preliminary_budget_scenarios')
    .insert({
      aye_id: ayeId,
      scenario_label: label,
      description: description ?? null,
      // First scenario is recommended by default — most schools create one
      // scenario, lock it, and that's the recommended choice. User can
      // unmark or move the marker later.
      is_recommended: false,
      created_by: userId ?? null,
      updated_by: userId ?? null,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

// Insert a batch of line rows, chunked to keep the request under the
// PostgREST default size cap (~1MB). 500 rows per chunk is comfortable.
async function insertLines(rows) {
  if (rows.length === 0) return
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const { error } = await supabase
      .from('preliminary_budget_lines')
      .insert(slice)
    if (error) throw error
  }
}

// Fetch the COA accounts that should pre-populate a budget. Posting,
// non-pass-thru, active. Used by Start-with-$0 and by the auto-detect
// notification (Commit C).
export async function fetchBudgetableAccounts() {
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('id, code, name, account_type, posts_directly, is_pass_thru, is_active')
    .eq('posts_directly', true)
    .eq('is_pass_thru', false)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('code', { ascending: true })
  if (error) throw error
  return data || []
}

// Path 1: Start with $0.
export async function createBlankScenario({ ayeId, userId, label, description }) {
  const accounts = await fetchBudgetableAccounts()

  const finalLabel = label || (await nextScenarioLabel(ayeId))
  const scenarioId = await insertScenario({
    ayeId, label: finalLabel, description, userId,
  })

  const lines = accounts.map((a) => ({
    scenario_id: scenarioId,
    account_id: a.id,
    amount: 0,
    source_type: 'manual',
    created_by: userId ?? null,
    updated_by: userId ?? null,
  }))

  await insertLines(lines)

  return { scenarioId, importedCount: lines.length }
}

// Find the most recent locked budget snapshot for a *prior* AYE. Looks at
// both preliminary and final snapshots; prefers final if both exist for the
// same prior AYE. Returns null when no eligible snapshot exists.
export async function findPriorLockedBudgetSnapshot(currentAyeId) {
  // Pull the AYEs ordered by start_date desc; the current AYE is the
  // pivot — anything older is "prior". This gives us a stable ordering
  // independent of when the snapshot was actually locked.
  const { data: ayes, error: ayeErr } = await supabase
    .from('academic_years')
    .select('id, label, start_date')
    .order('start_date', { ascending: false })
  if (ayeErr) throw ayeErr

  const pivotIdx = (ayes || []).findIndex((a) => a.id === currentAyeId)
  // No current AYE in list → no prior exists.
  if (pivotIdx === -1) return null
  const priorAyes = ayes.slice(pivotIdx + 1)
  if (priorAyes.length === 0) return null

  for (const aye of priorAyes) {
    const { data: snaps, error: snapErr } = await supabase
      .from('budget_snapshots')
      .select('id, snapshot_type, scenario_label, locked_at, aye_id')
      .eq('aye_id', aye.id)
      .order('snapshot_type', { ascending: false })  // 'preliminary' < 'final' alphabetically; desc puts final first
      .order('locked_at', { ascending: false })
      .limit(1)
    if (snapErr) throw snapErr
    if (snaps && snaps.length > 0) {
      return { snapshot: snaps[0], aye }
    }
  }

  return null
}

// Path 2: Bootstrap from prior AYE. Copies lines from a prior snapshot,
// mapping accounts back into the current COA by code (preferred) or by
// name (fallback). Skipped accounts are returned so the caller can
// surface "X accounts from the prior budget are no longer in your COA."
export async function createScenarioFromPriorAye({ ayeId, userId, label, description, priorSnapshotId }) {
  // Pull the snapshot lines and the current-COA mapping in parallel.
  const [linesResult, accountsResult] = await Promise.all([
    supabase
      .from('budget_snapshot_lines')
      .select('account_code, account_name, amount, is_pass_thru, notes')
      .eq('snapshot_id', priorSnapshotId),
    supabase
      .from('chart_of_accounts')
      .select('id, code, name, posts_directly, is_pass_thru, is_active'),
  ])
  if (linesResult.error) throw linesResult.error
  if (accountsResult.error) throw accountsResult.error

  const snapshotLines = linesResult.data || []
  const accounts = accountsResult.data || []

  // Build code and name lookups, scoped to *eligible* accounts only
  // (posting, non-pass-thru, active). Match by code first, then by name.
  const eligible = accounts.filter(
    (a) => a.posts_directly && !a.is_pass_thru && a.is_active
  )
  const byCode = new Map()
  const byName = new Map()
  for (const a of eligible) {
    if (a.code) byCode.set(a.code, a)
    byName.set(a.name.toLowerCase(), a)
  }

  const matched = []
  const skipped = []

  for (const sl of snapshotLines) {
    // Pass-thru lines shouldn't appear in snapshots (validation prevents it),
    // but if they do somehow, skip — they don't belong in operating budgets.
    if (sl.is_pass_thru) {
      skipped.push(sl.account_name)
      continue
    }
    let acct = sl.account_code ? byCode.get(sl.account_code) : null
    if (!acct) acct = byName.get((sl.account_name || '').toLowerCase())
    if (!acct) {
      skipped.push(sl.account_name)
      continue
    }
    matched.push({ accountId: acct.id, amount: Number(sl.amount) || 0 })
  }

  // De-dup matched by accountId in case the snapshot somehow has dupes
  // OR two different prior names mapped to the same current account.
  const uniqueByAccount = new Map()
  for (const m of matched) {
    // Last write wins; arbitrary but deterministic given source order.
    uniqueByAccount.set(m.accountId, m.amount)
  }

  const finalLabel = label || (await nextScenarioLabel(ayeId))
  const scenarioId = await insertScenario({
    ayeId, label: finalLabel, description, userId,
  })

  const linesToInsert = [...uniqueByAccount.entries()].map(
    ([accountId, amount]) => ({
      scenario_id: scenarioId,
      account_id: accountId,
      amount,
      source_type: 'manual',
      created_by: userId ?? null,
      updated_by: userId ?? null,
    })
  )

  await insertLines(linesToInsert)

  return {
    scenarioId,
    importedCount: linesToInsert.length,
    skippedNames: skipped,
  }
}

// CSV row shape coming in from the parse + validate pipeline:
//   { accountId, amount, notes? }
// Caller has already mapped account_code → accountId and validated that
// the account is posting + non-pass-thru + active.
export async function createScenarioFromCsvRows({ ayeId, userId, label, description, rows }) {
  const finalLabel = label || (await nextScenarioLabel(ayeId))
  const scenarioId = await insertScenario({
    ayeId, label: finalLabel, description, userId,
  })

  const linesToInsert = rows.map((r) => ({
    scenario_id: scenarioId,
    account_id: r.accountId,
    amount: r.amount,
    source_type: 'manual',
    notes: r.notes ?? null,
    created_by: userId ?? null,
    updated_by: userId ?? null,
  }))

  await insertLines(linesToInsert)

  return { scenarioId, importedCount: linesToInsert.length }
}

// Reset a scenario back to empty state (delete all its lines so the
// empty-state prompt re-renders). The scenario row itself is preserved
// so its label / description / state survive — the user is "starting
// over" inside the same scenario, not creating a new one.
//
// Rejected if scenario is locked (the trigger will catch it but we
// short-circuit here for a friendlier error).
export async function resetScenario(scenarioId) {
  const { data: scenario, error: fetchErr } = await supabase
    .from('preliminary_budget_scenarios')
    .select('state')
    .eq('id', scenarioId)
    .single()
  if (fetchErr) throw fetchErr
  if (scenario.state !== 'drafting') {
    throw new Error(
      `Cannot reset a scenario in state "${scenario.state}". Reopen it via the unlock workflow first.`
    )
  }
  const { error } = await supabase
    .from('preliminary_budget_lines')
    .delete()
    .eq('scenario_id', scenarioId)
  if (error) throw error
}

// CSV parse + validate is co-located with the import modal that uses it,
// not exported from here — the modal owns the format-detection + preview
// flow, and these DB helpers stay focused on writes.
