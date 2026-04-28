// Pure helpers for the Preliminary Budget detail view.
//
// Inputs:
//   accounts — full COA fetch (every account, all flags). Filters happen here.
//   lines    — every preliminary_budget_lines row for the active scenario.
//
// Output: a tree shaped for Display Style A (Section 4.5):
//
//   {
//     income:  TopGroup,   // synthetic INCOME header with rolled-up total
//     expense: TopGroup,   // synthetic EXPENSES header with rolled-up total
//   }
//
// Each TopGroup:
//   { label: 'INCOME' | 'EXPENSES',
//     account_type: 'income' | 'expense',
//     total: number,
//     children: TreeNode[] }   // top-level COA accounts of that type
//
// Each TreeNode:
//   { id, code, name, account_type, posts_directly, is_pass_thru,
//     is_ed_program_dollars, is_contribution, is_active,
//     parent_id, sort_order,
//     line:    { id, amount, source_type, notes } | null,   // only on
//                                                            // posting accts
//     rollup:  number,        // sum of own amount + all descendants
//     children: TreeNode[],   // sorted
//   }
//
// Filtering rules (per architecture Sections 4.2, 8.4 and the build spec):
//
//   - Pass-thru accounts: hidden entirely. Trigger prevents lines from
//     existing for them; we still defensively filter so a pre-trigger
//     row can't leak into the view.
//
//   - Inactive accounts: hidden unless the active scenario has a row for
//     the account with a non-zero amount. In that case we render the
//     row with reduced opacity and an "Inactive" badge — the user keeps
//     it (with warning) or zeros it out and removes the line.
//
//   - Summary accounts: included only if they have at least one
//     descendant we're keeping. Otherwise they'd render as empty
//     headers.

// Build a list of {id, parent_id} pairs and a map for fast lookup.
function indexAccounts(accounts) {
  const byId = new Map()
  for (const a of accounts) byId.set(a.id, a)
  return byId
}

// Walk descendants (any depth) of a starting account. Returns an iterable
// of account ids — order is depth-first for determinism.
function descendantIds(rootId, childrenByParent) {
  const out = []
  const stack = [...(childrenByParent.get(rootId) || [])]
  while (stack.length > 0) {
    const a = stack.pop()
    out.push(a.id)
    const kids = childrenByParent.get(a.id) || []
    for (const k of kids) stack.push(k)
  }
  return out
}

function sortAccounts(list) {
  return [...list].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    const ac = a.code || ''
    const bc = b.code || ''
    if (ac && bc && ac !== bc) return ac.localeCompare(bc)
    return a.name.localeCompare(b.name)
  })
}

export function buildBudgetTree(accounts, lines) {
  const lineByAccount = new Map()
  for (const l of lines) lineByAccount.set(l.account_id, l)

  const byId = indexAccounts(accounts)

  const childrenByParent = new Map()
  for (const a of accounts) {
    const list = childrenByParent.get(a.parent_id || null) || []
    list.push(a)
    childrenByParent.set(a.parent_id || null, list)
  }

  // Decide which accounts to keep.
  //
  // Phase 1: drop pass-thru and any inactive account that doesn't have a
  // non-zero line. (An inactive summary parent with no posting children
  // surfacing data is also dropped — it'd be a dead branch.)
  //
  // Phase 2: drop summary accounts whose entire subtree is gone.

  const lineNonZero = (a) => {
    const l = lineByAccount.get(a.id)
    if (!l) return false
    return Number(l.amount) !== 0
  }

  const keepInitial = new Set()
  for (const a of accounts) {
    if (a.is_pass_thru) continue
    if (a.is_active) {
      keepInitial.add(a.id)
    } else if (lineNonZero(a)) {
      keepInitial.add(a.id)
    }
  }

  // For summary accounts, demand at least one kept descendant; otherwise
  // drop. Iterate bottom-up by walking from leaves; we can fake this by
  // repeating until stable. With 100s of accounts the naive fixed-point
  // loop is cheap.
  let changed = true
  while (changed) {
    changed = false
    for (const a of accounts) {
      if (!keepInitial.has(a.id)) continue
      if (a.posts_directly) continue
      // Summary: needs a kept descendant
      const kids = childrenByParent.get(a.id) || []
      const hasKeptKid = kids.some((k) => keepInitial.has(k.id))
      if (!hasKeptKid) {
        keepInitial.delete(a.id)
        changed = true
      }
    }
  }

  // Build TreeNodes for every kept id. Parent pointers reference TreeNode,
  // not the raw account — easier to compute rollups in a second pass.
  const nodeById = new Map()
  for (const a of accounts) {
    if (!keepInitial.has(a.id)) continue
    const line = lineByAccount.get(a.id) || null
    nodeById.set(a.id, {
      id: a.id,
      code: a.code,
      name: a.name,
      account_type: a.account_type,
      posts_directly: a.posts_directly,
      is_pass_thru: a.is_pass_thru,
      is_ed_program_dollars: a.is_ed_program_dollars,
      is_contribution: a.is_contribution,
      is_active: a.is_active,
      parent_id: a.parent_id,
      sort_order: a.sort_order,
      line: line
        ? {
            id: line.id,
            amount: Number(line.amount) || 0,
            source_type: line.source_type,
            notes: line.notes,
          }
        : null,
      rollup: 0,
      children: [],
    })
  }

  // Wire children. Sort each child list once we know the kept set.
  for (const a of accounts) {
    if (!keepInitial.has(a.id)) continue
    if (a.parent_id && nodeById.has(a.parent_id)) {
      const parentNode = nodeById.get(a.parent_id)
      parentNode.children.push(nodeById.get(a.id))
    }
  }
  for (const node of nodeById.values()) {
    node.children = sortAccounts(node.children)
  }

  // Compute rollup totals (own line amount + all descendants' rollups).
  // Recursive walk is safe — the COA is a finite tree by trigger.
  function computeRollup(node) {
    let total = node.line ? node.line.amount : 0
    for (const c of node.children) {
      total += computeRollup(c)
    }
    node.rollup = total
    return total
  }

  // Top-level kept accounts grouped by type.
  const topLevelKept = []
  for (const a of accounts) {
    if (!keepInitial.has(a.id)) continue
    if (!a.parent_id) topLevelKept.push(nodeById.get(a.id))
  }
  const topLevelSorted = sortAccounts(topLevelKept)

  const incomeRoots  = topLevelSorted.filter((n) => n.account_type === 'income')
  const expenseRoots = topLevelSorted.filter((n) => n.account_type === 'expense')

  // Compute rollups for every kept node.
  for (const root of topLevelSorted) computeRollup(root)

  const incomeTotal  = incomeRoots.reduce((s, n) => s + n.rollup, 0)
  const expenseTotal = expenseRoots.reduce((s, n) => s + n.rollup, 0)

  return {
    income: {
      label: 'INCOME',
      account_type: 'income',
      total: incomeTotal,
      children: incomeRoots,
    },
    expense: {
      label: 'EXPENSES',
      account_type: 'expense',
      total: expenseTotal,
      children: expenseRoots,
    },
  }
}

