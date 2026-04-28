// Bootstrap helpers for Budget stage scenarios.
//
// Migration 011 generalized the Budget module to support configurable
// workflow stages (Preliminary, Final, Reforecast, etc.). All scenarios
// are scoped to (AYE, Stage) — every bootstrap path here takes both.
//
// Three entry paths plus a fourth for multi-scenario:
//
//   1. createBlankScenario — Start with $0. Pre-populates one row per
//      posting non-pass-thru active account in the COA, all amounts 0.
//   2. createScenarioFromPriorAye — Bootstrap from prior AYE. Copies
//      lines from the most recent prior locked snapshot for the SAME
//      STAGE, falling back to any-stage prior lock if no same-stage
//      exists. Returns which prior was used + skipped accounts.
//   3. createScenarioFromCsvRows — Insert a parsed-and-validated CSV
//      row set as the initial line list. Caller is responsible for
//      parsing, format detection, and validation.
//   4. createScenarioFromCurrent — Multi-scenario "+ New scenario"
//      path; copies from another scenario in the same (AYE, Stage).
//
// All return { scenarioId, importedCount, skippedNames?, sourceLabel? }.

import { supabase } from './supabase'

// Pick the next scenario label given the existing ones for this
// (AYE, Stage). "Scenario 1" / "Scenario 2" / etc. — purely advisory;
// user can rename.
async function nextScenarioLabel(ayeId, stageId) {
  const { data, error } = await supabase
    .from('budget_stage_scenarios')
    .select('scenario_label')
    .eq('aye_id', ayeId)
    .eq('stage_id', stageId)
  if (error) throw error
  const n = (data || []).length
  return `Scenario ${n + 1}`
}

// Insert the scenario row and return its id.
async function insertScenario({ ayeId, stageId, label, description, userId }) {
  const { data, error } = await supabase
    .from('budget_stage_scenarios')
    .insert({
      aye_id: ayeId,
      stage_id: stageId,
      scenario_label: label,
      description: description ?? null,
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
      .from('budget_stage_lines')
      .insert(slice)
    if (error) throw error
  }
}

// Path 4 (multi-scenario): copy from an existing scenario in the same
// (AYE, Stage). Used by "+ New scenario" when the user wants a small-
// diff alternate.
export async function createScenarioFromCurrent({ ayeId, stageId, sourceScenarioId, userId, label, description }) {
  const { data: sourceLines, error } = await supabase
    .from('budget_stage_lines')
    .select('account_id, amount, source_type, source_ref_id, notes')
    .eq('scenario_id', sourceScenarioId)
  if (error) throw error

  const finalLabel = label || (await nextScenarioLabel(ayeId, stageId))
  const scenarioId = await insertScenario({
    ayeId, stageId, label: finalLabel, description, userId,
  })

  const lines = (sourceLines || []).map((l) => ({
    scenario_id: scenarioId,
    account_id: l.account_id,
    amount: Number(l.amount) || 0,
    source_type: l.source_type,
    source_ref_id: l.source_ref_id ?? null,
    notes: l.notes ?? null,
    created_by: userId ?? null,
    updated_by: userId ?? null,
  }))

  await insertLines(lines)

  return { scenarioId, importedCount: lines.length }
}

// Posting non-pass-thru active accounts. Used by Start-with-$0 and the
// auto-detect notification.
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
export async function createBlankScenario({ ayeId, stageId, userId, label, description }) {
  const accounts = await fetchBudgetableAccounts()

  const finalLabel = label || (await nextScenarioLabel(ayeId, stageId))
  const scenarioId = await insertScenario({
    ayeId, stageId, label: finalLabel, description, userId,
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

// Find the most recent locked budget snapshot for a *prior* AYE.
// Strategy: same-stage match first (workflow stages persist across AYEs
// because workflows are per-module-per-school, not per-AYE), then fall
// back to any-stage match if no same-stage prior exists.
//
// Returns:
//   { snapshot, aye, stage_match: 'same' | 'any' } | null
//
// The stage_match field tells the caller which path was used so the UI
// can surface "Copy from AYE 2026 Preliminary Budget" vs. "Copy from
// AYE 2026 Final Budget (no prior Preliminary exists)".
export async function findPriorLockedBudgetSnapshot(currentAyeId, currentStageId) {
  const { data: ayes, error: ayeErr } = await supabase
    .from('academic_years')
    .select('id, label, start_date')
    .order('start_date', { ascending: false })
  if (ayeErr) throw ayeErr

  const pivotIdx = (ayes || []).findIndex((a) => a.id === currentAyeId)
  if (pivotIdx === -1) return null
  const priorAyes = ayes.slice(pivotIdx + 1)
  if (priorAyes.length === 0) return null

  // Pass 1: same-stage match. Walk prior AYEs newest-to-oldest; for
  // each, look for a locked snapshot whose stage_id matches the
  // current stage.
  if (currentStageId) {
    for (const aye of priorAyes) {
      const { data: snaps, error: snapErr } = await supabase
        .from('budget_snapshots')
        .select('id, stage_id, stage_display_name_at_lock, scenario_label, locked_at, aye_id')
        .eq('aye_id', aye.id)
        .eq('stage_id', currentStageId)
        .order('locked_at', { ascending: false })
        .limit(1)
      if (snapErr) throw snapErr
      if (snaps && snaps.length > 0) {
        return { snapshot: snaps[0], aye, stage_match: 'same' }
      }
    }
  }

  // Pass 2: any-stage match. The user gets *some* starting numbers
  // even if the same-stage prior doesn't exist. UI surfaces which
  // stage was used.
  for (const aye of priorAyes) {
    const { data: snaps, error: snapErr } = await supabase
      .from('budget_snapshots')
      .select('id, stage_id, stage_display_name_at_lock, scenario_label, locked_at, aye_id')
      .eq('aye_id', aye.id)
      .order('locked_at', { ascending: false })
      .limit(1)
    if (snapErr) throw snapErr
    if (snaps && snaps.length > 0) {
      return { snapshot: snaps[0], aye, stage_match: 'any' }
    }
  }

  return null
}

// Path 2: Bootstrap from prior AYE.
export async function createScenarioFromPriorAye({ ayeId, stageId, userId, label, description, priorSnapshotId }) {
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

  const uniqueByAccount = new Map()
  for (const m of matched) uniqueByAccount.set(m.accountId, m.amount)

  const finalLabel = label || (await nextScenarioLabel(ayeId, stageId))
  const scenarioId = await insertScenario({
    ayeId, stageId, label: finalLabel, description, userId,
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

// Path 3: CSV.
export async function createScenarioFromCsvRows({ ayeId, stageId, userId, label, description, rows }) {
  const finalLabel = label || (await nextScenarioLabel(ayeId, stageId))
  const scenarioId = await insertScenario({
    ayeId, stageId, label: finalLabel, description, userId,
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
// empty-state prompt re-renders). The scenario row itself is preserved.
export async function resetScenario(scenarioId) {
  const { data: scenario, error: fetchErr } = await supabase
    .from('budget_stage_scenarios')
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
    .from('budget_stage_lines')
    .delete()
    .eq('scenario_id', scenarioId)
  if (error) throw error
}

// CSV parse + validate is co-located with the import modal that uses it,
// not exported from here — the modal owns the format-detection + preview
// flow, and these DB helpers stay focused on writes.