// Compute the full KPI bundle from the same (accounts, lines) input.
// Separated from the tree builder because the KPI sidebar and the tree
// can render in different cycles.
export function computeKpis(accounts, lines) {
  const accById = new Map(accounts.map((a) => [a.id, a]))

  let totalIncome = 0
  let totalExpense = 0
  let edProgramDollars = 0
  let contributionsTotal = 0

  for (const l of lines) {
    const a = accById.get(l.account_id)
    if (!a) continue
    // Defensive: pass-thru shouldn't appear in lines (trigger blocks),
    // but if it leaks in, exclude from totals.
    if (a.is_pass_thru) continue
    const amt = Number(l.amount) || 0
    if (a.account_type === 'income') {
      totalIncome += amt
      if (a.is_ed_program_dollars) edProgramDollars += amt
      if (a.is_contribution) contributionsTotal += amt
    } else if (a.account_type === 'expense') {
      totalExpense += amt
    }
  }

  // % Personnel — sum amounts under any top-level expense account named
  // "Personnel" (case-insensitive). Brittle but matches Libertas's
  // structure; future refinement makes this a school-configurable setting
  // (see CLAUDE.md note in Commit G).
  let personnelTotal = 0
  let personnelMatched = false
  const personnelTopLevel = accounts.find(
    (a) =>
      !a.parent_id &&
      a.account_type === 'expense' &&
      a.name.trim().toLowerCase() === 'personnel'
  )
  if (personnelTopLevel) {
    personnelMatched = true
    // Build child index for this AYE
    const childrenByParent = new Map()
    for (const a of accounts) {
      const list = childrenByParent.get(a.parent_id || null) || []
      list.push(a)
      childrenByParent.set(a.parent_id || null, list)
    }
    const personnelIds = new Set([personnelTopLevel.id])
    for (const id of descendantIds(personnelTopLevel.id, childrenByParent)) {
      personnelIds.add(id)
    }
    for (const l of lines) {
      if (personnelIds.has(l.account_id)) {
        personnelTotal += Number(l.amount) || 0
      }
    }
  }

  return {
    totalIncome,
    totalExpense,
    netIncome: totalIncome - totalExpense,
    edProgramDollars,
    edProgramRatio:
      totalExpense === 0 ? null : edProgramDollars / totalExpense,
    contributionsTotal,
    pctPersonnel:
      !personnelMatched || totalExpense === 0
        ? null
        : personnelTotal / totalExpense,
  }
}

// In-order list of editable cell coordinates ({nodeId, accountId}) for a
// given tree, used by Tab/Shift+Tab to step the focus. "Editable" =
// posting account with a line attached AND active (inactive lines render
// in warning treatment but stay editable so the user can zero them out).
export function editableOrder(tree) {
  const out = []
  function walk(node) {
    if (node.posts_directly && node.line && (node.is_active || node.line.amount !== 0)) {
      out.push({ nodeId: node.id, accountId: node.id })
    }
    for (const c of node.children) walk(c)
  }
  for (const c of tree.income.children) walk(c)
  for (const c of tree.expense.children) walk(c)
  return out
}

// Find accounts that are budget-eligible (posting, non-pass-thru, active)
// but not present in the scenario's lines. Used by the auto-detect
// notification banner.
export function findUnbudgetedAccounts(accounts, lines) {
  const inBudget = new Set(lines.map((l) => l.account_id))
  return accounts.filter(
    (a) => a.posts_directly && !a.is_pass_thru && a.is_active && !inBudget.has(a.id)
  )
}
