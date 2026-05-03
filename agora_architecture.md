# Agora by Praesidium — Architecture Design Document

**Version 3.8.8** — May 3, 2026 — Tuition-C.1: drop unused `school_id` parameter from `get_latest_locked_budget` RPC (single-tenant alignment). Full version history at the end of this document.

---

## Purpose of this document

This is the canonical architecture reference for Agora by Praesidium. It captures the platform's design decisions, schema patterns, module relationships, and cross-cutting principles as agreed during design conversations between the Praesidium Foundation Board Chair (Jenna Salazar) and Claude.

Future development sessions — both architecture refinements and Claude Code build prompts — should reference this document as the source of truth. Where conflicts arise between this document and earlier conversation snippets, this document takes precedence.

This document is organized for **reference**, not for narrative. Each section stands alone. Read top-to-bottom for full context, or jump to specific sections as needed.

---

## Table of Contents

1. Product Identity & Naming
2. Foundational Principles
3. Module Ecosystem
4. Chart of Accounts (the spine)
5. Snapshots, Redaction, and PDF Architecture
6. Strategic Plan Module
7. Operational Planning Modules (Enrollment Estimator, Tuition Worksheet, Staffing)
8. Budget Module (the integration layer)
9. Cross-Cutting Concerns (Audit Logs, AYE Lifecycle, School Settings)
10. Design Standards (Codified)
11. Future Modules (Acknowledged but Not Yet Designed)
12. Build Sequence Guidance

---

## 1. Product Identity & Naming

**Praesidium Foundation, Inc.** — the parent organization that owns the product, infrastructure, and IP.

**Agora by Praesidium** — the platform/product brand. Generally referred to as "Agora" in conversation; "Agora by Praesidium" in formal contexts.

**[School] Agora** — naming pattern for individual school instances. Libertas Academy's instance is "Libertas Agora." Future schools will be "Veritas Agora," "Covenant Agora," etc.

**Multi-tenancy model**: Currently single-tenant per deployment. Schema does NOT yet have `org_id` columns. Multi-tenant migration deferred until first additional school onboards. Architecture is multi-tenant *in spirit* (everything that should be configurable per school is) but single-tenant in implementation (one deployment serves one school for now).

**URL strategy**: Production runs at `agora-praesidium.vercel.app` currently. Future home is `agoraweb.app`, with each school getting a subdomain (e.g., `libertas.agoraweb.app`).

**Customer relationship**: Libertas Academy is the founding customer with a perpetual free instance. Praesidium owns the product and IP. Other schools onboard as paying customers (commercial model TBD).

---

## 2. Foundational Principles

These principles apply across all modules and inform every design decision.

### 2.1 Permissions are user-based, not role-based

Agora does NOT define "roles" with bundled permissions. Each user's access is configured individually:

- **Module-level permission**: per (user, module) pair, one of: `view`, `edit`, `submit_lock`, `approve_lock`, `admin`
- **Detail-visibility flags** (orthogonal to module permissions): `can_view_staff_compensation`, `can_view_family_details`, `can_view_donor_details`

This handles the reality that small organizations adapt permissions to people, not the reverse. The same job title (e.g., "Office Manager") can be held by people with very different responsibilities depending on who's there. When personnel changes, the new person's permissions are configured fresh.

System Admins configure all permissions. There are no role presets.

### 2.2 Single accountability principle

Where actions or initiatives have owners, there must be a single Primary OPR (Office of Primary Responsibility). Supporting roles are explicit and distinct. The system never displays "everyone is in charge."

### 2.3 Lock cascade with named, justified override

When a downstream module references upstream modules' approved data (e.g., Final Budget references locked Staffing), the system enforces lock-order rules. These rules can be overridden by a System Admin with:

- Required justification text (mandatory, free-form)
- Timestamp (auto)
- Override author (auto)
- Logged in `change_log` with `display_priority='override'`
- Visible in audit trail forever

Override is the exception, not the rule, but it's available because reality doesn't always cooperate with idealized workflows.

### 2.4 Confidential data redaction

Snapshots store complete data. Rendering filters by viewer permissions. The same snapshot serves all viewers at appropriate detail levels. Applies to UI views and PDF outputs equally.

Sensitive content includes: individual staff compensation, individual family financial details, individual donor amounts.

### 2.5 DRAFT marking on non-final outputs

Any PDF generated from data NOT in a locked/adopted state must be prominently marked DRAFT:
- Diagonal "DRAFT" watermark on every page
- Header banner "DRAFT — Not Yet Approved"
- Footer note with date and version reference

The DRAFT mark is more prominent than the approval mark because consequences of mistaking a DRAFT for final are larger than the reverse.

### 2.6 Approved-by indicator on locked outputs

Every PDF generated from a locked/adopted snapshot includes a discreet but visible footer:

```
This document is a snapshot of approved data.
Approved [date] by [name]
Snapshot ID: [unique-reference]
```

### 2.7 Auto-pulled comparison data, never manual

When the system shows comparison values (e.g., "AYE 2025 actuals" alongside "AYE 2026 budget"), those values are pulled from the database in real-time. There is no manual maintenance of comparison columns. This prevents the failure mode where stale comparison data ends up in board reports.

### 2.8 Linkage is optional but easy

Cross-module linkages (Operational Plan Action → Budget line, Strategic Initiative → ENDS Item, etc.) are optional. The system surfaces linkages prominently when they exist, makes them invisible when absent, and never requires them. Users link when it serves them; the system rewards rather than demands.

### 2.9 Excellence is an act of worship

Document and UI quality is non-negotiable. Praesidium's name is on every output. The product reflects the values of the organization producing it. See Section 10 (Design Standards) for codification.

---

## 3. Module Ecosystem

### 3.1 Three-layer architecture

```
GOVERNANCE LAYER
  Strategic Plan (three instruments — see Section 6)
  Board Policies (future)
  Accreditation (future)
  Board Calendar (future)
  Monitoring Calendar (future)
  Board & Committees (read-only view; edit via Settings)
  Meetings (future)
  Documents (future)
                ↓ informs and constrains
                
PLANNING LAYER (per-AYE)
  Enrollment Estimator
  Tuition Worksheet (Stage 1: Planning, January — Stage 2: Audit, September with family detail)
  Staffing
  Preliminary Budget (integrates above)
  Final Budget (integrates Tuition Audit + revised plans)
                ↓ measured against

ACTUALS LAYER (continuous, ongoing)
  Advancement (continuous monthly headcount + recruitment funnel)
  Cash Flow (future — monthly QB upload)
```

### 3.2 Sidebar navigation

```
Dashboard

GOVERNANCE
  Board Calendar          (future)
  Monitoring Calendar     (future)
  Board Policies          (future)
  Strategic Plan
  Accreditation           (future)
  Board & Committees
  Meetings                (future)
  Documents               (future)

OPERATIONS
  Head of School Report   (future)
  Operations Policies     (future)
  Documents               (future)

DEVELOPMENT
  Fundraising             (future)
  Capital Plan            (future)
  Documents               (future)

PLANNING
  Enrollment Estimator                          (future)
  ▾ Tuition
       Planning
       Audit                                    (Stage 2 — Phase 4 follow-on)
  Staffing                                      (future)
  ▾ Budget
       Preliminary
       Final

ACTUALS
  Advancement
  Cash Flow               (future)

ADMIN
  Academic Years
  Users & Access
  School Settings
    ├─ Organization
    ├─ Brand
    ├─ Financial
    └─ Module Configuration
```

**Top-level category collapse**: GOVERNANCE / OPERATIONS / PLANNING / ACTUALS / ADMIN are each collapsible. The chevron and label both toggle the section. Default on first visit: all expanded. Collapse state persists across sessions in `localStorage` under the key `agora.sidebar.collapsedSections` (an array of section ids). When the current route lives in a collapsed section, that section auto-expands so the user can see their location in the sidebar — applied on every route change so deep-links and back-navigation both work. Dashboard sits at the top, not under any category, and is not collapsible. School Settings inside ADMIN has its own sub-item expand/collapse (independent of the top-level ADMIN toggle) using the same chevron pattern.

**Item-level collapse for staged modules**: within the PLANNING section, modules whose work is split across stages render as collapsible parents with stage children rather than as flat items. Today: Tuition has children (Planning today; Audit when Phase 4 ships Stage 2) and Budget has children (Preliminary and Final). Single-stage modules in the section (Enrollment Estimator, Staffing) remain top-level until they grow stages of their own. Parent click toggles expand/collapse only — it does not navigate; navigation happens via clicking a child. The pattern matches the section-header collapse behavior at one level of nesting deeper: the chevron rotates between expanded (▾) and collapsed (▸); collapse state is component-local (re-expands on a stage-route navigation match); children sit under the parent with one level of indent. The architecture commits to the structure for both Tuition stages today even though the Audit child does not yet have an implemented destination — the Sidebar component renders only stages that have implemented routes, and the second child appears when Phase 4d ships Stage 2 setup. Future modules with staged work (Strategic Plan when its workflow becomes multi-stage; Accreditation when it ships) adopt the same parent-child sidebar pattern.

**Sidebar shows places (where to work); the governance calendar (when built) shows times (when work happens)**. Numbers are deliberately not used in sidebar items — temporal sequence is the calendar's job, not the sidebar's. The sidebar's job is spatial: which module / which stage to navigate to. This separation kept the sidebar workable when the previous numbered "1. Enrollment Estimator → 6. Final Budget" sequence collided with the two-stage Tuition reality (a single number would have to span both Planning and Audit, or two numbers would have to break the cyclical sequence).

### 3.3 Time-scoping across modules

| Module | Time scope | Lifecycle |
|---|---|---|
| Strategic Financial Plan | Multi-year (e.g. AYE 25–28) | Adopted, monitored, occasionally revised |
| Strategic ENDS Priorities | Multi-year (currently 1, target 3+) | Board-adopted, periodically renewed |
| Operational Strategic Plan | Single AYE | HoS-submitted, Board-adopted, May/July |
| Enrollment Estimator | Single AYE | Multiple scenarios; locked once recommended |
| Tuition Stage 1 (Planning) | Single AYE | Locked once per AYE (typically January) |
| Tuition Stage 2 (Audit) | Single AYE | Locked once per AYE (typically September, after enrollment finalizes) |
| Staffing | Single AYE | Locked once per AYE (typically late summer) |
| Preliminary Budget | Single AYE | Locked April |
| Final Budget | Single AYE | Locked October (after Tuition Stage 2) |
| Advancement | Continuous | Monthly updates, year-round |
| Board Composition | Single AYE, with carryforward | Live editing; snapshotted at AYE close |
| Committees | Multi-year (committees) + per-AYE (memberships) | Live editing; snapshotted at AYE close |

### 3.4 Lock cascade rules

**Rule 1**: A downstream module cannot be locked unless its upstream sources are locked.

**Exception for Preliminary Budget**: Preliminary Budget can be locked with Staffing in a non-locked (projection) state. This matches reality — Staffing isn't typically finalized until just before school starts (August/September), well after April Preliminary Budget approval. Final Budget DOES require locked Staffing.

**Rule 2**: Locking an upstream module after a downstream is locked creates a "stale data" warning, not an error. The downstream snapshot stays preserved; a banner alerts users that re-locking is recommended.

**Override**: Per Section 2.3, System Admins can override lock cascade rules with required justification.

**Granularity**: Cascade rules in `school_lock_cascade_rules` reference module codes, not stage IDs (Section 3.8). The whole Budget module shares one set of upstream requirements; per-stage variations (e.g., "Final Budget requires a locked Preliminary Budget but not a locked Tuition Worksheet") are not yet in scope. When that becomes a real need, the table grows a nullable `stage_type` column with rules optionally scoped to a stage type, and the validator joins on that.

**Unlock has no cascade enforcement today.** The unlock workflow (§8.13) doesn't check upstream cascade rules — there are no upstream modules that meaningfully constrain unlocking a Budget snapshot. It also doesn't check downstream consumers, because no downstream consumers of locked Budget snapshots exist in current live data (Final Budget tables not yet built; Strategic Plan not yet built). Downstream-consumer awareness is an extension point for later: when Final Budget or Strategic Plan ship and reference locked Budget snapshots, unlock-time validation will need to either block or warn when consumers exist. The schema and function signatures are already shaped to accept that addition.

**Stage initialization cascade.** A stage's setup gateway depends on whether the stage is the first in its workflow. First stages (lowest sort_order in `module_workflow_stages` for the workflow) accept the original setup options (bootstrap from prior AYE, CSV upload, fresh start). Non-first stages require a locked predecessor stage in the same AYE — setup is blocked until at least one predecessor is locked, and seeding occurs from a user-selected predecessor snapshot via `create_scenario_from_snapshot` (Migration 019). This applies to Libertas's Final Budget today and generalizes to any future multi-stage workflow. See §8.14 for the full setup model. Note: this is distinct from the lock cascade rules above. Lock cascade is about whether a stage CAN BE LOCKED based on upstream-module state (Tuition, Staffing, etc.); stage initialization cascade is about whether a stage CAN BE SET UP based on prior stages within the same workflow.

### 3.5 Module-scoped governance authority in lock/unlock workflows

Lock and unlock workflows are governance-weight: they record who approved an artifact and who reopened it. The **system mechanics** for these workflows are uniform across every lockable module — a permission grant (`approve_lock`, `approve_unlock`), a distinct-identity constraint between the requester and the second approver, and the change_log signatures. The **governance authority** named in user-facing copy is, by contrast, **module-specific**.

**The principle.** Each lockable module declares the canonical governance authority that the user-facing copy names. The Budget module is fiscal, so its modal and banner copy names the **Treasurer (or designee)**. A future Strategic Plan module is governance, so its copy will name the **Board Chair (or designee)**. An Accreditation module would name the **Head of School (or designee)**. The pattern: a single canonical role per module, with "or designee" trailing it so a school whose role labels differ (or whose Treasurer is temporarily unavailable) can still operate without rewriting the copy.

**What the system enforces.** Two things, both generic:

1. **The permission grant.** Whoever records approval_2 must hold the relevant permission (`approve_unlock` for unlock, `approve_lock` for lock). The grant is per-user, recorded in `module_permission_grants`. The system never inspects role labels.
2. **The distinct-identity constraint.** Approval_2 must come from a different identity than approval_1 / the requester. Enforced at three layers (CHECK constraint, SECURITY DEFINER function, application validator).

**What the system does NOT enforce.** Which user holds the named role. The procedural mapping of "the Treasurer is Holly Bauers" or "the Board Chair is Jenna Salazar" is school-level configuration that lives outside the database — a school can grant `approve_unlock` to whoever the procedural Treasurer is at any moment. Designation fallbacks ("if the Treasurer is unavailable, the Board Chair acts as designee") are also organizational practice, not system rules. The system's only constraint is that whoever records approval_2 must (a) hold the permission and (b) be a different identity than the requester.

**Why module-scoped, not system-wide.** A platform-wide "Approver" label would be honest about the system mechanics but useless to the user reading the copy. "Request unlock from the Approver" reads as bureaucratic placeholder text. "Request unlock from the Treasurer" reads as the actual sentence the school's governance documents use. The cost of module-specific copy is low (each module owns one canonical role string) and the readability benefit is high.

**Where the canonical role is named.** In each module's user-facing copy: lock/unlock modal bodies (RequestUnlockModal, ApproveUnlockModal, etc.), the LockedBanner, the inline guidance under approval-related buttons. Module-specific authority paragraphs in §8.13 (Budget) and parallel sections in future module specs codify the chosen role.

### 3.6 Cross-module data flow

Data flows downstream only:

- Advancement → Enrollment Estimator (continuous monthly headcount as starting point for projections)
- Enrollment Estimator → Tuition Stage 1 (per-grade counts inform the projected family distribution)
- Enrollment Estimator → Budget (student count for cost-per-student calculations)
- Tuition Stage 1 (Tuition Planning, locked) → Preliminary Budget (revenue projections from locked planning rates)
- Tuition Stage 2 (Tuition Audit, locked) → Final Budget (per-family actuals replace projection)
- Staffing → Budget (compensation totals for personnel accounts)
- Strategic Plan → all modules (target comparisons in KPIs)

Tuition is a two-stage module per §7.3; the per-family enrollment audit that was previously framed as a separate "Enrollment Audit" module is Tuition Stage 2. Cross-module lock cascade rules — which upstream lock states are required to lock each downstream module — are formalized in §7.5.

Budget is read-only for upstream-fed values. To change them, edit the upstream source.

### 3.7 Custom KPI registry per school

In addition to universal KPIs, each school can define custom KPIs in `school_custom_kpis`. These appear in dashboards, comparison views, and target-setting alongside standard KPIs. Formula stored as text now; structured formula support is future work.

### 3.8 Module workflows and stages

Modules with cycle-based work (Budget today; Strategic Plan and Accreditation when they ship) support **configurable workflows**. Each module gets one workflow per school; each workflow has ordered **stages**; each stage can be locked and snapshotted independently.

**Hybrid taxonomy.** Stage labels are school-specific, but each stage carries a **stage type** drawn from a curated catalog. The catalog (`stage_type_definitions`) is curated by Praesidium — schools cannot add types — and ships with `working`, `preliminary`, `adopted`, `reforecast`, and `final`. Each type carries a `semantic_category` (`draft` / `approved` / `revision` / `closing`) and an `is_terminal` flag, which lets Agora reason about stages for KPI capture, reporting, and cascade rules without having to inspect free-form display names.

**Why hybrid.** A "Final Budget" at one school means the same thing as an "Adopted Budget" at another and a "FY27 Closing Budget" at a third — the school's chosen vocabulary differs. Free-form labels alone leave Agora unable to identify the right scenario for cross-module joins ("which budget did we lock for this AYE?"). Pure typing alone strips the school's vocabulary and forces every UI string into Praesidium-speak. Display-name × type covers both: the user sees their words, Agora sees the type.

**Schema** (Migration 010):

```
stage_type_definitions
  code                 text primary key   -- 'preliminary' | 'final' | …
  display_name         text
  description          text
  semantic_category    text               -- 'draft' | 'approved' | 'revision' | 'closing'
  is_terminal          boolean            -- e.g. 'final' is terminal; 'reforecast' is not
  sort_order           int

module_workflows
  id, module_id, name, description,
  is_active boolean,
  audit fields
  -- one active workflow per module per school

module_workflow_stages
  id, workflow_id, stage_type (FK to stage_type_definitions.code),
  display_name, short_name, description,
  sort_order, target_month, audit fields
  -- unique (workflow_id, display_name) and unique (workflow_id, sort_order)
```

**Helper.** `get_module_workflow_stages(module_code)` returns the active workflow's stages in sort order with `is_terminal` joined in. Used by the sidebar (to render budget stage items dynamically) and by the page (to load stage metadata from `:stageId` in the URL).

**Libertas's seed.** Two stages on the Budget workflow: Preliminary Budget (type `preliminary`, target April) and Final Budget (type `final`, target October). When a school onboards, their workflow is seeded explicitly; the Settings UI for editing workflows is queued for Phase R2.

**Cross-module references.** Downstream modules that need "the locked budget for this AYE" should match by stage type, not by display name — e.g., "the most recent locked snapshot whose `stage_type_at_lock` is terminal." This keeps integration code independent of the school's chosen labels.

---

## 4. Chart of Accounts (the spine)

The Chart of Accounts is the foundational data structure that every financial module rests on.

### 4.1 Conceptual model

Self-referential hierarchical structure that mirrors the school's actual accounting system (typically QuickBooks). Preserves arbitrary depth — Libertas's QB has 4-level hierarchies (e.g., Educational Program Revenue → Tuition → Tuition Discounts → Teacher Discount).

Every account is either a **posting account** (`posts_directly = true`) — money posts to it directly in QuickBooks — or a **summary account** (`posts_directly = false`) — pure rollup, value comes from children. Posting accounts can have children; summary accounts must have children (or they're useless). Governance flags attach only to posting accounts. KPI math sums direct-post amounts of flagged posting accounts; summary accounts contribute nothing directly because they have no direct posts.

### 4.2 Schema

```
chart_of_accounts
  id                   uuid, primary key
  parent_id            uuid, FK to chart_of_accounts (nullable; NULL = top-level)
  code                 text (optional QB-style code, e.g. "4192")
  name                 text (e.g. "Teacher Discount", "Personnel")
  account_type         enum ('income', 'expense')

  -- Posting vs summary
  posts_directly       boolean (true = money posts to this account directly;
                                false = pure rollup of children, no direct posts)

  -- Governance flags (only meaningful when posts_directly = true)
  is_pass_thru         boolean (excluded from operating budget totals)
  is_ed_program_dollars boolean (only meaningful: account_type='income' AND NOT is_pass_thru)
  is_contribution      boolean (only meaningful: account_type='income' AND NOT is_pass_thru)

  -- Lifecycle
  is_active            boolean (deactivated accounts hide from selection lists, preserve history)

  -- Display
  sort_order           int (typically matches code ordering)
  notes                text (free-form, internal use)

  audit fields
```

### 4.3 Design rules

- `account_type` is set on the root and inherited by descendants in application logic. Constraint: a child's `account_type` must match its parent's. Enforced via trigger.
- Governance flags only apply to posting accounts (`posts_directly = true`). UI prevents flagging summary accounts; trigger rejects flagged summaries at write time.
- A posting account may have children without restriction. A summary account is only meaningful when it has children.
- `is_active = false` is soft delete. Historical references stay valid.
- Budget rows reference posting accounts only (`posts_directly = true`), validated via `is_posting_account()` in budget triggers.

### 4.4 Budget row schema

```
preliminary_budget_lines    (and final_budget_lines, same shape)
  id                 uuid
  scenario_id        uuid (FK to preliminary_budget_scenarios)
  account_id         uuid (FK to chart_of_accounts; must reference a posting
                          account where posts_directly = true)
  amount             numeric (can be negative for contra-revenue like discounts)
  source_type        enum ('manual', 'linked_tuition', 'linked_staffing', 'linked_enrollment')
  source_ref_id      uuid (nullable; references the source row when source_type != 'manual')
  linked_strategic_initiative_id uuid (FK, optional)
  linked_operational_action_id uuid (FK, optional)
  notes              text
  audit fields
  
  -- Constraint: at most one row per (scenario_id, account_id)
```

### 4.5 Display: hierarchy preserved

Budget UI displays the full hierarchy (Display Style A from design conversation):

```
PERSONNEL                                       $852,759
  Staff Salaries                  $605,749
  Substitute Teachers              $11,628
  Hourly Wages                    $148,658
  Taxes                            $68,943
  Subcontractors                   $17,780

EDUCATION PROGRAMS                               $84,400
  Teacher Supplies                  $4,200
  Athletic Program                 $75,000
  ...
```

Categories are visible with rollup totals. Click to expand/collapse. Entry happens at posting-account level (any account where `posts_directly = true`, leaf or parent). Rollups computed at render time.

### 4.6 CSV import / export

The COA management UI supports CSV import and export from the Financial settings page. Import handles two source formats; export emits the generic format so round-tripping works.

**Source formats (auto-detected on upload)**:

1. **Generic Agora format** — same shape as the export. Columns: `code, subaccount_of, name, account_type, posts_directly, is_pass_thru, is_ed_program_dollars, is_contribution, sort_order, is_active, notes`. The `subaccount_of` column uses colon-delimited path of ancestor account names (matches QB convention).
2. **QuickBooks Online (QBO) Account List CSV** — native QBO export format. Real exports include 2–3 metadata rows before the actual header (e.g., `Account List` / company name / blank); the parser scans the first 20 rows and discards anything above the recognized header. The header itself uses these exact column names: **`Account #`** (maps to `code`), **`Full name`** (colon-delimited subaccount path; maps to `subaccount_of` + `name`), **`Type`** (maps to `account_type`), **`Detail type`** (ignored — informational only). The `Type` column uses **`Income`** and **`Expenses`** (note: plural for expense). Governance flags aren't present in QBO exports — every imported account defaults to `posts_directly = true` and all flags `false`; the user sets these during the post-import guided review.

QBO rows of types other than Income / Expenses (`Bank`, `Accounts Receivable`, `Accounts Payable`, `Equity`, `Credit Card`, `Other Asset`, `Other Liability`, etc.) are **rejected with a budgeting-only message** and surfaced in the validation step. The user chooses to skip these rows and continue, or cancel and filter the CSV first. They are not silently dropped.

**Canonical test artifact**: `test/fixtures/Libertas_Academy_Account_List.csv` is preserved in the repo for regression testing of the QBO format path. It exercises: 3 metadata rows before header, plural `Expenses` type, embedded comma in a quoted account name, 4-level nesting depth.

**Brand-neutral framing in user copy**: Although the parser today specifically handles QuickBooks Online's Account List export format, user-facing copy throughout Agora uses software-neutral language ("your accounting software", "your books", "standard account list format"). The format-detected confirmation banner does name the format ("QuickBooks Account List format detected") because that's a factual identification of what was detected, not promotional copy. Future support for other accounting software (Xero, Sage, Aplos, etc.) will extend the parser without requiring copy changes. See Section 10.8 for the language standard.

**Parser responsibilities**: the import path runs through these stages —
1. Parse CSV (handles BOM, quoted fields with commas, embedded newlines).
2. Dynamic header detection: scan up to 20 rows for either `subaccount_of` (generic) or `Full name` + `Type` (QBO). Discard everything above the recognized header.
3. Format-specific normalization into a uniform internal row shape carrying `_lineNo` for accurate validation error messages.
4. Validation: missing names, invalid types, duplicate paths, duplicate codes, path resolution, type consistency, cycle detection.
5. Conflict mode + import.

**Five-stage import flow**:

1. **Upload** — file picker (.csv only). Parsing is client-side; nothing writes to the database until confirmation.
2. **Parse + format detection** — banner shows "Detected: …" so the user can confirm. Parse failures show clear error and let user retry.
3. **Validation + preview** — every row validated before showing the preview tree:
   - Required fields present
   - `account_type` is `income` or `expense`
   - Subaccount paths resolve to other rows in the same file (no orphans)
   - No cycles in subaccount paths
   - No duplicate codes
   - Type consistency (subaccount type matches every ancestor's type)
   - If errors: show error list with row numbers, user fixes file and retries (no proceed)
   - If clean: render preview tree with subaccount nesting, posting/summary indicator, and any flags from the file
4. **Conflict mode** — only shown if COA is non-empty:
   - **Append** (default): inserts new accounts; rejects entire import if any code or full-path conflicts with existing
   - **Replace**: requires explicit "I understand" checkbox; auto-downloads current COA as backup CSV before deletion; then deletes all existing accounts and inserts the imported set
5. **Import + guided flag review** — writes to database. For QBO-format imports (where flags are absent), the importer **automatically routes** to a bulk flag-review grid of all imported accounts with Kind dropdown (Posting / Summary) and three flag checkboxes per row, so the user can configure 70+ accounts efficiently in one screen. This is mandatory next-step work for QBO imports — the user does not see the populated tree until they Save All or Skip from the grid. For generic-format imports where flags came from the CSV, the grid is offered as an optional review on the success page.

**Bulk flag review grid behavior**:
- **Tree-order display**: rows are sorted in depth-first traversal order; the Name column is indented (16px per level) so the hierarchy is visible at a glance.
- **Smart defaults**: accounts with no subaccounts default to Posting; accounts with subaccounts default to Summary. User overrides per row (since posting parents like a "Revenue – Tuition" line that posts gross do exist and need flagging).
- **Flag interaction rules**:
  - All three flag checkboxes are disabled when Kind is Summary (DB trigger would reject otherwise).
  - Ed Program $ and Contribution are disabled when Type ≠ Income.
  - **Pass-Thru and (Ed Program $ / Contribution) are mutually exclusive** — checking any one disables the other(s); switching auto-clears the conflicting flag.
- **Save All** commits all changes (one UPDATE per row that actually changed) and closes the panel, returning to the financial settings page with the populated, flagged tree.
- **Skip for now** leaves accounts as-imported (Posting=true, all flags=false) and closes the panel. User can edit individually via the tree later.

**Transactional behavior**: each insert is its own Supabase request (no client-side transactions). A best-effort rollback on mid-flight failure deletes already-inserted rows by id. For Replace mode specifically, if the wipe succeeds but inserts fail, the COA is left empty; the auto-downloaded backup CSV from step 4 is the recovery path.

**Permissions**: import requires `admin` permission on `chart_of_accounts` (potentially destructive). Export requires `view` (read-only). UI gates accordingly.

**For Libertas**: ~70 accounts, one QB Account List CSV, ~15–20 minutes including the flag review.

### 4.7 Versioning (Option 2: account state at lock time)

Snapshots capture chart-relevant fields (code, name, hierarchy_path, account_type, flags) at lock time. Future renames don't change historical snapshots. Costs additional storage; preserves governance integrity.

### 4.8 Permissions (Section 2.1)

Chart of Accounts is a permissionable module like the others. Office Manager case: `edit` permission allows adding/editing accounts and flags; `approve_lock` or higher allows deactivation and reparenting; `admin` allows hard deletes.

### 4.9 Settings UI

Lives at **Admin → School Settings → Financial → Chart of Accounts**. Three views: tree (hierarchical), flat (sortable list), import (CSV upload + guided flagging).

Add / Edit / "+ Subaccount" all open the same `AccountForm` React component in modal context — the same form Budget's "+ Add Account" flow uses (Pattern 1). One form, multiple entry points, identical validation. See Section 10.9 for the modal-not-inline-expand principle.

### 4.10 Worked example (Libertas)

Real Libertas QB structure showing how the posting/summary model handles a parent that posts directly while still containing a summary subtree:

```
Income (top-level)
  4000 Educational Program Revenue       summary    [no flags]
    4100 Revenue – Tuition               posting    [Ed Program $]      $67,733
      4190 Tuition Discounts             summary    [no flags]
        4192 Teacher Discount            posting    [Ed Program $]      −$5,130
        4193 Family Discount             posting    [Ed Program $]      −$1,304
        4194 Board Discount              posting    [Ed Program $]      −$1,073
        4195 Financial Aid               posting    [Ed Program $]      −$1,027
    4300 Fees                            summary    [no flags]
      4305 Curriculum/Book Fees          posting    [Ed Program $]      $767
      ...

Ed Program Dollars KPI:
  Sum direct posts of all accounts with is_ed_program_dollars = true
  = $67,733 + (−$5,130) + (−$1,304) + (−$1,073) + (−$1,027) + $767 + ...
  = $62,706

Matches QB Total 4000 Educational Program Revenue exactly.
```

The key move: 4100 Revenue – Tuition is **flagged AND has children**. The leaf-only rule (deprecated) would have refused this. The posting-only rule allows it because 4100 posts directly. KPI math correctly nets gross tuition against discounts because all four discount sub-accounts are also flagged posting accounts.

### 4.11 Deprecated rules

**Leaf-only governance flag rule (v1.0 — v1.1).** Earlier versions of this document required governance flags to be set only on leaf accounts (those with no children). Real QuickBooks COAs routinely contain parent accounts that post directly — for example, a "Revenue – Tuition" parent that posts gross tuition while having a "Tuition Discounts" child that summarizes deductions. The leaf-only rule made it impossible to flag such parents, producing incorrect KPI math for the Ed Program Dollars ratio. As of **v1.2**, governance flags require `posts_directly = true` instead of leaf status. See Migration 005 and Section 4.10 above.

The `is_leaf_account()` helper from Migration 004 remains in the schema for any caller that wants strict leaf semantics, but is **deprecated for COA validation** — use `is_posting_account()` instead.

### 4.12 Delete behavior

Two delete paths exist on `chart_of_accounts`:

- **Soft-delete (Deactivate)** — sets `is_active = false`. The row stays in the table; historical references (snapshots, change_log, future budget rows) remain valid. Available to users with `approve_lock` permission. The default and recommended action for almost all "remove from selection" cases.
- **Hard-delete** — actual `DELETE FROM chart_of_accounts`. Removes the row entirely. Gated by **two conditions**: (1) user has `admin` permission on `chart_of_accounts` (RLS-enforced via the `coa_delete` policy added in Migration 007), and (2) the function `chart_of_accounts_can_hard_delete(account_id)` returns `can_delete = true`. The function checks for any other table that references this account; today the only check is the self-referential subaccount FK on `parent_id`. When Phase 2+ modules add FK references (budget line items, tuition references, etc.), the function body extends to check those tables. The signature stays stable; the body grows.

The function returns both a boolean and a human-readable `blocking_reason` string. The UI surfaces the reason via a small `(i)` hint icon next to Deactivate when the user has admin permission but the account isn't safe to hard-delete. The Delete button itself is hidden in that state — the (i) tooltip is the affordance for "why no Delete?"

The change_log trigger from Migration 004 fires on DELETE, so hard-deletes are audit-logged automatically with the full row state captured in `old_value`.

**Phantom-row protection on edit (Migration 014).** Toggling `posts_directly` from `true` to `false` (account becomes summary) or `is_pass_thru` from `false` to `true` while live `budget_stage_lines` rows reference the account is REJECTED by the `tg_check_coa_phantom_creation` trigger on `chart_of_accounts` UPDATE. The trigger reads exactly the same FK relationship that `chart_of_accounts_can_hard_delete()` reads on the delete path; the principles match — an active budget reference makes the account un-changeable in ways that would invalidate the line. Snapshot tables are intentionally NOT counted: `budget_snapshot_lines` captures account state by value at lock time and is immune to subsequent COA changes by design. The cleanup DELETE in Migration 014 removed any phantom rows that had accrued before the trigger existed (one such row was discovered during Phase 2 Commit E test pass).

### 4.13 User-facing vocabulary

Account hierarchy is referred to as **"subaccounts"** and **"subaccount of"** in all user-facing copy, matching QuickBooks conventions and accountant vocabulary. The database column `parent_id` is internal-only — it never appears in UI, error messages, or tooltips. The mapping is one-to-one (`parent_id` → "subaccount of"; an account whose `parent_id` references X is "a subaccount of X"). Trigger error messages still use older `parent / child / cycle` wording from Migration 004; these are translated at the UI surface (see `translateError` in `CoaManagement.jsx`) so the user-facing experience is consistent. A future migration could rephrase the trigger messages directly; not yet scheduled.

---

## 5. Snapshots, Redaction, and PDF Architecture

Three cross-cutting concerns designed once and applied everywhere.

### 5.1 Snapshots

**Definition**: An immutable record of what was approved at a specific moment.

**Capture**: Atomically when a lock-approval action fires. If snapshot capture fails, the lock transition rolls back. There is no scenario where a module says "locked" but the snapshot doesn't exist.

**Immutability**: Snapshot tables have no UPDATE policy. Only INSERT. Triggers raise exceptions on UPDATE attempts. System Admin override exists but requires explicit `INSERT INTO override_log` for traceability.

**Re-locking**: Creates a NEW snapshot. The old snapshot stays. History is the chain.

**Retrieval**: By module instance ID, by date range, by user. Audit trail composed of snapshots + state transitions.

**Cross-module capture (Budget example)**:

```
budget_snapshots
  ...standard snapshot fields...

  -- Stage capture (per Section 3.8): each snapshot belongs to a
  -- workflow stage; stage labels are captured by value at lock time
  -- so post-lock workflow renames don't disturb history.
  stage_id                       uuid          -- FK to module_workflow_stages
  stage_display_name_at_lock     text          -- e.g. "Preliminary Budget"
  stage_short_name_at_lock       text          -- e.g. "Prelim. Budget"
  stage_type_at_lock             text          -- e.g. "preliminary" / "final"

  -- Captured upstream module references at lock time:
  tuition_scenario_snapshot_id   uuid
  staffing_scenario_snapshot_id  uuid (NULL if Staffing was in projection state at lock)
  enrollment_estimate_snapshot_id uuid
  strategic_financial_plan_snapshot_id uuid

  -- For an early-cycle budget stage locked while Staffing was unlocked:
  staffing_state_at_lock         text          -- 'locked' | 'projected'

  -- Captured KPIs at lock time:
  kpi_total_income, kpi_total_expenses, kpi_net_income, etc.
```

When a budget stage is locked with Staffing in projection state, the snapshot records that fact. Board members viewing the snapshot see "Personnel: $852,759 (based on projected Staffing as of April 15, 2026; final Staffing locked September 1)."

**Stage capture rationale.** Recording `stage_id` alone would leave the snapshot dependent on the workflow editor — if a school renames or deletes a stage in Phase R2, historical snapshots would render with the new label or break entirely. Capturing the stage's display name, short name, and type by value makes each snapshot self-describing: it remembers what stage it represented at the moment it was locked, regardless of subsequent workflow edits.

**Binding rule — locked-state UI renders exclusively from snapshot tables.** The captured-by-value design only delivers the immutability promise if the render path actually uses the captured columns. Live-data joins are FORBIDDEN in locked-state render paths, even for display fields like name, code, or hierarchy. Any time a user views a locked snapshot, the budget tree is constructed from `budget_snapshot_lines` (using `account_code`, `account_name`, `account_hierarchy_path`, `is_pass_thru`, `is_ed_program_dollars`, `is_contribution`, `amount` — all captured at lock time) and the KPI sidebar reads the seven `kpi_*` columns directly from the `budget_snapshots` row. The only acceptable use of the snapshot's `account_id` is as a click-through affordance to navigate to the live COA row (it's nullable; on null, no link). No filters on `is_active`, `posts_directly`, or `is_pass_thru` are applied to snapshot lines on render — those filters belong on the insert side (Migration 011's trigger), not on read. This rule is the rendering-layer counterpart to the data-layer guarantees `ON DELETE SET NULL` on `account_id` plus captured-by-value columns; both are required for the architectural invariant to hold.

In code: `BudgetStage.jsx` forks its data fetch on `activeScenario.state`. Locked → `budget_snapshots` + `budget_snapshot_lines` via `fetchScenarioPayload`. Drafting / pending → `budget_stage_lines` joined client-side to the live COA payload. The `tree` and `kpis` `useMemo` blocks branch the same way: `buildSnapshotTree(snapshotLines)` and `snapshotKpis(snapshot)` for locked, `buildBudgetTree(accounts, lines)` and `computeKpis(accounts, lines)` for live. Both tree builders return identical shape so `BudgetDetailZone` renders either without modification.

**Unlock-in-progress does NOT change the binding.** Per §8.13, while `unlock_requested = true` (the unlock workflow is mid-flight), the scenario's `state` column remains `'locked'`. Locked render paths therefore continue to read exclusively from snapshot tables throughout the request → first-approval → second-approval window. Only the second-approval transaction transitions `state` to `'drafting'`, at which point the live render path takes over. This avoids any ambiguous "is this still locked or not?" rendering state during the approval window.

### 5.2 Redaction

**Principle**: Storage stores everything. Rendering filters by viewer permission.

**Detail-visibility flags** (orthogonal to module permissions per Section 2.1):
- `can_view_staff_compensation` — see individual staff salary lines
- `can_view_family_details` — see individual family rows in Tuition Stage 2 (audit) detail
- `can_view_donor_details` — see individual donor amounts in Fundraising (future)

**Rendering**: Same snapshot serves all viewers. Permissions checked at render time. Aggregate totals always visible to anyone with `view` permission; line-item detail filtered by detail-visibility flags.

### 5.3 PDF/Document Architecture

**Three layers**, isolated for upgrade flexibility:

1. **Snapshot retrieval + redaction** — get snapshot, filter by viewer permissions
2. **View selection** — pick which template/layout (Detail, Summary, Public, etc.)
3. **Render** — produce the actual PDF

**Implementation choice**: Path B from design discussion. HTML-to-PDF rendering. The chosen mechanism for Phase 2 is **dedicated print routes** that render their own component tree (no AppShell, no nav sidebar, no KPI sidebar) plus a focused print stylesheet (`src/components/print/print.css`); on mount each route auto-fires `window.print()` and the browser opens its native print dialog. The user saves as PDF or prints directly. This avoids the infrastructure cost of a server-side headless-Chromium renderer on Vercel for a feature mostly used ad-hoc. If emailable PDFs become a real requirement (scheduled reports, PDF attachments to board emails), the upgrade path is to mount the same React tree in a Vercel serverless function with a headless-Chromium renderer; Layers 1 and 2 above are unchanged.

**Print route inventory** (Phase 2 Commit F):

```
/print/budget/:scenarioId            Operating Budget Detail
/print/budget/:scenarioId/activity   Per-scenario activity feed (audit log)
/print/budget-line/:lineId/history   Per-line audit history
```

**Source-of-truth rules** for the budget print routes:

- **Locked scenarios** render exclusively from `budget_snapshots` + `budget_snapshot_lines` (captured-by-value columns). Live joins to `chart_of_accounts` are forbidden in this path — the same binding rule as the in-app locked detail (Section 5.1). The locked PDF is the document a board chair puts in a binder; it must be invariant under post-lock edits to the live COA.
- **Drafting / pending scenarios** render from `budget_stage_lines` joined to live `chart_of_accounts`. The watermark and "preliminary working version" footer mark the output unmistakably as non-final (Section 2.5).
- **Activity / line-history routes** read from `change_log` directly. Filter state from the in-app feed is NOT carried into the print route — exports are reproducible from the URL alone, which is the right behavior for an audit artifact.

**DRAFT treatment is uniform across all print routes** (codified v3.6). PrintShell renders the diagonal watermark, the running DRAFT banner, and the "preliminary working version" footer note when the `draft` prop is true — and every print route that operates on a scenario passes `draft={scenario.state !== 'locked'}`. The treatment is gated by the source scenario's state, not by which print surface is being rendered. Audit log PDFs of draft scenarios visibly identify themselves as draft just like Operating Budget Detail; audit log PDFs of locked scenarios render without DRAFT treatment because the underlying artifact is approved record. The watermark and running banner are intentionally `display: none` on screen — they only appear in actual print/PDF output, not in the in-browser preview, to avoid cluttering the preview surface.

**Commit F status**: Operating Budget Detail (DRAFT and LOCKED variants) shipped, with diagonal watermark, branded letterhead, KPI summary, hierarchical layout, narrative section, approved-by footer, and override-justification rendering. Per-line audit history modal and per-scenario activity feed shipped, both with PDF exports. Budget Summary and Variance Report views from §5.3 are still on the roadmap (deferred to a later session).

**Per-school branding**: Every PDF accesses `school_brand_settings` for that school's logo, fonts, colors, tagline. Configured during school onboarding by Praesidium staff.

**Multiple views per module**:

```
Budget module:
  - "operating_budget_detail" (full line items)
  - "budget_summary" (category totals only, public-facing)
  - "variance_report" (comparison view)

Tuition Worksheet:
  - "tuition_schedule_public" (family-facing, branded — Stage 1 lock artifact)
  - "scenario_comparison" (board view)
  - "tuition_recommendation" (committee report — Stage 1)
  - "audit_summary_by_tier" (Stage 2 — aggregated tier counts and discount totals)
  - "audit_family_detail" (Stage 2 — per-family detail with redaction)

Staffing:
  - "comp_summary" (aggregate)
  - "position_detail" (with redaction)
  - "staffing_scenarios" (scenario comparison)

Strategic Plan:
  - "adopted_document"
  - "tracking_report"
```

User picks view at PDF generation time. View picker shows only views their permission allows.

**Multi-format exports**: Every PDF view also exports to XLSX. Same data, different format.

### 5.4 DRAFT and Approved indicators

See Sections 2.5 and 2.6.

---

## 6. Strategic Plan Module

The most conceptually layered module. Sits at the top of the governance pyramid.

### 6.1 Three instruments as peers

```
STRATEGIC ENDS PRIORITIES
  Owner: Board
  Horizon: Multi-year (currently 1, target 3+)
  Question: "What ENDS does this school exist to achieve?"

STRATEGIC FINANCIAL PLAN  
  Owner: Board (Treasurer-led, board-adopted)
  Horizon: Multi-year (Libertas current: AYE 25-28)
  Question: "What financial trajectory makes the ENDS achievable?"

OPERATIONAL STRATEGIC PLAN
  Owner: Head of School
  Horizon: Annual (single AYE)
  Question: "How will this AYE's work advance the ENDS within Financial Plan limits?"
```

These are NOT variants of one concept. They're peers in a governance hierarchy with distinct ownership, cadence, and operational relationships.

### 6.2 Strategic ENDS Priorities schema

```
strategic_ends_priorities
  id                 uuid
  effective_aye_id   uuid (FK; first AYE this version is effective)
  expiry_aye_id      uuid (FK, nullable; last AYE before next version)
  state              enum ('drafting', 'pending_adoption', 'adopted', 'superseded')
  adopted_at         timestamptz
  adopted_by         uuid
  adopted_via        text (e.g. "Board Resolution 2026-04-15-3")
  preamble           text
  notes              text
  audit fields

ends_items
  id                       uuid
  strategic_ends_priorities_id  uuid (FK)
  sort_order               int
  ends_text                text
  rationale                text
  measures                 text (how progress is measured)
```

### 6.3 Strategic Financial Plan schema

```
strategic_financial_plans
  id                  uuid
  start_aye_id        uuid (FK)
  end_aye_id          uuid (FK)
  state               enum ('drafting', 'pending_adoption', 'adopted', 'superseded')
  adopted_at, adopted_by, adopted_via
  preamble            text
  notes               text
  audit fields

strategic_financial_targets
  id                          uuid
  strategic_financial_plan_id uuid (FK)
  aye_id                      uuid (FK)
  
  -- Standard targets (RANGES, not point values, per design discussion)
  target_total_revenue_min, target_total_revenue_max, target_total_revenue_value
  target_total_expenses_min, target_total_expenses_max, target_total_expenses_value
  target_ed_program_ratio_min, target_ed_program_ratio_max, target_ed_program_ratio_value
  target_cash_reserve_months_min, target_cash_reserve_months_max
  target_enrollment_min, target_enrollment_max
  target_fundraising_total_min, target_fundraising_total_max
  
  -- Ratio targets (matches the Strategic KPI Dashboard — see Section 8.4)
  target_tuition_revenue_ratio_min, target_tuition_revenue_ratio_max
  target_fundraising_ratio_min, target_fundraising_ratio_max
  target_auxiliary_income_ratio_min, target_auxiliary_income_ratio_max
  target_personnel_ratio_min, target_personnel_ratio_max
  target_facilities_ratio_min, target_facilities_ratio_max
  target_educational_materials_ratio_min, target_educational_materials_ratio_max
  target_admin_ratio_min, target_admin_ratio_max
  target_financial_aid_ratio_min, target_financial_aid_ratio_max
  
  -- Custom KPI targets (extensible per school)
  custom_targets              jsonb (key-value: {custom_kpi_id: {min, max, value}})
  
  notes                       text

strategic_financial_initiatives
  id                          uuid
  strategic_financial_plan_id uuid (FK)
  name                        text
  description                 text
  proposed_start_aye_id       uuid (FK)
  proposed_end_aye_id         uuid (FK, nullable)
  current_status              enum ('planned', 'in_progress', 'completed', 'paused', 'cancelled')
  estimated_cost              numeric
  estimated_revenue           numeric
  estimated_net_impact        numeric
  linked_ends_items           uuid[] (FKs to ends_items)
  notes                       text
```

### 6.4 Operational Strategic Plan schema

Three-level hierarchy: Plan → Focus Area → Action.

```
operational_strategic_plans
  id                 uuid
  aye_id             uuid (FK; one per AYE)
  state              enum ('drafting', 'adopted')   -- NO unlocked state; once adopted, fixed structure
  adopted_at, adopted_by, adopted_via
  ends_priorities_version_id  uuid (FK; which ENDS version this implements)
  financial_plan_id           uuid (FK; which Financial Plan this operates within)
  preamble           text
  vision_statement   text
  mission_statement  text
  notes              text
  audit fields

operational_plan_focus_areas
  id
  operational_strategic_plan_id (FK)
  linked_ends_item_id (FK to ends_items — Focus Area level linkage)
  number text (e.g. "1.1", "1.2")
  name text
  description text
  sort_order

operational_plan_actions
  id
  focus_area_id (FK)
  
  -- LOCKED after adoption (cannot be edited):
  number text (e.g. "1.1.1")
  action_text text
  product_description text
  is_accreditation_placeholder boolean
  
  -- LIVING (editable post-adoption with audit trail):
  primary_opr_code text                    (single, required)
  supporting_opr_codes text[]              (multiple, optional)
  due_date date                            (specific)
  due_period text                          (fuzzy: "Aug 2026", "Q3 2026", "Oct - Apr 2026")
  status enum ('not_started', 'in_progress', 'on_track', 'at_risk', 'completed', 'delayed', 'cancelled')
  status_notes text
  status_updated_at timestamptz
  status_updated_by uuid
  cancellation_reason text (required if status = 'cancelled')
  
  -- Optional linkages (Section 2.8):
  linked_budget_lines uuid[]
  linked_financial_initiative_id uuid
  linked_accreditation_recommendation_id uuid (future)
  
  notes text
  audit fields
```

### 6.5 Adopted vs. Living dual nature

The Operational Plan has two states:
- **Adopted Snapshot**: What was approved at start of year. Immutable. Reference document for accountability.
- **Living Plan**: Current state with status updates flowing in monthly. Action structure stays fixed; status, dates, OPR, notes evolve.

Once adopted, structure (focus areas, actions, action_text) is fixed. Only status, dates, OPR, comments change. If an action doesn't get done, it stays in the system with status='delayed' or 'cancelled' (with reason). Accountability isn't quietly hidden.

When viewing the Operational Plan:
- "Show me what was approved" → Adopted Snapshot
- "Show me current status" → Living Plan
- "Compare what was approved to where we are now" → automatic diff view

### 6.6 Org Acronyms registry

School-configurable. Lives in **School Settings → Organization → Org Acronyms Registry**.

```
org_acronyms
  id
  code text (e.g. "HOS", "AcD", "BOD")
  full_name text (e.g. "Head of School", "Academic Dean")
  description text
  is_active boolean
  audit fields
```

Operational Plan's `primary_opr_code` and `supporting_opr_codes` reference this registry by code. Other modules that need role abbreviations also use this.

### 6.7 Cross-module integration

**Budget module** displays Strategic Plan target comparisons in KPIs:
```
Ed Program Ratio: 0.716  (target: 1.02; range 60-80%)  ⚠️ under target
```

**Operational Plan actions** can link to Budget lines (showing funding) and Strategic Initiatives.

**Tuition Worksheet** can surface ENDS Priorities relevant to tuition decisions.

**HoS Report (future)** pulls from Operational Plan status updates as primary data source.

**Monitoring Calendar (future)** uses Operational Plan due dates to populate board agenda items.

### 6.8 Print-ready outputs

- **ENDS Priorities**: "Adopted Document" (clean board-ready), "Tracking Report" (with progress markers)
- **Financial Plan**: "Adopted Document", "Annual Snapshot" (single AYE focus), "Initiative Tracker"
- **Operational Plan**: "Submitted Plan", "Adopted Plan", "Mid-Year Status Report", "Year-End Report"

All branded per school. All marked DRAFT when state != adopted.

### 6.9 Accreditation placeholder support

Operational Plan actions can be flagged as accreditation placeholders (e.g., "Insert Accreditation Report Recommendation here" — common when accreditation visit happens during plan drafting). When the actual accreditation report comes in, placeholders are replaced with real action text. Lightweight feature: flag, visual indicator, manual replacement workflow. No automatic merge.

### 6.10 Board Policy linkage

Strategic Plan elements reference Board Policies (e.g., "Maps to: 1.0, 1.1, 1.2" in your existing plan). Stored as text now. Future: FK to `board_policies` table when Board Policy Manual module exists.

---

## 7. Operational Planning Modules

The three AYE-scoped tools that feed Budget.

### 7.1 Cross-cutting patterns

All three modules share:
- Multi-scenario support (Conservative/Realistic/Optimistic, or named per school's convention)
- One scenario marked `is_recommended` (required at lock time)
- Lock workflow: `drafting → pending_lock_review → locked` (with override option)
- Snapshots capture full state including upstream module references
- Transparent math (no black-box calculations)
- DRAFT marking on non-locked PDFs

### 7.2 Enrollment Estimator

**Purpose**: Per-grade student count projections for an upcoming AYE.

**Inputs**: Advancement actuals (current AYE counts), pre-enrollment commits, projection assumptions.

**Outputs**: Per-grade and per-section count projections feeding Tuition and Budget.

**Schema** (built on existing `aye_grade_sections`, `enrollment_monthly`):

```
enrollment_estimates
  id, aye_id, scenario_label, description, is_recommended
  state enum (drafting | pending_lock_review | locked | pending_unlock_review)
  assumptions_text
  audit fields

enrollment_estimate_grades
  id, enrollment_estimate_id (FK), grade_level
  prior_aye_actual_count int (snapshotted from Advancement at lock)
  expected_returning_count int
  expected_attrition_count int
  expected_new_count int
  graduation_loss_count int (auto for 8th, 12th)
  projected_count int (computed)
  notes
  audit fields

enrollment_estimate_sections (for combo class handling)
  id, enrollment_estimate_id (FK), grade_section_id (FK to aye_grade_sections)
  projected_count int (allows section-level projection for combo classes)
  notes
```

**Design choices**:
- Multi-scenario: Approach A (independent scenarios) with "duplicate scenario" shortcut. Each scenario is fully independent.
- Both section-level and grade-level views supported (combos handled correctly)
- Pre-enrollment commits visible inline with toggle
- Pulls starting values from Advancement; user overrides freely
- "Duplicate this scenario" button seeds new scenarios from existing
- Manual override available at any field

### 7.3 Tuition Worksheet

Two-stage module per §3.8. Real-data design discovery during the AYE 2026 Final Budget exercise surfaced that tuition is fundamentally a two-stage governance cycle, not a single-stage projection. What was previously queued as a separate "Enrollment Audit" module is actually Tuition Stage 2 — the per-family detail capture after September enrollment finalizes. This section is the architectural keystone for the Tuition module before any schema or code work begins.

#### Purpose

**Stage 1 — Tuition Planning** (locks January). Sets tuition rates, fees, and discount budgets for the upcoming AYE. Tuition Committee reviews proposed tier rates against the locked Strategic Financial Plan and prior-year actuals; Committee recommends to Board; Board approves; Stage 1 locks. The locked Stage 1 snapshot becomes upstream input to Preliminary Budget revenue projections (per §7.5 cascade rules) and is the source from which the family-facing Tuition Schedule PDF is generated.

**Stage 2 — Tuition Audit** (locks September, after enrollment is finalized). Captures per-family enrollment, applied tier per family, and actual discount allocations (Faculty awards, Other-discount awards, Financial Aid awards). The locked Stage 2 snapshot becomes upstream input to Final Budget actuals (per §7.5) and is the official "what tuition revenue did the school actually book this AYE" record.

#### Workflow stages

Tuition workflow seed (one workflow per school per §3.8):

| display_name | stage_type | is_terminal | target_month |
|---|---|---|---|
| Tuition Planning | preliminary | false | January |
| Tuition Audit | final | true | September |

**Stage type judgment.** Reusing `preliminary` and `final` from the existing `stage_type_definitions` catalog rather than introducing new `planning` / `audit` types. Semantics fit cleanly: `preliminary` is "draft that has been governance-approved and locks for downstream consumption"; `final` is "actuals captured, terminal for the AYE." The school's display name carries the module-specific vocabulary ("Tuition Planning" vs "Preliminary Budget"); the stage type drives generic machinery (cross-module joins, terminal-stage selection for KPI capture). Catalog stays small; cross-module cascade phrasing reads cleanly ("each module's terminal stage is upstream of the next downstream module's terminal stage"). If a future school's tuition workflow needs additional intermediate stages (e.g., a "Tuition Reforecast" mid-year), the existing `reforecast` type already in the catalog covers it.

#### Schema

`tuition_worksheet_scenarios` — per-stage, per-AYE, multi-scenario (one `is_recommended` per stage at lock time per the §7.1 pattern). Mirrors `budget_stage_scenarios` for the standard scenario / lock / unlock fields:

```
tuition_worksheet_scenarios
  -- Standard scenario fields (parallel budget_stage_scenarios)
  id                              uuid pk
  aye_id                          uuid FK
  stage_id                        uuid FK to module_workflow_stages
  scenario_label                  text
  description                     text
  is_recommended                  boolean
  state                           enum (drafting | pending_lock_review | locked | pending_unlock_review)
  locked_at                       timestamptz
  locked_by                       uuid FK to auth.users
  locked_via                      text ('normal' | 'override')
  override_justification          text
  unlock_*                        -- mirror budget_stage_scenarios per §8.13 two-identity model
  created_*, updated_*            audit fields

  -- Configuration: rates and fees (set in Stage 1, immutable in Stage 2 — see "Stage 2 immutability")
  tier_count                          int                 -- 1 to N (Libertas: 4)
  tier_rates                          jsonb               -- [{tier_size, per_student_rate, applies_when_n_students}, …]
  faculty_discount_pct                numeric             -- the percentage rule used by Stage 2 per-family allocation
                                                          --   math (default 50.00 at Libertas). Persists in schema but
                                                          --   does NOT render in Stage 1 UI as of v3.8.2 (B1.1) —
                                                          --   Stage 1 uses projected_faculty_discount_amount instead.
  projected_faculty_discount_amount   numeric             -- Stage 1 $ projection (v3.8.2 / B1.1). Estimated total
                                                          --   faculty-children discount dollars for budgeting.
                                                          --   Stage 2 audit reconciles against per-family allocation.
  projected_other_discount            numeric             -- board-granted budget for ad-hoc awards
                                                          --   (renamed from other_discount_envelope in v3.8.2)
  projected_financial_aid             numeric             -- FA committee-managed budget
                                                          --   (renamed from financial_aid_envelope in v3.8.2)
  curriculum_fee_per_student          numeric
  enrollment_fee_per_student          numeric
  before_after_school_hourly_rate     numeric
  projected_b_a_hours                 int                 -- nullable (v3.8.3 / B1.2). Projected total annual
                                                          --   B&A hours across all enrolled students. Stage 2
                                                          --   audit captures actual hours in
                                                          --   actual_before_after_school_hours.
  projected_multi_student_discount    numeric(12,2)       -- nullable (v3.8.3 / B1.2). Projection of
                                                          --   Multi-Student Discount as the fourth discount
                                                          --   stream (alongside Faculty / Other / Financial
                                                          --   Aid). Computed application-side from
                                                          --   tuitionMath.computeProjectedMultiStudentDiscount
                                                          --   on every save that touches the math inputs;
                                                          --   persisted as the at-save snapshot so downstream
                                                          --   reads (lock snapshot, future RPC math) work
                                                          --   without recomputation. Server-side hoist into
                                                          --   compute_tuition_scenario_kpis is queued.
  expense_comparator_mode             text NOT NULL DEFAULT 'locked_budget'
                                                          -- (v3.8.7 / Tuition-C). CHECK constraint enforces
                                                          --   ('locked_budget' | 'manual'). Drives whether
                                                          --   the page fetches the latest locked Budget or
                                                          --   uses the user-entered amount.
  expense_comparator_amount           numeric(12,2)       -- nullable. Stored expense number used as the
                                                          --   denominator for Net Education Program Ratio
                                                          --   and for Breakeven Enrollment math. Populated
                                                          --   from get_latest_locked_budget_for_school when
                                                          --   mode='locked_budget'; user-entered when
                                                          --   mode='manual'.
  expense_comparator_source_label     text                -- nullable. Human-readable context for the
                                                          --   sublabel: "AYE 2025 Final Budget" or
                                                          --   "Manual estimate" or null when no comparator
                                                          --   is available.

  -- Stage 1 enrollment projection (v3.8.2 / B1.1). The user enters
  -- total_students plus per-tier breakdown_pct values; total_families
  -- derives from total_students ÷ weighted-avg-students-per-family.
  -- The user can override total_families if a more specific projection
  -- is available; the override is persisted in this column. The
  -- estimated_family_distribution jsonb stores per-tier breakdown_pct
  -- AND a derived family_count (computed application-side and written
  -- to the jsonb on save so downstream reads have it without
  -- recomputation).
  total_students                      int                 -- nullable: null = no projection yet
  total_families                      int                 -- nullable: derived OR user-overridden
  top_tier_avg_students_per_family    numeric(4,2)        -- nullable: refines top-tier "X+" projection;
                                                          --   defaults to top tier_size when null;
                                                          --   DB validator enforces ≥ top tier_size
  estimated_family_distribution       jsonb               -- [{tier_size, breakdown_pct, family_count}, …]
                                                          --   v3.8.2: breakdown_pct is the user-entered field;
                                                          --   family_count is application-derived.

  -- Stage-2-only fields (actuals; not populated on Stage 1 scenarios)
  actual_before_after_school_hours    numeric             -- from operational data

  -- Optional cross-module linkage (manual entry today; FK-resolvable when Enrollment Estimator ships)
  linked_enrollment_estimate_id       uuid (nullable FK)
```

`tuition_worksheet_family_details` — Stage 2 only; one row per enrolled family per scenario. Family detail is the operational substance of the Stage 2 audit.

```
tuition_worksheet_family_details
  id                       uuid pk
  scenario_id              uuid FK to tuition_worksheet_scenarios
  family_label             text                   -- redaction-aware (see §5.2)
  students_enrolled        int

  -- Auto-derived from students_enrolled; tier_rate snapshotted from scenario.tier_rates at audit row creation
  applied_tier_size        int
  applied_tier_rate        numeric

  -- Per-family discount allocations (nullable — only populated when discount applies to this family)
  faculty_discount_amount  numeric                 -- null if family is not faculty
  other_discount_amount    numeric                 -- null if no Other-discount award
  financial_aid_amount     numeric                 -- null if no FA award

  -- Governance annotations — board / FA committee decisions, special circumstances
  notes                    text                    -- non-optional; carries the audit trail

  created_*, updated_*     audit fields
```

**Snapshot tables** parallel Budget per the §5.1 captured-by-value pattern:

- `tuition_worksheet_snapshots` — captures scenario configuration (tier rates, fees, envelopes) plus computed totals (gross tuition revenue, discount aggregates, net revenue, KPIs) at lock time. Captured-by-value columns include the AYE label, stage display name and type, school name (for PDF letterhead), and the full configuration jsonb so Stage 1 snapshots remain renderable even if the live `tuition_worksheet_scenarios` row is later edited (drafting clone) or hard-deleted.
- `tuition_worksheet_snapshot_family_details` — Stage 2 only. Captures per-family rows by value: family_label, students_enrolled, applied tier size and rate, every discount amount, the notes text. Locked Stage 2 snapshots are the audit record; they cannot drift if a family later changes circumstances.

`ON DELETE SET NULL` on `aye_id` and `stage_id` from snapshot rows preserves historical snapshots if upstream schema changes occur. Same pattern as `budget_snapshots` per §5.1.

#### Layered discount taxonomy

Discounts are LAYERED, not a single-model selection. A family receives the multi-student tier rate as the primary discount; on top of that, zero or more of three additional discount mechanisms may apply independently:

1. **Multi-student tier (primary, configurable)** — per-student rate decreases as family enrollment increases. Tier 1 (1 student), Tier 2 (2 students), Tier 3 (3 students), Tier 4+ (4 or more students). Configured in `tier_rates` jsonb on the Stage 1 scenario; applies automatically by family size at audit time.

2. **Faculty discount** — fixed percentage off gross tuition for qualifying faculty children (the **rule**: default 50% at Libertas) plus a Stage 1 dollar projection (the **budgeting input**). The percentage rule is stored in `faculty_discount_pct` and used by Stage 2 per-family allocation math; it is immutable in Stage 2. The Stage 1 dollar projection lives in `projected_faculty_discount_amount` (v3.8.2 / B1.1) — the user enters their best estimate of total faculty-children discount dollars for budgeting purposes; Stage 2 audit reconciles actuals against this projection. **The percentage column does not render in the Stage 1 UI as of v3.8.2** — the dollar projection is more directly useful for fiscal planning than computing pct × gross during Stage 1.

3. **Other discounts (projected)** — board-granted budget for ad-hoc awards (legacy commitments, special circumstances). Total set at Stage 1 (`projected_other_discount`, renamed from `other_discount_envelope` in v3.8.2); per-family awards allocated in Stage 2 with a board-decision annotation in the `notes` column (e.g., "$500 awarded by board on 6/2/25").

4. **Financial Aid (projected)** — FA committee reviews applications semi-annually and allocates from a committee-managed budget. Total set at Stage 1 (`projected_financial_aid`, renamed from `financial_aid_envelope` in v3.8.2); per-family awards allocated in Stage 2 with an FA-committee annotation in `notes` (e.g., "20% per Financial Aid Committee 6/2/25").

The `notes` column is non-optional governance context — it carries the audit trail of who decided what and when. A non-empty content rule (parallel to the unlock workflow's justification field per §8.13) is enforced at the application validator layer for any family row where any discount amount is non-null.

#### Stage 1 revenue vocabulary

(v3.8.3 / B1.2) Real-data review against Libertas's legacy AYE 2026 spreadsheet established the canonical revenue and discount vocabulary for the Tuition Worksheet. Agora adopts the legacy spreadsheet's four-stream discount model so that Agora numbers and the spreadsheet numbers are mentally interchangeable for the Tuition Committee.

The four stream definitions:

- **Projected Gross Tuition** = `tier_1_rate × total_students` (base × headcount, no tier blending). The reference rate against which all multi-student discounts are computed.
- **Projected Ed Program Revenue** (gross) = Projected Gross Tuition + curriculum-fee revenue + enrollment-fee revenue + projected B&A revenue. The total inflows attributable to the educational program.
- **Total Projected Discounts** = Multi-Student Discount + Faculty Discount + Other Discount + Financial Aid. Four streams; legacy spreadsheet AYE26 lines 34–38 establish exactly this taxonomy with Multiple Student as the first line.
- **Net Projected Ed Program Revenue** = Projected Ed Program Revenue − Total Projected Discounts. The load-bearing operational KPI: this is the "are we at 102% of expenses?" number that drives Stage 1 tuition-rate decisions.

**Gross is always base × headcount in Agora.** Tier blending appears exclusively as the Multi-Student discount line. This is a deliberate vocabulary choice — it makes the four-stream taxonomy clean (each stream has a single computational meaning) and forces all downstream math to use a consistent gross definition. The legacy spreadsheet treats Multi-Student as the first discount line for the same reason.

**Visual consolidation (v3.8.4 / B1.3).** All four discount streams (Multi-Student, Faculty, Other, Financial Aid) render together in the Projected Discounts section. Multi-Student is read-only (computed from tier math); the other three are user-entered envelope estimates. The section's Total Projected Discounts subtotal mirrors the sidebar stat of the same name. The Tuition Fees section gains its own grand subtotal (`Tuition Fees Subtotal` = Per-Student Fees Subtotal + B&A Revenue Subtotal) at its foot, with the two component subtotals rendered above in italic muted treatment. Discount values render with the universal accounting parentheses convention per §10.12.

**Stage 1 page section ordering (v3.8.6 / B1.5).** The Stage 1 page section order reflects the operational reality of tuition planning. Projecting total enrollment is the first decision; tier rates and fee structures follow once headcount is set; discount projections layer on top; and the family distribution detail section finalizes how the projected enrollment splits across family sizes. The Projected Enrollment section sits above Tier Rates as the page's first content section, with the Total students input rendered in bold to signal its load-bearing role. The other Family Distribution elements (Total families, breakdown percentages, top-tier average) stay in the Projected Family Distribution section at the page foot, where they remain conceptually downstream of tier-rate decisions because they feed the tier-blended math that produces the Multi-Student Discount. Total students is editable exclusively in Projected Enrollment; Family Distribution renders a read-only mirror so the section remains self-contained.

`compute_tuition_scenario_kpis` (Migration 024 + 027) computes most of these server-side for the Stage 1 lock snapshot, but the Stage 1 UI surfaces them client-side via `src/lib/tuitionMath.js` for instant feedback during iteration. The client-side helpers (`computeProjectedGrossAtTier1`, `computeTierBlendedTuition`, `computeProjectedMultiStudentDiscount`, `computeProjectedBARevenue`, `computeProjectedFeeRevenue`, `computeProjectedEdProgramRevenue`, `sumTotalProjectedDiscounts`, `computeNetProjectedEdProgramRevenue`) follow strict null propagation so a fresh scenario surfaces "not yet entered" honestly rather than rendering misleading zeros. A server-side hoist into `compute_tuition_scenario_kpis` is queued for Tuition-C, when the RPC starts returning a real KPI bundle (break-even enrollment count, net education program ratio vs. locked Budget, year-over-year comparison) and the round-trip cost amortizes across multiple KPIs.

#### Stage 1 projection vs. Stage 2 actual

All four discount streams in the Tuition Worksheet have a projection-vs-actual structure. This is the load-bearing distinction between Stage 1 (Tuition Planning) and Stage 2 (Tuition Audit).

At **Stage 1 (Tuition Planning)**, Multi-Student Discount is computed from tier math: Projected Gross Tuition (base × headcount) minus tier-blended tuition revenue (Σ `tier_rate × family_count × students_per_family_in_tier`, with the top tier honoring `top_tier_avg_students_per_family` or falling back to `top_tier_size`). Faculty, Other, and Financial Aid are user-entered envelope estimates (per the v3.8.2 vocabulary cleanup that renamed "envelope" to "projected").

At **Stage 2 (Tuition Audit)** — Tuition-B2 / Tuition-D territory — all four become **actuals**. Multi-Student Discount is captured per-family from realized enrollment data: actual sibling counts, actual start and withdrawal dates, partial-year prorations, mid-year enrollment changes. Faculty, Other, and Financial Aid are per-family allocations against the Stage 1 envelopes plus board-decision overrides recorded in the per-family Notes column.

**The Stage 1 projection and Stage 2 actual are not expected to agree.** This is the whole point of the two-stage model. The variance is itself a meaningful calibration signal for future Stage 1 estimates — for example, a school whose Stage 1 over-projected Multi-Student Discount by 2× under its current tier math should tighten its assumptions next cycle. Future Tuition-C work may surface this variance explicitly as a KPI.

This is exactly the kind of model-fidelity gap that legacy single-line manual approximations hide. Agora makes the projection-vs-actual gap explicit, computed, and visible.

#### Stage 1 expense comparator

(v3.8.7 / Tuition-C) Stage 1 KPIs — Net Education Program Ratio and Breakeven Enrollment — measure scenarios against an expense comparator the system fetches from the most recent locked Budget OR the user enters manually. The cart-and-horse problem (Tuition Planning happens approximately three months before the same-AYE Preliminary Budget per cascade rule §7.5) means the same-AYE Preliminary is rarely available at Tuition Planning time. The default comparator is the most recent locked Budget for the school (typically the prior AYE's Final Budget); the user can switch to manual entry when forward judgment about expenses warrants overriding the prior-year reference.

The comparator is stored per-scenario in three columns (`expense_comparator_mode`, `expense_comparator_amount`, `expense_comparator_source_label`) and mirrored on snapshots — the locked Stage 1 snapshot reflects the comparator value that was current at lock time, so the locked KPIs are reproducible and snapshot-faithful.

**Mechanism.** The Net Education Program Ratio sidebar stat renders a small dropdown in its sublabel area: "Latest locked Budget" (default) and "Manual estimate." Switching to 'locked_budget' triggers `get_latest_locked_budget_for_school` (a SECURITY DEFINER RPC introduced in Migration 029) and persists the returned amount + source label atomically. Switching to 'manual' preserves the current amount as the editable starting value (or seeds from the latest locked Budget if amount is null) and changes the source label to "Manual estimate"; the inline amount input then accepts direct edits per the standard direct-edit-with-undo pattern.

**Stale-detection.** On every scenario load with `mode='locked_budget'`, the page silently fetches the latest locked Budget. If the returned amount or source label differs from stored values, both columns refresh transparently — the change_log captures the drift for audit history; the user is not interrupted with a modal or banner. Architecture rationale: the locked Budget value at this moment is the truth; surfacing every drift would be noisy; the page's job is to keep the comparator current.

**Per-scenario, not page-scoped.** Switching scenarios does not carry the comparator setting forward; each scenario stores its own. This is correct for snapshot fidelity (the locked snapshot reflects the comparator used at lock time) and lets the user reason about each scenario's ratio against its own reference.

**`get_latest_locked_budget_for_school` RPC.** Returns one row of `(scenario_id, aye, stage_type, total_expenses, locked_at)` for the most recent locked Budget by AYE descending then `locked_at` descending. Reads `kpi_total_expenses` from `budget_snapshots` directly (the locked snapshot is the official record per §5.1 binding rule; live recomputation from `budget_stage_lines` is not required and would risk drift). Single-tenant deployment as of v3.8.7 — the `p_school_id` parameter is preserved for forward-compat naming but currently ignored; multi-tenancy will add a `WHERE` clause when it lands.

**Null comparator.** When no locked Budget exists yet (the first cycle of a new school), the RPC returns no rows; the comparator amount and source label stay null. The sublabel reads "vs. expense estimate (no locked Budget available)". Both KPIs render em-dash. The user can switch to manual mode and enter a forward estimate to unblock the math.

**Server-side hoist deferred.** Tuition-C continues the v3.8.3 architectural decision: Stage 1 KPIs (including the new ratio and breakeven) compute client-side via `src/lib/tuitionMath.js` for instant feedback during iteration. The hoist into `compute_tuition_scenario_kpis` is queued for the next session that introduces a server-side reason to need them (cross-module dashboards, scheduled exports, etc.).

#### Stage 1 family-distribution input model

Real-data design discovery during the v3.8.2 (B1.1) walkthrough surfaced that fiscal directors do not natively cast enrollment as per-tier family counts. They cast it as **total students for the year** plus a **breakdown across family sizes**. Stage 1's input model (v3.8.2 / B1.1 reframe) follows this mental model directly.

**Inputs the user enters**:

- `total_students` — projected total enrollment for the AYE.
- `estimated_family_distribution[i].breakdown_pct` — per-tier percentage of total families. The four percentages sum to 100.
- `top_tier_avg_students_per_family` — refines the top tier's "X+" framing. The "4+" tier may include families with 4, 5, or more students; the average defaults to the top `tier_size` when null and is editable.
- `total_families` — optional override. Normally derives from `total_students ÷ weighted_avg_students_per_family`; user may override for a more specific projection.

**Derivation math** (mirrors `src/lib/tuitionMath.js`):

```
weighted_avg_students_per_family =
  Σ ((breakdown_pct[i] / 100) × students_per_family_in_tier[i])

  where students_per_family_in_tier[i] =
    tier_size[i]                                  for non-top tiers
    top_tier_avg_students_per_family ?? tier_size for the top tier

computed_total_families = total_students / weighted_avg_students_per_family
                          (rounded to nearest integer)

family_count[i] = round(total_families × breakdown_pct[i] / 100)
```

**Stored vs derived**: `total_families` and per-tier `family_count` are both stored in the row (the latter inside the jsonb) so downstream reads (snapshots, computed KPIs in Tuition-C) work without recomputation. The application save path keeps them in sync — when `total_students`, `breakdown_pct`, or `top_tier_avg_students_per_family` changes AND the user is "tracking derived" (i.e., not overriding `total_families`), the page recomputes `total_families` and re-derives every `family_count` before the database write. When the user has overridden `total_families`, only `family_count` rederives against the override; `total_families` stays put.

**Override detection** is implicit — there is no `total_families_is_override` flag. The UI compares the stored `total_families` to a freshly-computed derived value; if they match, the user is tracking derived; if they diverge, the user has overridden. A small "↻ revert" button next to `total_families` clears the override (replaces the stored value with the freshly-derived value, which is then tracked).

**Implied-students reconciliation**: when `total_families` is overridden, the UI surfaces "Implied students: X (entered: Y)" below the input when X (= overridden_total_families × weighted_avg) differs from the user-entered `total_students`. Informational only — no automatic correction. The user decides whether the divergence matters.

**DB validators** (Migration 027, trigger `tg_validate_tuition_scenario`):

- When `total_students IS NOT NULL` AND breakdown sum > 0, breakdown_pct values sum to 100 ± 0.01.
- When `top_tier_avg_students_per_family IS NOT NULL`, it is ≥ the maximum tier_size in `tier_rates`.

The breakdown-sum validator is relaxed from the strict "when total_students is set" to "when both total_students and breakdowns are non-trivial" so on-blur saves do not block users mid-data-entry. The UI buffers breakdown_pct edits locally until the sum equals 100 (or is fully cleared to 0) and surfaces "Breakdown sum: X% (must total 100%)" feedback while invalid; the database enforces strict equality once both sides exist. The application validator (Tuition-D) tightens to strict-at-submit semantics when the lock workflow needs them.

**Why this matters at Stage 2**: Stage 2 audit captures **exact** per-family detail (one `tuition_worksheet_family_details` row per enrolled family). The Stage 1 projection model is for budgeting; Stage 2 is for auditing. The two surface together at lock time — the locked Stage 1 snapshot represents "what the school projected"; the locked Stage 2 snapshot represents "what actually happened." Year-over-year comparison (Tuition-B3) reads both.

#### Computed outputs

Two parallel presentations of the same underlying data — different audiences need different framings.

**Family-facing view** — the per-family per-student rate that goes on a tuition agreement:

```
per_student_rate(family) =
  applied_tier_rate
    - (faculty_discount_amount / students_enrolled or 0)
    - (other_discount_amount / students_enrolled or 0)
    - (financial_aid_amount / students_enrolled or 0)
```

This is the single number on a family's signed tuition agreement.

**Accounting view** — rolls up to Budget revenue accounts via §7.6 (Module-to-Budget mapping):

- Gross tuition revenue = Σ (full-rate × students_enrolled) computed at the Tier 1 (single-student) rate
- Multi-student discount aggregate = Gross − Σ (applied_tier_rate × students_enrolled)
- Faculty discount total = Σ faculty_discount_amount (Stage 2 actuals; in Stage 1 the budgeting projection comes from `projected_faculty_discount_amount` directly per v3.8.2)
- Other discount total = Σ other_discount_amount (Stage 2 actuals; equals envelope size in Stage 1 projection)
- Financial Aid total = Σ financial_aid_amount (Stage 2 actuals; equals envelope size in Stage 1 projection)
- Net tuition revenue = Gross − every discount total
- Plus fee revenue: curriculum_fee_per_student × students_enrolled, enrollment_fee_per_student × students_enrolled, before_after_school_hourly_rate × actual_before_after_school_hours (Stage 2) or projected hours (Stage 1)

Each line maps to a specific Budget revenue account per §7.6. Discount totals map to contra-revenue accounts so the Budget shows gross-vs-net cleanly.

**KPIs**:

- **Net education program ratio** — net tuition revenue / Budget expense projection. Tracks how much of operations the families fund vs. how much depends on contributions and other revenue. Same framing as Budget's existing `kpi_ed_program_ratio`; tuition feeds the numerator.
- **Break-even enrollment count** (Stage 1 forward computation) — given proposed tier rates, projected discount envelopes, and the locked Budget's expense projection, the system solves for the enrollment count required to break even. Directly informs Tuition Committee's tier-rate recommendation to the Board: "if we adopt these rates, we need N students to break even; current pre-enrollment is M." The math is a deterministic forward solve given the family-distribution projection (`estimated_family_distribution`) — no optimization, no search.
- **Year-over-year comparison** — prior locked Tuition Worksheet snapshot rendered alongside the current scenario for side-by-side comparison. Particularly useful at Stage 1 (this year's proposed rates vs. last year's locked rates) and at Stage 2 (this year's actuals vs. last year's actuals).

#### Stage 2 immutability rules

When a Stage 2 (Tuition Audit) scenario seeds from a locked Stage 1 (Tuition Planning) snapshot — via a `create_tuition_audit_from_planning_snapshot` RPC parallel to Migration 019's `create_scenario_from_snapshot` for Final Budget — the following fields copy in but are immutable in Stage 2 because families have signed tuition agreements at these rates:

- `tier_count`
- `tier_rates`
- `faculty_discount_pct` (the rule; per-family allocation is editable)
- `curriculum_fee_per_student`
- `enrollment_fee_per_student`
- `before_after_school_hourly_rate`

Stage 2-editable fields:

- Per-family detail rows (the entire `tuition_worksheet_family_details` table — that's the audit, and it only exists in Stage 2).
- `faculty_discount_amount`, `other_discount_amount`, `financial_aid_amount` per family (the rule % is fixed; specific awards happen per family).
- `projected_other_discount`, `projected_financial_aid` — rare. Board may revise mid-cycle if circumstances warrant, but the routine case is that the Stage 1 projection holds. Edits leave a change_log audit trail.
- `projected_faculty_discount_amount` — Stage 1 budgeting projection (v3.8.2). Stage 2 actuals come from per-family `faculty_discount_amount` allocations.
- `total_students`, `total_families`, `top_tier_avg_students_per_family`, and `estimated_family_distribution.breakdown_pct` — Stage 1 projection fields. Stage 2 inherits the snapshot values as a starting reference; the audit's per-family detail rows are the authoritative source of truth, and the projection columns are read-only context in Stage 2.
- `actual_before_after_school_hours` — operational data captured at audit time only.
- `notes` (per family) — governance annotations carry through audit and are editable as the FA committee and board record decisions through the year.

Schema enforces immutability via a `BEFORE UPDATE` trigger (`tg_tuition_stage_2_immutability`) that rejects UPDATEs to Stage-1-locked fields when the row's `stage_id` resolves to the audit (`final`-typed) stage. Three-layer enforcement per CLAUDE.md "Three-layer enforcement for state invariants": trigger as hard guard, application validator (`src/lib/tuitionWorksheet.js`) for pre-flight checks, UI affordance to disable Stage-1-locked fields in Stage 2 scenarios.

#### Tuition Schedule PDF

Family-facing artifact generated from the Stage 1 locked snapshot. Content configured by the Tuition Committee at Stage 1 lock — not just tier rates, but also fee amounts (Curriculum Fee, Enrollment Fee per student) and the B&A School Care hourly rate are committee decisions baked into the snapshot. Per-school template configured during onboarding (some schools have HS structures; some don't; some have volunteer-hours clauses; some don't — template handles the variation).

The Tuition Schedule is once-per-AYE, generated at Stage 1 lock, and distributed to families with their tuition agreements. Stage 2 does not regenerate the schedule (rates do not change post-Stage-1-lock); Stage 2 only captures who actually enrolled at those rates. Print-route pattern follows §5.3: `/print/tuition/:scenarioId/schedule` mounts the family-facing template tree and auto-fires `window.print()` on mount.

#### Module-scoped governance authority (per §3.5)

The Tuition module's canonical authority pattern: the **Tuition Committee chair** (typically the Treasurer or HoS, depending on the school's committee structure) submits Stage 1 for review; the **Treasurer (or designee)** approves the Stage 1 lock. The same authority applies to Stage 2 — Treasurer or designee approves the audit lock, after HoS or Office Manager has captured the per-family detail. The Financial Aid Committee operates outside system-level authority; its decisions appear as per-family annotations in Stage 2 family detail rows (the `notes` column captures "20% per Financial Aid Committee 6/2/25" as the audit signature).

Module-scoped per §3.5: the system enforces only the permission grant (`approve_lock` / `approve_unlock` on the Tuition module) and the distinct-identity constraint between requester and approval_2. The procedural mapping of which user holds the named role — Tuition Committee chair, Treasurer, Board Chair as designee fallback — is school-level configuration, not a system rule. User-facing copy in unlock modals will name "Treasurer (or designee)" parallel to the Budget module's pattern (per §8.13).

#### Implementation status (Tuition-A2, v3.8.1)

The schema and lock/unlock workflow RPCs landed in Migrations 022–026. UI ships in Tuition-B as a separate session. Implementation cross-references:

- **Migration 022** — `tuition_worksheet_scenarios` + `tuition_worksheet_family_details` tables; Stage 2 immutability trigger; sibling-lock guards parallel to Migration 015; module code rename `'tuition_worksheet'` → `'tuition'`; legacy single-stage tables (Migration 001's `tuition_worksheet` + `tuition_scenarios`) dropped with CASCADE; workflow seeded with the two stages (Tuition Planning preliminary, Tuition Audit final).
- **Migration 023** — `tuition_worksheet_snapshots` + `tuition_worksheet_snapshot_family_details` tables. Captured-by-value pattern per §5.1; immutability via reused `tg_prevent_snapshot_update`. Nine KPI columns capture the layered-discount-taxonomy roll-up at lock time.
- **Migration 024** — `compute_tuition_scenario_kpis` + `submit_tuition_scenario_for_lock_review` + `lock_tuition_scenario` + `reject_tuition_scenario_lock`. The lock RPC computes KPIs deterministically (Stage 1: from `estimated_family_distribution` × `tier_rates`; Stage 2: from family detail rows); captures the snapshot; flips state to locked.
- **Migration 025** — `request_tuition_scenario_unlock` + `approve_tuition_scenario_unlock` + `reject_tuition_scenario_unlock`. Two-identity model from §8.13.
- **Migration 026** — `create_tuition_scenario_from_snapshot`. Stage 2 setup gateway (parallel to Migration 019's Budget version): seeds a new Stage 2 scenario from a locked Stage 1 snapshot, copying all configuration fields. The Stage 2 immutability trigger fires on UPDATE not INSERT, so the locked-from-edit fields populate freely at INSERT time.

**Three-layer enforcement of Stage 2 immutability** per CLAUDE.md "Three-layer enforcement for state invariants":

1. **Database** (Migration 022): `tg_enforce_tuition_stage_2_immutability` is the hard guard — fires `BEFORE UPDATE` on `tuition_worksheet_scenarios`, looks up the row's `stage_id` to determine `stage_type`, and rejects any change to `tier_count`, `tier_rates`, `faculty_discount_pct`, `curriculum_fee_per_student`, `enrollment_fee_per_student`, or `before_after_school_hourly_rate` when `stage_type = 'final'`. Error message names the changed fields.
2. **Application validator**: ships in Tuition-B (`src/lib/tuitionWorksheet.js`) as a pre-flight check so the UI can surface the block before the user attempts a change.
3. **UI affordance**: ships in Tuition-B — the Stage 2 configuration fields render as read-only when the scenario's stage is the audit stage, with a tooltip pointing the user back to Stage 1 for tuition rate changes.

**Cross-module lock cascade** per §7.5: not enforced in code as of v3.8.1. Tuition Stage 1 lock will become an upstream gate for Preliminary Budget lock, and Tuition Stage 2 lock will gate Final Budget lock; Budget's lock function will check for the locked Tuition snapshots in a follow-up commit. Today both Budget stages allow override-with-justification because Tuition is not yet contributing live data — this is the realistic day-one state per §7.5.

### 7.4 Staffing

**Purpose**: Staff compensation modeling for an AYE.

**Inputs**: Enrollment context, position decisions, compensation type per row.

**Outputs**: Personnel category totals feeding Budget.

**Schema** (built on existing `staffing_scenarios`, `staffing_scenario_positions`):

```
staffing_scenarios
  ...existing fields...
  enrollment_estimate_id uuid (FK; which Enrollment scenario this assumes)

staffing_scenario_positions
  ...existing fields...
  
  -- Lifecycle tracking:
  is_new_position boolean
  is_eliminated boolean
  prior_aye_position_id uuid (FK to itself; continuity link)
  
  -- Optional linkages:
  linked_strategic_initiative_id uuid (FK, optional)
  
  -- Better tracking:
  rationale text
```

**Design choices**:
- Manual scenario modeling — no preset transformations. Every restructuring decision is explicit (combo class, position elimination, stipend changes, etc.)
- Multiple comp lines per staff member (salary + stipend + leadership = 3 rows, all referencing same `staff_id`)
- Position continuity tracked via `prior_aye_position_id` (medium tier; can expand to rich employment history later)
- Subcontractors are positions in Staffing (account 6500 typically)
- Professional Services (e.g., Fulling bookkeeping at $39k) are direct Budget lines, NOT in Staffing
- Redaction CRITICAL — most viewers see only category aggregates, not individual position lines
- Compensation type math (existing trigger): hourly = (hours × weeks + additional) × base; salaried = base × (1 + raise%) + additional

**Lock timing**: Staffing typically isn't locked until late summer (August/September), AFTER Preliminary Budget. Preliminary Budget locks with Staffing in projection state. Final Budget requires locked Staffing.

### 7.5 Cross-module lock cascade rules

Lock cascade rules formalize which upstream module locks are required before each downstream module can lock. The mechanism is `school_lock_cascade_rules` (per §3.4); this section is the canonical statement of which rules apply between which modules. Each module's section can reference §7.5 rather than restating the cascade locally.

**Cascade table** (Libertas's seed configuration; other schools' configurations may vary on stage timing but follow the same upstream → downstream shape):

| Downstream lock | Upstream prerequisites | Notes |
|---|---|---|
| Tuition Stage 1 (Planning) | Strategic Financial Plan adopted | Warning only, not blocking — Tuition can lock without an adopted plan if circumstances warrant; the override path captures the justification |
| Preliminary Budget | Tuition Stage 1 locked; Enrollment Estimator locked | Staffing is the documented §3.4 exception (allowed in projection state at non-terminal stages) |
| Tuition Stage 2 (Audit) | Tuition Stage 1 locked (same AYE) | Stage-initialization cascade per §3.4: Stage 2 cannot be set up until Stage 1 is locked, since Stage 2 seeds from the Stage 1 snapshot |
| Final Budget | Preliminary Budget locked (same AYE); Tuition Stage 2 locked; Staffing locked | Per Libertas's seeded rules; downstream consumers like Strategic Plan target comparisons read from the locked Final Budget snapshot |

**Override paths exist** for every cascade rule. The current Libertas state (May 2026) has Preliminary Budget locked with override because Tuition / Enrollment Estimator / Staffing modules have not shipped yet — there is nothing upstream to lock. Override usage is captured in the scenario's `override_justification` field and surfaced in the Operating Budget Detail PDF and the activity feed (see §8.13's locked banner pattern). The intent is that override is the realistic day-one path until upstream modules ship; once they ship, the cascade rules become routinely satisfied and override usage decreases to genuine exceptions.

**Cascade enforcement runs at submit-for-lock time** against `school_lock_cascade_rules`, not at draft time. A user can build a Final Budget scenario freely while Tuition Stage 2 is still in drafting; the cascade gate fires only when the user submits the Final Budget scenario for approval. Submit-time validation aggregates cascade gates with module-specific gates (recommended-flag, non-zero amounts, etc.) into a single hardBlock vs. override decision (see §8.9 for the Budget module's submit-time validation pattern; future modules follow the same pattern).

**Granularity** today is module-scoped: cascade rules reference module codes, not stage IDs (per §3.4 — "Granularity"). The whole Tuition module shares one set of upstream requirements; the Stage 1 / Stage 2 distinctions in the table above are downstream framings ("Tuition Stage 1 lock has X upstream requirements, Tuition Stage 2 lock has Y") rather than per-stage cascade rule rows. When per-stage variations become a real need, the schema extension lives in `school_lock_cascade_rules` per the §3.4 note.

**Unlock cascade** is not enforced today (per §3.4 and §8.13). When a downstream module references a locked upstream snapshot (e.g., Final Budget references locked Tuition Stage 2 lines), unlocking the upstream snapshot would invalidate the downstream's source-of-truth. The architecture extension point — block upstream unlock when downstream consumers exist, or warn — is described in §3.4. Today, no module has live downstream consumers in the unlock-blocking sense, so the absence of enforcement does not surface as a real risk.

### 7.6 Module-to-Budget mapping

Each upstream module's outputs flow into specific Budget accounts. Mapping configured in **School Settings → Module Configuration**.

Examples:
- Tuition Stage 1 (Planning) net projected tuition → account "Revenue – Tuition" (feeds Preliminary Budget)
- Tuition Stage 2 (Audit) net actual tuition → account "Revenue – Tuition" (feeds Final Budget)
- Tuition discount aggregates (Multi-student / Faculty / Other / Financial Aid) → contra-revenue accounts so Budget shows gross-vs-net cleanly per §7.3
- Staffing's salary type total → account "Staff Salaries"
- Staffing's hourly type total → account "Hourly Wages"
- Staffing's contractor type total → account "Subcontractors"
- Staffing's tax computation → account "Taxes"

Praesidium configures mappings during school onboarding. Schools can see and verify. Mappings can be changed but flagged as consequential (Section 9.3).

---

## 8. Budget Module (the integration layer)

The most-used screen. Holly's primary workspace.

The Budget module is **one module with configurable workflow stages** (per Section 3.8). Libertas's workflow has two stages — Preliminary Budget and Final Budget — but every school's workflow can differ. The page, the URL, and the data model are all stage-aware: one page (`/modules/budget/:stageId`) renders any stage of any school's workflow. Internal references throughout this document use stage-agnostic language; "Preliminary Budget" and "Final Budget" appear only as Libertas-specific examples.

### 8.1 Visual layout — three zones

```
┌─────────────────────────────────────────────────────┐
│  HEADER ZONE (sticky)                                │
│  AYE 2027 [stage display name] • DRAFTING            │
│  [Save] [View PDF] [Submit] [Compare ▾]              │
│  [Scenario tabs ★] [+ New scenario]                  │
└─────────────────────────────────────────────────────┘
┌────────────────────────────────────┬────────────────┐
│  BUDGET DETAIL ZONE                │  KPI SIDEBAR   │
│  (primary content)                 │  (collapsible) │
│                                     │                │
│  ▼ INCOME                           │  Total Income  │
│     Tuition Revenue   $852,208     │  $1,237,983    │
│     ...                             │                │
│                                     │  Total Expense │
│  ▼ EXPENSES                         │  $1,277,757    │
│     Personnel        $852,759      │                │
│     ...                             │  Net Income    │
│                                     │  -$39,774      │
│                                     │                │
│                                     │  Ed Program    │
│                                     │  Ratio: 0.716  │
│                                     │  Target: 1.02  │
│                                     │  ⚠️             │
│                                     │  ...           │
│                                     │  [Collapse ▸]  │
└────────────────────────────────────┴────────────────┘
```

**KPI sidebar placement** is on the right of the detail zone, chosen during Phase 2 implementation. The original sketch had the KPI panel on the left of the detail zone, but adjacency to the navy nav sidebar (also left) produced a single undifferentiated dark column at the page's edge — users lost the boundary between nav and KPIs. Right-side placement puts cream surfaces on both sides of the navy KPI panel, reading as a clearly bounded element, and matches standard dashboard convention (primary data first, summary metrics second). State of the layout is not architecturally binding; either side is acceptable as long as it doesn't collide with nav chrome.

**KPI sidebar collapsibility**: thin strip with vertical "KPI" label when collapsed. Wide screens (≥1200px): default expanded. Narrow screens (<1200px): default collapsed. State persists per user via `localStorage` (`agora.kpiSidebar.collapsed`). Chevron points inward (◂) when collapsed and outward (▸) when expanded, matching the spatial intuition for a right-anchored panel.

PDFs render KPIs at top (header treatment), not as a sidebar — PDFs aren't constrained by screen width.

### 8.2 Source indicators

- Auto-pulled rows: small icon (lock/link), hover reveals source. Click navigates to upstream module.
- Manual rows: clean, no indicator.

Subtle enough not to distract; visible enough to inform.

### 8.3 Editing model

**Direct edit with undo.** Click amount → inline editor → live KPI updates → save on blur or Enter. Cmd+Z works. Every change logged in `change_log`.

Auto-pulled rows are read-only here. To change them, navigate to upstream module.

The "scenario sandbox" concept becomes implicit through multi-scenario support (Section 8.7) and direct-edit-with-undo. Proposed changes during meetings happen as edits with immediate KPI feedback; undo if rejected.

### 8.4 Universal KPI set

Always visible, computed in real-time:

```
Total Income          = SUM(income amounts where NOT pass_thru)
Total Expenses        = SUM(expense amounts where NOT pass_thru)
Net Income            = Total Income - Total Expenses
Ed Program Dollars    = SUM(income amounts where is_ed_program_dollars = true)
Ed Program Ratio      = Ed Program Dollars / Total Expenses    (target shown alongside)
Contributions Total   = SUM(income amounts where is_contribution = true)
% Personnel           = Personnel total / Total Expenses
Number of Students    = pulled from Enrollment Estimator (or manual override)
Cost per Student      = Total Expenses / Number of Students
Current Tuition       = pulled from Tuition Worksheet
Tuition Gap           = Cost per Student - Current Tuition
Break-even Enrollment = Total Expenses / Net Tuition per Student
Cash Reserve Months   = (Cash on hand) / (Total Expenses / 12)    (requires QB integration; future)
Projected Cash Flow Ending Balance — pulled from cash flow forecast
```

Comparison annotations: each KPI shows current value + target/comparison. "Ed Program Ratio: 0.716 (target: 1.02) ⚠️". Comparisons pulled from:
- Strategic Financial Plan targets for the AYE
- The most recent locked snapshot for the prior AYE whose `stage_type_at_lock` is terminal (e.g., the prior AYE's locked Final Budget for Libertas)
- Prior year's actuals (when QB integration exists)

### 8.5 Strategic KPI Dashboard (separate view)

Modeled on the screenshot Jenna shared during design. Multi-AYE comparison against Strategic Financial Plan target ranges. Color-coded variance (red out of range, green in range).

**Categories displayed**:
- Revenue Sources (Tuition & Fees, Fundraising & Donations, Auxiliary Income — as % of total revenue)
- Expense Allocation (Salaries & Benefits, Facilities, Educational Materials, Admin, Financial Aid — as ratios)
- Cash Reserves (months of operating expenses)

**Columns**:
- Target Range (gold)
- Current AYE Actuals
- Next AYE Projected
- Variance

Accessible from Strategic Plan module, Budget module, and Dashboard. Print-ready PDF for board binder and accreditation evidence.

### 8.6 Comparison views

Multiple simultaneous comparison columns supported (landscape orientation for PDFs):

```
                    AYE 27 Prelim   AYE 26 Final   AYE 26 Actuals   Variance
Personnel              $852,759       $834,567       $818,300         +$34,459 (4.2%)
```

Significant variances flagged (default >5% or >$10k; configurable per school).

**Variance Report view** is a priority output (recent pain point at Libertas). Side-by-side comparison of two snapshots or snapshot vs. actuals, with variance columns.

### 8.7 Multiple Budget scenarios per (AYE, Stage)

Real use case: HoS presents board with "with HS" vs. "without HS" budget options. Schema supports this via parallel scenarios scoped to **(AYE, Stage)** — every stage of the workflow gets its own scenario set, and within a stage multiple scenarios can coexist.

```
budget_stage_scenarios       (one set per (aye_id, stage_id))
  id, aye_id, stage_id, scenario_label, description, is_recommended
  state ('drafting' | 'pending_lock_review' | 'locked' | 'pending_unlock_review')
  narrative text (optional — see Section 8.8)
  show_narrative_in_pdf boolean (default true if narrative present)
  locked_at, locked_by, locked_via, override_justification, audit fields

budget_stage_lines
  id, scenario_id (FK), account_id, amount, source_type, source_ref_id, etc.

budget_snapshots               (shared across stages; stage_id distinguishes)
  ...standard snapshot fields...
  stage_id (FK), stage_display_name_at_lock, stage_short_name_at_lock,
  stage_type_at_lock           -- captured by value (Section 5.1)

budget_snapshot_lines           (FK to budget_snapshots)
  account state captured by value: code, name, hierarchy_path, flags
```

ONE scenario marked `is_recommended` at lock time → becomes the official locked snapshot for that (AYE, Stage). Other scenarios remain queryable for "what-if" review. The partial unique index `budget_stage_scenarios_one_locked_recommended` enforces that two stages of the same AYE can each have their own locked recommended scenario.

#### 8.7.1 Lock-state interactions across scenarios

Once any scenario in a (AYE, Stage) reaches `locked`, it is the authoritative approved budget for that slot. Competing scenarios in the same slot are subject to two governance rules that constrain promotion-class actions while a sibling is locked:

1. **Recommendation gate** — no other scenario in the same `(aye_id, stage_id)` may be marked `is_recommended = true` while a sibling is `locked`. The locked scenario itself remains marked recommended (its own snapshot captured `is_recommended_at_lock = true` and the live row must agree).
2. **Submission gate** — no other scenario in the same slot may transition `drafting → pending_lock_review` while a sibling is `locked`. Two simultaneously-pending or pending+locked siblings would create a contradictory governance artifact.

**Drafting alternatives is still allowed.** Edits to scenario lines and to the row's label/description/narrative continue uninhibited. Only the promotion-class actions (recommend, submit) are gated. This preserves the "what-if" exploration use case (HoS sketching alternatives the board may want to revisit) without letting an alternative claim approved status while the locked one is the official record.

**Three-layer enforcement** (defense in depth):

- **Schema** (Migration 015) — two `BEFORE UPDATE` triggers on `budget_stage_scenarios`: `tg_prevent_recommend_while_sibling_locked` rejects setting `is_recommended = true` on any other row in the slot when a sibling is `locked`; `tg_prevent_lock_submit_while_sibling_locked` rejects the `drafting → pending_lock_review` transition for the same reason. Both fire only on the specific transition, so no-op UPDATEs (e.g., re-saving the locked row itself) pass through. These triggers are the authoritative guard — the application layer mirrors them but cannot bypass them, and admin "override" at the application layer does not apply.
- **Application validation** (`validateScenarioForLock` in `src/lib/budgetLock.js`) — when a sibling is locked, returns a failure tagged `hardBlock: true, kind: 'sibling_locked'`. SubmitLockModal hides the override checkbox entirely when any hardBlock failure is present (rather than offering an override path the database would refuse) and the Submit button is permanently disabled until the upstream condition is resolved.
- **UI affordances** — `findLockedSibling(scenarios, currentScenarioId)` is a pure/sync helper over the in-memory scenarios list (no DB roundtrip). ScenarioTabs uses it to disable "Mark as recommended" with a tooltip naming the locked scenario; BudgetStage uses it to render an amber informational banner above the budget detail when the active scenario is `drafting` and a sibling is locked, and to feed the Submit button's tooltip and disabled state.

**Historical-data repair**: the bug that motivated Migration 015 produced a corrupted state — locked scenarios with `is_recommended = false`, contradicting the snapshot's captured `is_recommended_at_lock = true`. Migration 015 includes a one-time DO block at the top of the migration that detects this state and repairs it (clears `is_recommended` on any non-locked sibling in the slot, then sets `is_recommended = true` on the locked row). The repair runs before the new triggers are installed, so the recommend-guard trigger doesn't reject the repair UPDATE. Idempotent on a clean DB; emits `raise notice` per repaired row.

**Diagnostic queries** (post-migration health checks):

```sql
-- Should return zero rows: locked scenarios that aren't marked recommended.
select aye_id, stage_id, scenario_label, state, is_recommended
  from budget_stage_scenarios
 where state = 'locked' and is_recommended = false;

-- Should return zero rows: (AYE, stage) slots with multiple recommended scenarios.
select aye_id, stage_id, count(*) as n_recommended
  from budget_stage_scenarios
 where is_recommended = true
 group by aye_id, stage_id
having count(*) > 1;

-- Should return zero rows: (AYE, stage) slots with a locked scenario AND another scenario in pending_lock_review.
select a.aye_id, a.stage_id, a.scenario_label as locked_label, b.scenario_label as pending_label
  from budget_stage_scenarios a
  join budget_stage_scenarios b
    on a.aye_id = b.aye_id and a.stage_id = b.stage_id and a.id != b.id
 where a.state = 'locked' and b.state = 'pending_lock_review';
```

The unlock workflow (queued for a later session) is the only escape from a locked state; admin override at the application layer cannot bypass the trigger guards.

### 8.8 Narrative space

Optional narrative field on every budget scenario. HoS or Treasurer's contextual notes about priorities, cuts, decisions. Renders in Operating Budget Detail PDF when present. NOT in Budget Summary (community-facing). Optional — leave blank, hidden in UI.

In practice the narrative is most useful on early-cycle stages (e.g., Libertas's Preliminary Budget, where context for revisions matters); terminal stages (Final, Adopted) often inherit the prior stage's narrative or omit it. The schema allows narratives on any stage; stage-specific defaults can be added in the Phase R2 workflow editor.

### 8.9 Lock workflow

The lock workflow is **stage-agnostic** — every stage of every workflow uses the same submit / approve / reject transitions and atomic snapshot capture. Permission gates (`submit_lock`, `approve_lock`) are module-level, not stage-level.

**Submit-time validation** runs against `school_lock_cascade_rules` for `module_being_locked = 'budget'` plus generic in-memory checks:
- Active scenario must be marked `is_recommended` → error
- At least one budget line must have a non-zero amount → error
- Cascade rules for the budget module must be satisfied → error or override
- Strategic Financial Plan adopted (covers this AYE) → warning only, not blocking

For Libertas's seeded rules per §7.5: Preliminary Budget requires locked Tuition Stage 1 and locked Enrollment Estimator; Final Budget additionally requires locked Tuition Stage 2 and locked Staffing. Staffing is the documented §3.4 exception at non-terminal stages (allowed in projection state when locking Preliminary Budget); the cascade rules table in §7.5 reflects that by requiring Staffing only at Final Budget. When per-stage cascade variations become a real need (e.g., "Final Budget specifically requires locked Staffing while Preliminary is fine with projected"), see §3.4's "Granularity" note for the schema extension.

If override used: justification text required, recorded in `override_justification` on the scenario row and carried into the snapshot at lock time.

**Approval step**: Submit → `pending_lock_review` → designated approver reviews → Approve → atomic call to `lock_budget_stage_scenario(scenario_id, locked_via, override_justification)` (Migration 012) → state flips to `locked` and the snapshot lands in the same transaction.

**Stage progression**: Locking one stage doesn't auto-advance to the next. The user moves between stages via the sidebar; each stage carries its own scenario set and lock lifecycle. A locked Stage 1 (e.g., Preliminary Budget) is the snapshot a downstream Stage 2 (e.g., Final Budget) can compare against.

**Re-lock**: A scenario locked in error needs the unlock workflow (`pending_unlock_review` → `drafting`), which is queued for a later session. Until then, locked scenarios stay locked; the user creates a new scenario in the same stage if changes are needed.

### 8.10 Operating tool layer (future)

Schema and UI ready to extend when QB actuals integration is built:
- Future `monthly_actuals` table referencing `chart_of_accounts.id` and `aye_id`
- Budget detail zone grows "actuals to date" column when actuals data exists
- KPI panel grows current-month and YTD variance indicators
- Variance reports join actuals to locked Budget snapshot

### 8.11 Print-ready outputs

- **Operating Budget Detail** ✅ shipped (Phase 2 Commit F): full hierarchical line items, board/internal use. DRAFT and LOCKED variants share a single route (`/print/budget/:scenarioId`); the variant is determined by the scenario's state at fetch time. DRAFT variant renders from live data with a diagonal watermark and "preliminary working version" footer. LOCKED variant renders exclusively from `budget_snapshot_lines` captured-by-value columns (no live COA joins) and the snapshot's `kpi_*` columns; the footer carries the approved-by indicator with snapshot uuid and the override justification when applicable.
- **Budget Summary** — deferred. Category totals only, public/community-facing. Will share the snapshot data source with Operating Budget Detail and add a redaction layer at the leaf level.
- **Variance Report** — deferred. Comparison view (priority once QB actuals integration arrives).

All three render from the same locked snapshot. View selected at PDF generation.

In addition, two **audit-surface print routes** ship in Commit F:

- `/print/budget/:scenarioId/activity` — per-scenario activity feed (chronological change_log)
- `/print/budget-line/:lineId/history` — per-line change_log

Both read from `change_log` directly (subject to the `change_log_read` RLS policy from Migration 011 — `budget.view` permission required). The print versions are reproducible from URL alone — they do NOT respect any in-app filter state, which is the right behavior for an audit artifact.

### 8.12 Header button gating

Three buttons sit in the page header zone, each gated independently:

- **Save** — enabled when a scenario exists, state is `drafting`, and the user has `edit` permission. The underlying interaction is direct-edit-with-undo (Section 8.3), so saves are implicit on blur. Save is a confidence affordance — clicking it surfaces a toast confirming changes are persisted. Disabled in `pending_lock_review` and `locked` states (no edits possible) and when the user lacks `edit`.
- **View PDF** — always enabled when a scenario exists. Renders DRAFT-marked output for non-locked scenarios (per Section 2.5) and the approved snapshot for locked scenarios (per Section 2.6). Independent of `is_recommended`.
- **Submit for Lock Review** — enabled only when the scenario is in `drafting`, the user has `submit_lock` permission (or `admin`, which subsumes), AND the scenario is marked `is_recommended = true`. The recommended requirement is the most non-obvious gate; an inline hint appears below the button when it's the specific blocker (state and permission are both fine, but `is_recommended` is false), pointing the user at the scenario tab kebab menu where the marker is set. The hint is suppressed when other gates are the actual blocker so it doesn't nag.

The three buttons disabling for different reasons must look the same visually but expose distinct tooltip explanations on hover. A user looking at three grayed-out buttons should be able to identify which gate is active for each.

### 8.13 Unlock workflow

Locking a Budget scenario produces an immutable governance record. Unlocking it — to correct a mistake, incorporate updated upstream data, or reopen for revision — is rare but must be possible. The unlock workflow is the controlled path back to `drafting`.

**Two-identity model** (refactored v3.7 from a prior three-identity design). Unlocking requires **two distinct identities**, both holding `approve_unlock` permission:

1. **The requester**, who submits the unlock request with justification. The submission represents the requester's professional judgment that unlock is warranted; this counts as approval 1. `request_budget_stage_unlock(scenario_id, justification)` atomically sets the request fields AND the approval_1 fields from the caller's identity in a single transaction.
2. **The second approver**, who must be a different `approve_unlock` holder. `approve_budget_stage_unlock(scenario_id)` records approval 2, transitions `state` to `'drafting'`, and clears all `unlock_*` fields — single atomic transition, no first/second branching.

Either path can be aborted with `reject_budget_stage_unlock(scenario_id, reason)`. Two authorization branches share this function: an `approve_unlock` holder (other than the requester) can reject someone else's pending request; the original requester can withdraw their own request. Both paths require non-empty reason text. State stays `'locked'`; all unlock fields clear.

**Why two identities, not three.** The original three-identity model required a separate requester (with `submit_lock`) plus two additional approvers (each with `approve_unlock`), all distinct. For a small school's governance reality — Libertas's HoS, Treasurer, and Board Chair all hold `approve_unlock` — three-identity was bureaucratic overkill. The two-identity model maps to the actual workflow: HoS requests (the budget is her lane), Treasurer typically lands the second approval, Board Chair as last-resort second approver. The requester's submission already represents her professional judgment; treating it as approval 1 is honest about what a request actually is.

**State stays 'locked' throughout.** Migration 015's sibling-lock guards check `state = 'locked'`, and we want those guards to remain in force during the unlock-in-progress window. The active scenario IS still locked from the perspective of the AYE-stage slot; competing scenarios still cannot claim recommended status or submit for lock review while it is locked. The flag fields (`unlock_requested`, `unlock_approval_1_*`, etc.) layer on top of `state = 'locked'`. The state machine value `pending_unlock_review` is reserved in the CHECK constraint but unused under this design — flags-on-top-of-locked is simpler than a full state machine state and avoids re-litigating the sibling-lock rules.

**Schema fields** on `budget_stage_scenarios`:

- `unlock_requested` (bool, default false) — flag indicating a request is in flight.
- `unlock_request_justification`, `unlock_requested_at`, `unlock_requested_by` — request metadata, populated atomically when the request is submitted.
- `unlock_approval_1_at`, `unlock_approval_1_by` — populated atomically with the request fields under the v3.7 model. Same identity as `unlock_requested_by`.
- `unlock_approval_2_at`, `unlock_approval_2_by` — populated by the second approver during the approve transaction; cleared along with all other unlock_* fields when state flips to drafting (the audit trail of who approved second survives in `change_log` via the trigger).

**Integrity rules enforced at three layers.** Defense in depth:

- **Schema** (Migrations 016 + 020 + the trigger from 016):
  - `unlock_initiator_not_approver_2` — requester ≠ approval_2 (CHECK).
  - `unlock_approvers_distinct` — approval_1 ≠ approval_2 (CHECK). Under the v3.7 model where requester == approval_1, this constraint primarily backstops the requester-cannot-also-be-approval_2 rule.
  - `unlock_sequential_ordering` — approval_2 cannot populate before approval_1 (CHECK).
  - `tg_unlock_only_when_locked` — `unlock_requested = true` requires `state = 'locked'` (BEFORE trigger).
  - The CHECK constraint that originally enforced "requester ≠ approval_1" (`unlock_initiator_not_approver_1`) was dropped in Migration 020 — the v3.7 model deliberately collapses these two identities.
- **Function** (Migration 021): `approve_budget_stage_unlock` raises a clear exception when the caller is the requester. `request_budget_stage_unlock` raises if the scenario is not locked, an unlock is already pending, or the justification is empty.
- **Application + UI**: `src/lib/budgetUnlock.js` validators + `LockedBanner` morphing banner mirror the same rules so users see the block before they click. The Approve button is rendered disabled-with-tooltip (rather than hidden) when initiator separation blocks the user — explains the rule rather than vanishing.

**Permission tier.** `approve_unlock` is the hierarchical enum value inserted between `approve_lock` and `admin`:

```
view < edit < submit_lock < approve_lock < approve_unlock < admin
```

Subsumption semantics consistent with the rest of the permission system. `approve_lock` users do not auto-get `approve_unlock` (`>=` check returns false). `admin` users do (admin subsumes everything). `approve_unlock` is granted manually per-user; no role inference. **Under v3.7, `approve_unlock` is the gate for both requesting AND approving** — `submit_lock` is no longer relevant to the unlock workflow. Submitting an unlock request is itself a governance act of approval; the permission to do it is the same as the permission to approve.

**Module-scoped governance authority for the Budget module** (codified v3.7.1, per §3.5). The Budget module is fiscal, so user-facing copy in this module names the **Treasurer (or designee)** as the canonical second approver. RequestUnlockModal explicitly frames the workflow as "Submitting records your approval as the first of two. Treasurer (or designee) must confirm to complete the unlock"; the LockedBanner's "Request unlock from the Treasurer" guidance follows the same convention.

At Libertas, the procedural mapping looks like this: the **Head of School** (Holly Bauers) is the typical requester — the budget is her operational lane, and her submission carries her professional judgment as approval_1. The **Treasurer** lands the second approval as part of normal fiscal governance. The **Board Chair** acts as designee fallback — the "or designee" clause in the copy — for cases where the Treasurer is unavailable or recused on a particular vote. All three currently hold `approve_unlock` on the Budget module. The system does not enforce any of this procedural mapping; it enforces only the permission grant and that approval_2 comes from a different identity than the requester. The named role in the copy is the school's procedural choice, made portable through the "or designee" trailer so the same string keeps working when the Treasurer rotates or is temporarily unavailable.

Future lockable modules name their own canonical role per §3.5 — Strategic Plan would name the Board Chair (governance), an Accreditation module would name the Head of School (curricular). The Budget module's choice of "Treasurer (or designee)" is module-specific; nothing about the system mechanics is.

**Audit trail.** Every action writes to `change_log` via the existing `tg_log_changes` trigger (attached to `budget_stage_scenarios` since Migration 011). The functions tag each transaction with a recognizable `app.change_reason` signature so audit-feed filters can group these events distinctly:

- `unlock_requested` — initial request submission. Under v3.7 this single event captures both the request AND the requester's approval_1 identity (same person, same transaction).
- `unlock_completed` — second-approval transition (state flips here).
- `unlock_rejected: <reason>` — rejection by an approve_unlock holder other than the requester.
- `unlock_withdrawn: <reason>` — withdrawal by the original requester.

The `unlock_first_approval` reason that existed under the v1 three-identity model is no longer emitted by new transactions; v3.7's request RPC writes `unlock_requested` only. The `classifyEvent` kind remains in `auditLog.js` for backward compat — historical change_log entries from before the v3.7 refactor (none in live data, since no v1 unlock workflow ever ran to first-approval) would still classify correctly.

The user-supplied justification (request) is captured in `unlock_request_justification` AND in the trigger-emitted change_log row for that field. The user-supplied reason (reject/withdraw) is folded into `app.change_reason` because rejection clears all unlock fields — no surviving row-level field would otherwise carry it.

**Sibling-lock interaction during unlock-in-progress.** Migration 015's triggers (`tg_prevent_recommend_while_sibling_locked`, `tg_prevent_lock_submit_while_sibling_locked`) continue to fire while a sibling scenario in the same `(aye_id, stage_id)` is `state = 'locked'` — including throughout the unlock-in-progress window. Drafting alternatives remains allowed; promotion-class actions on siblings remain blocked until the approval transaction completes and state actually transitions to `'drafting'`.

**Cascade rules.** Unlock has no upstream cascade requirements and no downstream consumer enforcement today (§3.4). Architecture extension point only. When Final Budget or Strategic Plan ship and reference locked Budget snapshots, unlock-time validation will need to either block or warn when downstream consumers exist.

#### Application validator layer

`src/lib/budgetUnlock.js` mirrors the structure of `src/lib/budgetLock.js` — pure/sync helpers operating on already-loaded scenario data and pre-evaluated permission booleans. No DB calls. The helpers are the source of truth the UI consults before showing affordances and again at click time before firing RPCs.

Public surface (v3.7):

- `getUnlockBannerState(scenario)` — returns `'locked_no_request'` or `'locked_awaiting_final_approval'`. Two states; the intermediate `'locked_awaiting_first_approval'` from the v1 three-identity model is gone.
- `canRequestUnlock(scenario, currentUser, hasApproveUnlock)` — mirrors the DB rules in `request_budget_stage_unlock`. Permission gate is `approve_unlock` (was `submit_lock` in v1).
- `canApproveUnlock(scenario, currentUser, hasApproveUnlock)` — mirrors `approve_budget_stage_unlock`. Failure modes simplified from v1: removed `is_first_approver` (no longer relevant since requester is always approval_1).
- `canRejectUnlock(scenario, currentUser, hasApproveUnlock)` — the "approver rejects someone else's request" branch.
- `canWithdrawUnlock(scenario, currentUser)` — the "requester cancels their own request" branch (no permission check beyond requester identity).
- `validateUnlockRequest(...)`, `validateUnlockRejection(...)`, `validateUnlockWithdraw(...)` — wrap the canX gates with non-empty + min-length text-content checks for justification / reason fields.
- `UNLOCK_REASON_COPY` — exported map of `reason_code` → user-facing string. UI components import this for tooltips and inline error messages so wording lives in exactly one place.
- `UNLOCK_TEXT_MIN_LENGTH` (constant: 10 characters).

All `can*` helpers return `{ ok: true }` or `{ ok: false, reason: '<short_code>' }`. Reason codes are machine-readable identifiers translated via `UNLOCK_REASON_COPY` — keeps logic and copy decoupled.

**Permission shape note.** The validator helpers take pre-evaluated booleans (e.g. `hasApproveUnlock`) rather than a permission-level string. The actual codebase pattern is `useModulePermission(moduleCode, level)` returning `{ allowed: boolean }` per gate; the `>=` comparison is done server-side by `current_user_has_module_perm`.

#### UI layer

**Single morphing banner** (v3.7: two states, was three). `LockedBanner` renders one of:

- `locked_no_request` — green/approved treatment (or amber if `locked_via='override'`). "Request unlock" button appears when `canRequestUnlock(...).ok === true`.
- `locked_awaiting_final_approval` — amber treatment (`bg-status-amber-bg` / `text-status-amber`), 🔓 icon. Inline content: requester name + timestamp + full justification text (no truncation, parallel to override-event treatment, §9.1 commitment) + a sentence noting "Their submission counts as the first approval; one additional approver is required to complete the unlock." Action buttons: "Approve unlock", "Reject", "Withdraw request" — each gated by the corresponding `canX` helper. The Approve button is rendered as disabled-with-tooltip (rather than hidden) when initiator separation blocks the user — so the user understands the rule rather than wondering where the affordance went.

The banner stays compact (status copy only). All actions open dedicated modals — approval is governance-weight; modal confirmation is appropriate.

**Four modals**, all following the established `SubmitLockModal` pattern (cream surface, navy/30 backdrop, header / body / footer flex column, Cancel + primary on right, Escape closes):

- `RequestUnlockModal` — required justification textarea with live character counter (10-char minimum). Body copy explicitly frames the submission as approval 1: "Submitting this unlock request records your approval as the first of two." Submits to `request_budget_stage_unlock` RPC.
- `ApproveUnlockModal` — title is plain "Approve unlock" (v1's "first of two / final of two" branching is gone since approval_1 is always already populated by request time). Body copy: "You are recording the second approval of this unlock request. Confirming will transition this scenario to drafting and clear all unlock approval state." Confirm button: "Approve and unlock". Submits to `approve_budget_stage_unlock` RPC.
- `RejectUnlockModal` — required reason textarea; destructive button styling (`bg-status-red`). Submits to `reject_budget_stage_unlock` RPC.
- `WithdrawUnlockModal` — required reason textarea; muted/secondary button styling. Submits to the same `reject_budget_stage_unlock` RPC. The same RPC handles both reject and withdraw paths — the function auto-detects which path by comparing `auth.uid()` to `scenario.unlock_requested_by`.

User display name for the requester is resolved from `user_profiles.full_name` inside the components that need it. Under v3.7, requester == approval_1, so a single lookup covers what the banner and modals show.

**Audit log integration.** `src/lib/auditLog.js` recognizes the unlock event kinds via `change_log.reason` signature. Visual treatment: amber for in-progress, blue with 🔓 icon for `unlock_completed` (mirrors lock events as governance milestones at the symmetric ends of the lock/unlock cycle), red-muted for rejected, plain muted for withdrawn (housekeeping, neutral).

### 8.14 Final Budget setup model

Multi-stage Budget workflows (Libertas: Preliminary + Final today) need different setup gateways for first vs. non-first stages. The first stage starts from an external source — a prior AYE's snapshot, a CSV import, or a fresh start. Subsequent stages start from a previous stage's locked snapshot in the same AYE: a Final Budget should mean "the locked Preliminary, with revisions," not "a brand-new budget that happens to live in the Final stage slot."

**Detection rule.** A stage is the first in its workflow when it has the lowest `sort_order` value among `module_workflow_stages` rows sharing the same `workflow_id`. Libertas Preliminary has `sort_order = 1`; Libertas Final has `sort_order = 2`. The detection is parameter-free — any school's workflow editor can re-order stages and the gateway adapts.

**Setup view branches** (rendered in `BudgetStage.jsx` when no scenario exists yet for the active AYE+stage):

- **First stage** → `BudgetEmptyState` (the original three-option flow: bootstrap from prior AYE, CSV upload, fresh start). Unchanged from prior behavior.
- **Non-first stage with at least one locked predecessor** → `PredecessorSelector`. Renders one card per locked predecessor stage in the same AYE. Each card shows the predecessor's stage name (e.g. "Preliminary Budget"), the working scenario name from the snapshot (e.g. "Scenario 1" — this is a working-tool surface, not the canonical name; see §8.15), the lock date, the approver's name, and the captured KPI totals (income, expenses, net). Click opens `SeedFromPredecessorModal` for confirmation. Even when only one predecessor exists, the card flow is preserved as a deliberate confirmation pause rather than auto-progressing.
- **Non-first stage with no locked predecessor yet** → `PredecessorSelector` empty state. Friendly explanation that the stage requires a locked predecessor, plus a link back to the predecessor stage. Setup is blocked; no fallback to the three-option flow (that flow is conceptually wrong for non-first stages).

**Seeding flow.** `SeedFromPredecessorModal` calls the new RPC `create_scenario_from_snapshot(p_target_stage_id, p_source_snapshot_id, p_scenario_name)` (Migration 019, SECURITY DEFINER). The function validates that the source snapshot's stage is a predecessor of the target stage in the same workflow, then inserts a new drafting scenario in the target stage and copies snapshot lines into `budget_stage_lines`. Snapshot lines whose `account_id` is NULL (because the live account was hard-deleted post-lock and `ON DELETE SET NULL` fired) are skipped silently — they cannot be materialized as live lines without an account reference. The audit trail tags this as `'created_from_snapshot: <snapshot_id>'` in `change_log.reason` so the new scenario's audit history links back to the predecessor permanently.

**Downstream effects.** Once seeded, the new stage's scenario behaves identically to a Preliminary scenario: multiple scenarios per stage, mark-recommended, copy-from-current-scenario within stage, lock workflow, audit feed, PDF generation. Migration 011's stage-agnostic schema already supports this; no additional schema work is needed beyond Migration 019.

**Generalization.** This model applies to any non-first stage of any module workflow. When future modules ship multi-stage workflows (Strategic Plan revisions, Accreditation cycles), the same setup gateway pattern applies — `PredecessorSelector` is module-agnostic by design (it operates on `module_workflow_stages` and `budget_snapshots`, but the equivalent for other modules will follow once their snapshot tables exist).

### 8.15 Canonical naming of locked artifacts

A locked Budget snapshot is the official approved artifact for a (school, AYE, stage) slot. It deserves a canonical name that reads as a real governance document — "Libertas Academy AYE 2026 Preliminary Budget" — rather than a working scenario label like "Scenario 1" that was useful when the budget was being drafted but is meaningless to a board chair reading the PDF in a binder.

**The rule.** Wherever a locked artifact is referenced **as an object** — the document the board approved, the snapshot in someone's binder — the canonical name applies. Wherever the user is **working with a scenario** as a tool — the scenario tab they click to switch between alternatives, the audit-log entry that records what the scenario was called when the action happened — the working name (`scenario.scenario_label`) applies.

**Format**: `{school name} {AYE label} {stage display name}`, e.g. `"Libertas Academy AYE 2026 Preliminary Budget"`. School name comes from `src/lib/schoolConfig.js` (single source of truth — when multi-tenancy lands and per-school brand settings ship via `school_brand_settings`, only `schoolConfig.js` needs to change).

**Surfaces using canonical name** (locked artifacts only):

- ✅ Operating Budget Detail PDF letterhead — locked variant only; DRAFT variants render the AYE+stage as a contextual heading and the working scenario name as subtitle (DRAFT is a working artifact, the canonical identity does not yet exist).
- ✅ Locked banner heading (the morphing banner from §8.13) — canonical applies in all three locked-state variants. The artifact identity does not change while unlock is pending; only after unlock completes does state flip to drafting and the working name take over (and the banner itself stops rendering).
- 🟡 Future dashboard "locked artifacts" surfaces — applied when implemented. No such surface exists today; the rule is the architectural commitment.
- 🟡 Other future surfaces that reference a locked artifact as an object (email templates, calendar events, board packet generation) — applied when implemented.

**Surfaces using working name** (scenario.scenario_label):

- Scenario tabs — even when the active tab is a locked scenario, the tab is a working-tool affordance for switching between scenarios.
- Audit log entries (`LineHistoryModal`, `ActivityFeedPanel`, the two audit print pages) — historical records preserve the truth of what the scenario was called when the action happened.
- Drafting-mode UI — page header, banners during drafting, modals during drafting.
- DRAFT-marked PDF letterheads — see above.

**Implementation.** Render-time computation, no schema change, no snapshot data backfill. The helper `getCanonicalLockedArtifactName(aye, stage, fallback)` in `src/lib/scenarioName.js` computes the canonical string from objects the caller already has loaded; `getDisplayNameForContext(context, {scenario, aye, stage})` is the dispatch function — pass a context string and it returns the right name. Existing locked Scenario 1 begins displaying canonical name in the relevant surfaces immediately upon deploy.

---

## 9. Cross-Cutting Concerns

### 9.1 Audit Log Surfacing

Three contextual views of `change_log` data. Phase 2 Commit F shipped the first two for the Budget module; the third is admin tooling queued for a later phase.

**Per-record history** ✅ (Budget): A small clock affordance on every leaf budget line opens `LineHistoryModal`, a chronological list of every change_log event scoped to that specific `budget_stage_lines` row. Each event renders the user, timestamp, and field-level diff (e.g., `amount: $4,200 → $5,000`). Sort toggle (newest/oldest first). Footer offers "Export as PDF" → `/print/budget-line/:lineId/history`. **Locked-state suppression** (added v3.6): the per-line clock affordance is hidden when the active scenario is in `locked` state. Per-line drilldown is editing-mode functionality; the activity feed remains the comprehensive surface for locked-state audit history exploration. The visual case for suppression: a locked artifact already carries the LockedBanner overhead and per-row clock icons compete with the strengthened four-tier hierarchy for attention. The functional case: in locked state the lines are read-only, so per-line "what changed" surfacing is less actionable than the scenario-level activity feed which captures lock and unlock events alongside the line edits.

**Per-module recent activity** ✅ (Budget): `ActivityFeedPanel` mounts in the BudgetStage detail zone as a collapsible panel. Default state: collapsed, showing the unfiltered event count. Expanded: count dropdown (10/25/default/50/100/All) + filter (All / Lock+Override only / Edits only). Each event renders the user, summarized action, relative timestamp, and — for override events — the full justification text. Footer offers "Export as PDF" → `/print/budget/:scenarioId/activity`.

**Per-user activity**: Admin-only view, deferred. "Show me everything user X did in date range Y."

**Implementation** lives in `src/lib/auditLog.js`:

- `fetchLineHistory(lineId)` — events for a single budget_stage_lines row, with user names resolved via `user_profiles`
- `fetchScenarioActivity(scenarioId, { limit, accountsById })` — events for the scenario row + every line belonging to it (deleted lines included; their __delete__ events stay in the feed)
- `groupChangeLogRows()` — collapses fan-out UPDATE rows (the trigger writes one row per changed field) into single logical events with a `fields` array
- `classifyEvent()` — assigns one of nine kinds (`insert`, `delete`, `lock`, `submit`, `reject`, `recommend`, `override`, `amount`, `edit`) by priority so each event has a single high-level category for visual treatment
- `summarizeEvent()` / `describeField()` — humanize events for the feed and field-level diffs respectively

**Lock events** rendered distinctly: blue left rule, 🔒 icon, light blue background fill. They're governance milestones, not routine edits.

**Override events** rendered MORE distinctly: amber left rule, amber background fill, full justification text rendered immediately below the event line in italic. SCL accreditation review wants overrides documented, not buried — they're never truncated, never collapsed behind a "show more."

**Schema additions to `change_log`**:
```
display_priority enum ('routine', 'milestone', 'override')
related_snapshot_id uuid (FK; for milestone events)
```

**Search/filter**: Not implemented in v1. Schema and UI designed to accept later.

### 9.2 AYE Lifecycle

**States**: `planning`, `active`, `closed`.

The cadence parameters in this section reflect Libertas's calendar today and are **not yet configurable in schema**. The future home for per-school configuration is Annual Rhythm Settings (Section 9.7); when a second school onboards with a different fiscal calendar or close cadence, the schema extends and these parameters move out of code defaults.

**Naming convention**: `AYE [end_year]` (e.g., AYE 2027 = July 1, 2026 - June 30, 2027). Configured in **School Settings → Organization → Fiscal Year Settings** today as a display-only setting; the underlying boundary dates are still code-level defaults.

**Auto-creation** (Libertas default): System auto-instantiates next AYE in `planning` state ~9 months before it begins. No human action required.

**Bootstrap workflow**: When new AYE is created, default behavior is to bootstrap from prior AYE (copy structure: grade sections, default staffing positions, default tuition rates as starting point). Opt-out option to start fresh.

**`planning → active` transition**: Triggered by AYE start date arriving. Likely automatic with manual confirmation.

**`active → closed` transition (manual, ceremonious)**:
- System Admin initiates close action
- Pop-up window with explicit explanation: "Closing AYE 2026 will make all module data read-only. Snapshots remain accessible. This action cannot be undone."
- TWO approvals required: System Admin AND one of (Treasurer | Board Chair). Both names + timestamps recorded.
- Grace period (Libertas default): soft reminders July 1+, escalating banners, obnoxious warnings August 1+
- Audit trail: close action logged with both approvers
- At close: Board Composition and Committee Membership snapshotted as part of permanent record

**Current AYE definitions** (two distinct concepts):
- **"Current AYE" (calendar-based)**: Always the AYE the school is presently operating in. Displayed in header badge.
- **Module default views**: Each module defaults to most-useful AYE for its work (Planning modules → next AYE; Actuals modules → current AYE; Governance modules → all relevant AYEs).

### 9.3 School Settings Architecture

```
Admin
  ├─ Academic Years
  ├─ Users & Access
  └─ School Settings
       ├─ Organization
       │    ├─ School Information (name, address, contact, mission, vision)
       │    ├─ Fiscal Year Settings
       │    ├─ Org Acronyms Registry
       │    ├─ Board Composition (per AYE)
       │    └─ Committees
       │
       ├─ Brand
       │    Logo, fonts, colors, tagline, letterhead settings
       │
       ├─ Financial
       │    Chart of Accounts, KPIs & Targets, Custom KPI Registry,
       │    Default target ranges, Variance flagging thresholds
       │
       └─ Module Configuration
            Module-to-Account Mappings, Tuition Schedule template settings,
            Sibling discount model selection, other per-module configuration
```

**Settings governance levels**:
- **Routine settings** (school name, brand colors): change anytime, logged in change_log
- **Consequential settings** (Module Mappings, Chart of Accounts flags, KPI definitions): change anytime with confirmation prompts and detailed audit trail
- **Locked-during-active-AYE settings** (sibling discount model, fiscal year boundaries): only changeable when no AYE is in active editing state

### 9.4 Board & Committees

Lives in **School Settings → Organization** for editing. Read-only view in **Governance → Board & Committees** sidebar item for visibility during governance work.

**Schema**:

```
board_compositions
  id, aye_id (FK), effective_date, notes
  audit fields

board_members
  id, board_composition_id (FK)
  user_id uuid (FK to auth.users; nullable — board members may not have Agora accounts)
  full_name text (required)
  email, phone
  term_start_date, term_end_date
  is_active_member boolean
  officer_role enum ('chair', 'vice_chair', 'secretary', 'treasurer', 
                     'chief_governance_officer', 'member_at_large', ...extensible)
  is_chief_governance_officer boolean (CGO can combine with another officer role)
  joined_board_date date (original board joining, possibly years ago)
  notes
  audit fields

committees
  id, name, type enum ('board', 'operational', 'advisory', 'ad_hoc', ...extensible)
  description, charter
  is_standing boolean, is_active boolean
  audit fields

committee_memberships
  id, committee_id (FK), aye_id (FK)
  user_id uuid (FK; nullable — committee members may include non-Agora users)
  full_name text (required if no user_id)
  email
  role enum ('chair', 'vice_chair', 'member', 'staff_liaison', 'consultant')
  joined_date, left_date
  is_active_member boolean
  notes
  audit fields
```

**Design choices**:
- Board members aren't required to be Agora users (some never log in)
- CGO modeled as flag, not officer role (allows joint with Chair/Treasurer/etc.)
- Officer roles and committee types extensible per school
- Committees persist across years; memberships are per-AYE
- Operational/advisory committees can include non-board members (staff, parents, external advisors)
- Composition lock semantics: live editing with audit trail during active AYE; snapshotted at AYE close

**Cross-module references**:
- Strategic Plan adoption — `adopted_via` could reference Board members
- Lock approvals — approver field can reference specific board officer (Treasurer typically)
- Operational Plan OPRs — can reference committees (e.g., "AT" = Advancement Team)
- HoS Report (future) — committee status sections
- Accreditation evidence (future) — board structure and committee charters

### 9.5 Documents libraries (per domain)

Future. "Documents" sub-items under Governance, Operations, Development sections. Per-domain document storage, organized, with permissions. Schema and UI deferred to future design.

### 9.6 Dashboard

First sidebar item. Landing page that orients to current state.

**Initial design**:
- Welcome by name
- Current AYE summary (active vs. planning)
- Pending actions for current user (locks awaiting approval, status updates due, etc.)
- Recent activity feed (across modules user has access to)
- Quick links to most-used modules
- High-level KPIs (Strategic Dashboard summary, condensed)

Refined when more modules exist.

### 9.7 Annual Rhythm Configuration

Per-school configuration for the cadence of the school year. Today this section is small — just lock cascade rules — but it's the natural home for forward-looking configuration as more rhythm-aware features land (lock-policy windows, fiscal calendar overrides, target-month nudges, etc.).

**Schema today** (Migrations 008 + 010):

- `school_lock_cascade_rules` — per-school list of "to lock module X, module Y must be in state S" rules. Text-keyed by module code so rules can forward-reference modules that haven't shipped yet; validated at INSERT/UPDATE time once both modules exist. Covered in detail in Section 3.4.
- `module_workflows` and `module_workflow_stages` — per-module workflow configuration backing the stage system. Covered in Section 3.8.
- `stage_type_definitions` — Praesidium-curated catalog of stage types. Read-only from the app.

**Settings UI**: queued for Phase R2. Until then, workflows are seeded per-school via migration; cascade rules are seeded per-school via migration. Editing requires system admin access via SQL.

**Cascade rules are per-module, not per-stage** — see Section 3.4's "Granularity" note. When per-stage rules become a real need, the schema extends with a nullable `stage_type` column on cascade rules and the validator joins on it.

---

## 10. Design Standards (Codified)

These standards live in `CLAUDE.md` (for Claude Code enforcement) and in this document (for design review reference).

### 10.1 Typography & Readability

- **Body text minimum**: 15px UI, 11pt PDF
- **Hierarchy**:
  - Page titles ≥ 28px / 22pt
  - Section headers ≥ 20px / 16pt
  - Subsection headers ≥ 16px / 13pt
  - Body 15px / 11pt
  - Footnotes / captions 12px / 9pt minimum
- **Line height**: 1.5x body, 1.2x headers
- **Line length**: body wrapped at ~75 characters where possible
- **Font weight**: Cinzel always regular (400), never bold. Body fonts can use weight for emphasis.

### 10.2 Color & Contrast

- **WCAG AA minimum** for body text on backgrounds (4.5:1 contrast ratio)
- **WCAG AAA preferred** for primary content (7:1 ratio)
- **Body text color** on cream `#FAF8F2`: `#2C2C2A` (passes AAA)
- **Muted text on cream uses navy at ~80% opacity, encoded as the solid token `muted` `#475472`** (computed contrast ratio **6.7:1**, passes AA with margin). Use `text-muted` for all de-emphasized text on cream/white surfaces — page subtitles, helper text, `FieldLabel`, `SectionLabel`, table headers, breadcrumb crumbs. There is **no `text-faint` token** as of v1.4 — anything that needs to be visible to users must clear AA.
- **No body text on gold accent.** Gold is for accents, dividers, badges only.
- **Dark surfaces** (navy header/sidebar): white text at 90%+ opacity for primary, never below 70%. Sidebar disabled-state items (modules not yet built) at `text-white/30` are an explicit exception — they communicate "not yet available" through their faintness.
- **Status colors** verified WCAG AA on cream as of v1.4. `status-amber` darkened from `#BA7517` (3.5:1, failed) to `#8C5410` (5.6:1). Status badge variants use their own darker text shades (e.g., `#633806` for amber on `#FAEEDA`) — see `Badge.jsx` for the mapping.
- **Cream-on-cream surfaces** are fine for visual grouping (intentional design choice). The issue is text contrast, not surface contrast.

### 10.3 Spacing

- Card padding: 24px minimum
- Between sections: 32-48px
- Between cards: 16-24px
- Form field height: 40px minimum

### 10.4 PDF-Specific Standards

- Margins: 0.75" minimum, 1" preferred. Top margin is bumped to ~0.95" in budget PDFs to leave headroom for the running text header.
- Logo: rendered at intended dimensions, never stretched, aspect ratio maintained
- Page breaks: avoid orphaning headers, keep table headers with first row of data
- Footer: school name + page number + generation date
- Header: section name on every page after first
- Locked-snapshot indicator: discreet "Approved [date] by [name]" + Snapshot ID
- DRAFT marking: prominent on all non-final outputs (Section 2.5)

#### Hierarchical visual treatment in budget PDFs

Four-tier hierarchy. The eye should distinguish levels without effort.

- **Tier 1 — top-level categories** (INCOME / EXPENSES). Cinzel 16pt navy, slight tracking, gold underline (1pt @ 60% opacity). Vertical breathing room above and below. Allowed to break across pages — a category often spans multiple.
- **Tier 2 — major summaries within a category** (Educational Program Revenue, Personnel, Facilities, etc.). EB Garamond 13pt bold navy, thin navy underline (0.5pt @ 30% opacity), `~95%` row width. **`break-inside: avoid`** so a Tier 2 block stays together when it fits on one page.
- **Tier 3 — mid-level summaries** (Revenue – Tuition, Tuition Discounts, Payroll, etc.). EB Garamond 12pt bold navy, no rule, `~85%` row width. **`break-after: avoid`** on the header so it stays with its first child.
- **Tier 4 — leaf posting accounts**. EB Garamond 11pt navy at ~85% opacity (slightly muted but still passing WCAG AA on white, ~9:1 ratio), regular weight. Account code in a 50px left column at navy @ 60%; account name middle column; amount right-aligned. **`~75%` row max-width** so the right edge sits about a quarter-page from the page edge — the eye associates name with amount as a connected unit instead of scanning across whitespace.

**Indentation** increases by 24px per tier (0 / 24 / 48 / 72). Indentation is the structural backbone; weight, size, and rules reinforce it.

**Vertical rhythm** (above / below each tier — tightened from the v3.0 values to convey financial-document weight rather than draft-worksheet airiness):

| Tier | Above | Below |
|---|---|---|
| Tier 1 (categories) | 18pt | 8pt |
| Tier 2 (top summaries) | 12pt | 4pt |
| Tier 3 (mid summaries) | 6pt | 2pt |
| Tier 4 (leaves) | 1pt | 1pt |

Adjacent companion elements use the same compressed rhythm: KPI summary cells at 6pt vertical / 12pt horizontal padding; state-indicator banner at 6pt top / 4pt bottom; title-block subtitle and generation timestamp at 4pt above each. Page margins stay at the §10.4 minimum (0.75" sides and bottom; 0.95" top to leave headroom for the running text header) — tightening applies to the document's interior rhythm, not its margins.

**The four-tier hierarchical treatment also applies to in-app Budget detail rendering** (added v3.6). The relationships codified above (size, weight, indentation, color treatment) carry over from PDF to screen; absolute values are screen-appropriate rather than literal point translations from the PDF spec (16pt PDF text reads very differently than 16px screen text). Implementation in `BudgetDetailZone.jsx`: Tier 1 categories at Cinzel 17px with a gold border-bottom (the screen analog of the PDF's gold underline); Tier 2 top-level summaries at EB Garamond 15px semibold with a navy@25 border-bottom (analog of the PDF's thin navy rule); Tier 3 mid-level summaries at 13.5px medium weight, no rule; Tier 4 leaves at 13px navy@85 with the account code in 11px navy@55. Editable input fields on Tier 4 leaves coexist with the strengthened hierarchy without competing — input chrome reads as the "you can change this" affordance, while the strengthened typography reads first as the structural backbone. Locked state preserves the hierarchy intact (no input chrome to lean on means the typography has to do all the work — and it does). Applies to all state combinations (drafting / pending_lock_review / locked) and all stages (Preliminary / Final / future stages).

**Audit log PDFs render at reference-document density** (added v3.6). Operating Budget Detail is a presentation document — board chairs put it in binders; the four-tier hierarchy and generous margins serve that. Audit log PDFs (per-line history, activity feed) are reference artifacts — closer in feel to an SEC filing exhibit. They render at smaller body text (8.5–9.5pt instead of 11pt), tighter line-height (`leading-snug`), and tighter row padding. Justification and reason text remain at full content (no truncation, §9.1 commitment). The two document classes share the same `PrintShell` letterhead, footer, page-break behavior, and DRAFT treatment; only the body density differs.

**Page-break behavior** (orphan prevention added in v3.1):

- **Tier 1 + first Tier 2 block** are wrapped together in a `.print-tier-1-with-first-tier-2` container with `break-inside: avoid`. This prevents the failure mode where a Tier 1 header (e.g., "EXPENSES") strands alone at the bottom of a page with no children visible. If the Tier 1 + first Tier 2 group doesn't fit on the current page, the whole group moves to the next page — leading whitespace at the bottom of the previous page is far better than an orphan.
- **Subsequent Tier 2 siblings** within the same category render outside the wrapper and break naturally; each individually carries `break-inside: avoid` so they don't internally split mid-block (the browser only breaks within a Tier 2 if the block itself exceeds a single page — acceptable, since the orphan-prevention guarantee covers Tier 1).
- **Tier 3 headers** carry `break-after: avoid` to stay with their first child.
- **Tier 4 leaves** break freely — pure leaf-row breaks read fine.

**Logo aspect ratio** is preserved by setting `width` explicitly (220px) and leaving `height: auto`; the print stylesheet additionally pins `height: auto !important` and `object-fit: contain` on `.print-logo` to defend against any parent flex container that might otherwise stretch the image to fill its row height.

#### Logo treatment in printed governance documents

- **First page**: full horizontal color logo (`/public/logo-horizontal-color.png`) at ~200–240px wide, top-left, aspect ratio preserved, top-aligned with the document title block.
- **Subsequent pages**: a thin running text header repeats per page with the document title (Cinzel) and, for DRAFT outputs, a small italic "DRAFT — [state]" suffix in red. The full horizontal logo would be too heavy to repeat on every page; the text header is enough to identify pages 2+ in a binder.
- **The crest** (`/public/logo-mark.png`) remains the in-app screen chrome / favicon / tight-space asset. Printed governance documents earn the full brand mark on the first page.

Same first-page-prominent / subsequent-page-restrained pattern across all three Budget PDF surfaces (Operating Budget Detail, per-line history, activity feed).

### 10.5 Image Handling

- Images at intended pixel dimensions, never upscaled
- Source images 2x rendered size for retina/print quality
- Logos in vector (SVG) where possible
- No cropping to wrong aspect ratios; use proper sizing rules

### 10.6 Accessibility

- All UI keyboard-navigable
- Focus states visible (don't hide focus rings)
- Form labels always associated with inputs
- Color never the only indicator (red/green also has label or icon)
- Tables with proper header structure (`<th scope="col">`)

### 10.7 Brand Specifics (Libertas — example for per-school pattern)

- Cinzel font, regular weight, all titles
- EB Garamond or Georgia for body text
- Primary navy: `#192A4F`
- Primary gold: `#D7BF67`
- Cream surface: `#FAF8F2`
- Logo: full crest version, white-on-dark variant

Each school configures its own brand specifics in **Settings → Brand** during onboarding.

#### Brand surface separation

Agora / Praesidium identity surfaces in exactly one place: the **login page** (`/login`). The Praesidium-attribution logo (`/public/Agora logo wt png.png`) renders at the bottom of the sign-in screen against the navy background, with a small legal line beneath ("Agora is a product of Praesidium Foundation, Inc."). The login page is the moment of arriving at the platform itself, before entering the school's customized environment — the right and only place to surface the parent-organization identity.

Every authenticated experience past `/login` is school-branded:

- AppShell header, nav sidebar, KPI sidebar, page chrome — school's brand
- PDFs (Operating Budget Detail, audit history exports) — school's full horizontal logo, not Agora/Praesidium
- Favicon, browser tab title, locked-banner attribution — school's

This separation reflects the product's positioning: Praesidium is the platform; the school is the experience. A board chair reading a locked Budget PDF in a binder sees their own school's identity, not the platform vendor's. A parent loading the site at the login URL sees both — the platform behind the experience.

### 10.8 Software-neutral language

User-facing copy in Agora does not name third-party products by brand. Concepts that originated with specific software (e.g., "subaccount of" from QuickBooks vocabulary) are adopted as accounting-domain vocabulary, not promoted as product references. The principle is product neutrality: Agora is sold to schools using various accounting software (QuickBooks Online, Xero, Sage, Wave, Aplos, etc.), and naming any one in narrative copy implicitly endorses it and alienates the others.

**The line**:
- ✅ **Allowed** — Format detection results that name a format by its source as a factual identification (e.g., "QuickBooks Account List format detected"). The user has uploaded a specific file format and Agora is reporting what it found.
- ❌ **Not allowed** — Narrative copy that uses one product as the reference point for a concept (e.g., "money posts here in QuickBooks", "Upload a QuickBooks Account List export…"). Use brand-neutral phrasing: "transactions post directly to this account", "your accounting software", "your books".

Internal code (variable names like `parseQuickbooks`, comments, JSDoc) may freely reference QuickBooks because that's technical accuracy, not user-facing marketing. The boundary is the rendered string.

### 10.9 Modal-not-inline-expand for row actions

Actions on list rows that require a form (Add, Edit, "+ Subaccount", and similar) open a **modal**, not an inline-expanded panel.

**Rationale**: at scale (a 122-row Chart of Accounts, a 50-line Budget), inline expand pulls the user away from their scroll position. They click Edit on a row deep in the tree, the form expands at the top of the page, and the user has to scroll up to see it — then back down to verify the change landed. Modals anchor focus where the user is already looking and preserve scroll position automatically.

**Implementation pattern**:
- The form is a single React component (e.g., `AccountForm`). The modal frame is a small wrapper that owns submit/error state and the supabase write; the form is the same instance whether it renders standalone or inside the modal.
- Backdrop click, Escape key, and an X button in the modal header all close without saving.
- After save, the modal closes, the parent reloads, and a toast confirms the change. Scroll position is preserved (the parent doesn't unmount).
- Context-implied fields (e.g., parent set by which row "+ Subaccount" was clicked on) render as a read-only context line, not an editable dropdown — clicking "+ Subaccount" on row 4100 means "subaccount of 4100"; if the user wanted a different parent they'd cancel and use "+ Add Account" from the top.

This is the canonical pattern for COA management's Add / Edit / "+ Subaccount" and Budget's "+ Add Account". Future row-action surfaces should follow.

### 10.10 Long-list controls and feedback

For any view containing a long scrollable list (the COA tree at 122 rows, Budget detail with hundreds of lines, the guided flag-review grid), the controls that operate on the list and the feedback from operations on the list must remain visible regardless of scroll position. Two complementary patterns:

**Sticky section header.** The section's controls (section banner, view tabs, action buttons, expand/collapse affordances, and — in flat/table views — the column headers) use `position: sticky; top: 0` relative to the page's scroll container. As the user scrolls into the list, the controls strip stays pinned at the top of the working area. Cream background and a thin bottom border give clean visual separation from rows scrolling underneath. Page chrome above (breadcrumb, page title) is allowed to scroll out of view — once the user is working in the list, they don't need it.

**Fixed-position toasts.** Status messages (success / error / informational) render in a fixed position relative to the viewport (top-right, offset 80px from the top to clear the global header), not within the page content. Implemented as a `<ToastProvider>` wrapping the app at the root with a `useToast()` hook (`toast.success(message)`, `toast.error(message)`). Success toasts auto-dismiss after 4 seconds; errors stay until the user clicks ×. Multiple toasts stack vertically. The pattern lives in `src/lib/Toast.jsx`.

**What stays inline**: form-field validation feedback (e.g., "Name is required" below an input), modal-internal errors mid-action (the user is focused on the modal anyway), and deeply-embedded panel errors where the panel itself is the focal element (CsvImportModal, ImportExportPanel). Toasts are for *outcomes* of actions, not field-specific or focal-panel feedback.

**Failure mode this prevents**: a user scrolls deep into a 122-row tree, clicks Delete on row 100, and the success message renders at the top of the section — invisible. The user wonders if the action did anything. Sticky controls + viewport toasts together close that loop: the action is reachable from any scroll depth, and the feedback is visible from any scroll depth.

### 10.11 Formal tone in user-facing strings

User-facing strings authored by the system use full forms, not contractions: "is not" rather than "isn't", "cannot" rather than "can't", "do not" rather than "don't", "you are" rather than "you're", and so on. Captured user input — justification text, audit-log reason values typed by users, scenario labels — is exempt: that is the user's voice, not ours, and contractions in the user's own writing belong to the user. Code comments, identifiers, internal variable names, and console-error strings are exempt — not user-visible.

The convention parallels §10.8's software-neutral language rule: both are about how the platform speaks to users in its own voice. Formal tone makes the platform read as a governance tool rather than a casual app — "You do not have view access to the Budget module" is the right register for a school administrator's product, where "You don't have access" reads as more SaaS-marketing than financial-stewardship. The rule applies to JSX text content, JSX attribute strings the user sees (placeholders, titles, aria-labels, button labels), and exported string constants used in UI surfaces. Edge case: phrases that read awkwardly when expanded ("Let's get started" → "Let us get started") should be rephrased rather than mechanically expanded; a natural reformulation ("Begin setup") is preferred.

### 10.12 Accounting parentheses convention for subtractive currency values

(v3.8.4) Subtractive currency values — discounts, losses, negative revenue — render with parentheses rather than negative signs throughout the application. The pattern is universal: `($53,655)` for a discount, never `-$53,655`. Editable input fields in display state show the parenthesized form; on focus, the input reverts to a plain numeric editable string for direct entry, then returns to parens display on blur. This matches the existing direct-edit-with-undo pattern from B1; only the display formatting changes.

The number formatter `formatCurrency(value, options)` in `src/lib/format.js` accepts a `subtractive` boolean option (default false). When `subtractive: true`, the formatter always renders with parens regardless of the value's sign — used for known-subtractive contexts: discount values, the section's Total Projected Discounts subtotal, and the sidebar's Total Projected Discounts stat. When `subtractive` is omitted or false, parens render only when the value is negative — used for non-subtractive currency that may legitimately go negative (e.g., Net Projected Ed Program Revenue if expenses exceed revenue).

The `-` character is never rendered for currency values; parens replace it universally. Null and non-finite values render the em-dash sentinel "—" so callers do not need to guard before calling.

This is standard accounting convention and matches the visual language of the Tuition Committee's existing spreadsheets — which treat the AYE26 discount block (lines 34–38) with parenthesized magnitudes per the same rule. Aligning Agora's display with the spreadsheet's display reduces the cognitive friction of moving between the two surfaces during the budget cycle.

The convention is conservative — apply `subtractive: true` only where the contextual meaning is "this number reduces something else" (discounts, fees deducted, contra-revenue). Do not retrofit the entire codebase. Currency rendering elsewhere (Budget detail, scenario tabs, snapshot PDFs) keeps its existing formatter behavior; the negative-value-triggers-parens path is the only universal change.

---

## 11. Future Modules (Acknowledged but Not Yet Designed)

These modules are part of the architecture but full design is deferred. Schema placeholders exist where other modules reference them.

### 11.1 Accreditation

Major future module. Will model:
- Standards (per accrediting body — SCL, ACSI, ACCS, others)
- Indicators within each standard
- Evidence requirements per indicator
- Status tracking (not started, in progress, complete, needs improvement)
- Punch lists / action items
- Site visit preparation
- Recommendations from accreditation reports
- Document evidence storage

**Build sequence**: appropriate after Strategic Plan; doesn't block other operational modules. Requires checking with accrediting body (SCL specifically) about modeling their standards in software.

**Reference**: Operational Plan's `linked_accreditation_recommendation_id` will point here.

### 11.2 Board Policies

The Board Policy Manual as a structured module rather than a static PDF. Allows:
- Policy text per section/subsection
- Policy versioning and adoption history
- Cross-references to Strategic Plan, Monitoring Calendar
- Compliance tracking

**Reference**: Strategic Plan's "Maps To" text references will become FK to `board_policies` when this module exists.

### 11.3 Board Calendar / Monitoring Calendar

Schedule of board meetings, board reports due, recurring governance events. Monitoring Calendar tracks when Board Policies require evidence. Both pull from existing module data (Operational Plan due dates, Budget lock dates, etc.) to populate.

### 11.4 Meetings

Meeting minutes, attendance, agenda items, action items. References Board Composition for attendee tracking.

### 11.5 HoS Report

Pulls from Operational Plan status updates as primary data source. Monthly board report. Includes: strategic plan status, financial summary, enrollment updates, operational notes. Holly's monthly report becomes 80% auto-generated from existing data + her narrative additions.

### 11.6 Operations Policies / Operations Documents

Operational policy library separate from Board Policies (which are governance). Examples: HR procedures, communication protocols, safety procedures, SOP documents.

### 11.7 Fundraising

Major future module. Donor management, campaign tracking, gift recording, fundraising KPIs. Currently buried inside Budget Contributions category; deserves its own home. References Budget for fundraising line items, Strategic Plan for fundraising targets.

### 11.8 Capital Plan

Capital expenditures, deferred maintenance reserves, multi-year facility plans. Distinct from operating budget. Lives under Development.

### 11.9 Cash Flow (operating tool layer)

Monthly QB CSV upload (or eventual API integration) populates `monthly_actuals` table. Variance reports join actuals to locked Budget snapshot. Mid-year re-forecasting capability.

---

## 12. Build Sequence Guidance

A separate Build Sequence document will detail this. Summary here:

### Phase 1: Foundation
- Chart of Accounts (full schema, settings UI, QB import, guided flagging)
- School Settings scaffold (Organization, Brand, Financial, Module Configuration sub-pages)
- AYE Management (auto-creation, bootstrap, manual close ceremony)
- Users & Access UI (permission-level + detail-visibility flags)

### Phase 2: Budget Shell
- ✅ Stage-aware Budget UI (configurable workflow per Section 3.8) with manual entry, hierarchical display
- ✅ KPI sidebar (real-time computation)
- ✅ Snapshot capture on lock — `stage_id` + stage labels captured by value (Section 5.1)
- ✅ Operating Budget Detail PDF generation (Commit F — DRAFT and LOCKED variants; Section 8.11)
- ✅ Lock workflow (submit → approve → locked) via `lock_budget_stage_scenario` (Migration 012); same workflow for every stage of every school's configuration
- ✅ Audit log per-record history view + per-scenario activity feed (Commit F; Section 9.1)
- Unlock workflow + approval-tier permissions (queued: Session H)
- Comparison PDF / multi-scenario comparison view (queued: Session J)

### Phase R2: Workflow Configuration UI (queued)
- Settings sub-page for editing `module_workflows` and `module_workflow_stages` (system admin only initially; later gated on a dedicated `workflow_config` permission)
- Constraints enforced at save time: at least one terminal stage; stage labels unique per workflow; sort orders unique per workflow
- Stage deletion guarded against existing locked snapshots (snapshot tables FK → `module_workflow_stages` is RESTRICT today; the editor surfaces "this stage has N locked snapshots — rename instead of delete")

### Phase 3: Staffing Module
- Multi-scenario UI
- Position editing with all compensation types
- Module-to-Budget integration (Staffing totals → Budget Personnel category)
- Snapshot capture with redaction support

### Phase 4: Tuition Module (two-stage per §7.3)
- 4a (Tuition-A2 schema): Two-stage workflow setup (Tuition Planning + Tuition Audit) per §3.8; tier rate configuration; layered discount taxonomy (multi-student tiers / Faculty rule / Other envelope / Financial Aid envelope) per §7.3; per-family detail tables for Stage 2; snapshot tables parallel Budget per §5.1; Stage 2 immutability trigger
- 4b (Tuition-B UI): Stage 1 configuration screens (tiers, fees, discount envelopes, projected family distribution); year-over-year comparison view; Stage 2 per-family detail editor with discount allocation columns and notes column
- 4c (Tuition-C calculation): family-facing per-student rate computation; accounting-view revenue projection with gross-vs-net rollup; break-even enrollment KPI (Stage 1 forward solve)
- 4d (Tuition-D lock workflow): Stage 1 lock (cascade enables Preliminary Budget per §7.5); Stage 2 lock (cascade enables Final Budget per §7.5); reuses lock/unlock patterns from Phase 2 (§8.13 two-identity model); Stage 2 setup gateway seeds from locked Stage 1 snapshot via `create_tuition_audit_from_planning_snapshot` parallel to Migration 019
- 4e (Tuition-E PDF): family-facing Tuition Schedule per-school template, generated at Stage 1 lock; Stage 2 audit summary and family-detail print routes per §5.3

Stage 2 (audit) requires Stage 1 to be locked first (stage-initialization cascade per §3.4); per-family detail entry happens in Stage 2 only.

### Phase 5: Enrollment Estimator + Advancement
- Advancement actuals UI (monthly headcount, recruitment funnel)
- Enrollment Estimator with multi-scenario projections
- Section-level and grade-level views
- Pre-enrollment integration

### Phase 6: Strategic Plan Module
- Strategic ENDS Priorities
- Strategic Financial Plan with target ranges
- Operational Strategic Plan (three-level hierarchy, status tracking)
- Strategic KPI Dashboard view

### Phase 7: Final Budget
- Final Budget integrating locked Tuition Stage 2 actuals (per §7.5 cascade)
- Variance Report view (locked Final Budget vs locked Preliminary Budget)
- Note: family-level reality capture lives in Tuition Stage 2 (Phase 4d), not a separate Enrollment Audit module

### Phase 8: Governance Modules
- Board & Committees (settings + read-only view)
- HoS Report (pulling from Operational Plan)
- Board Calendar / Monitoring Calendar

### Phase 9+: Future Work
- Accreditation module
- Board Policies module
- Fundraising module
- Capital Plan
- Operating tool layer (Cash Flow / actuals integration)

Each phase delivers usable value while building toward the full vision. Specific sequencing may adjust based on Libertas's needs and Praesidium's priorities.

---

## Appendix A: Permission Reference

### Module-level permissions
- `view` — see snapshots, see aggregate totals
- `view_summary` — same as view (kept for clarity in some contexts)
- `edit` — make changes
- `submit_lock` — propose for approval
- `approve_lock` — approve/reject lock requests
- `admin` — full control including hard deletes

### Detail-visibility flags (orthogonal)
- `can_view_staff_compensation` — see individual staff salary lines
- `can_view_family_details` — see individual family rows
- `can_view_donor_details` — see individual donor amounts (future)

### Example permission profiles

**Office Manager** (Libertas current):
- Chart of Accounts: edit
- Tuition: edit + can_view_family_details (responsible for Stage 2 family detail capture)
- Staffing: view + can_view_staff_compensation
- Budget: view
- Strategic Plan: view

**Treasurer**:
- Budget: approve_lock + can_view_staff_compensation + can_view_family_details
- Staffing: approve_lock + can_view_staff_compensation
- Tuition: approve_lock + can_view_family_details (approves Stage 1 and Stage 2 lock)
- Strategic Plan: view

**HoS**:
- Edit on most modules + all detail-visibility flags
- Approve_lock varies by module

**Board members (default)**:
- View on Budget, Staffing, Tuition (no detail-visibility flags — see aggregate totals only, not per-family detail)
- Read-only on Strategic Plan and Board & Committees

**System Admin**:
- Admin on all modules, all detail-visibility flags

---

## Appendix B: Schema Migrations Already Implemented

- **Migration 001**: Initial schema (academic_years, modules, module_instances, user_module_permissions, change_log, preliminary_budget [legacy flat structure], final_budget, tuition_worksheet, tuition_scenarios, staffing_scenarios, staffing_scenario_positions, enrollment_monthly, etc.)
- **Migration 002**: `bootstrap_aye()` function
- **Migration 003**: Tuition target ratio fix (`tg_compute_tuition_scenario_totals` corrected from 1.20 → 1.02 typo in 001; existing rows recomputed)
- **Migration 004**: Chart of Accounts schema (self-referential hierarchy, type-inheritance + leaf-only flag triggers [latter superseded by 005], semantic flag CHECK, cycle-prevention trigger, `is_leaf_account()` helper, RLS, `chart_of_accounts` module + admin permission seed, change_log read policy extended). Amended after initial run to include the `grant select, insert, update, delete on chart_of_accounts to authenticated` line missing from the first cut.
- **Migration 005**: Chart of Accounts posting vs summary model — adds `posts_directly` column, drops the leaf-only flag trigger, replaces with posting-only flag trigger, adds `is_posting_account()` helper. Resolves the leaf-only flaw that prevented flagging parent accounts that post directly (e.g., "Revenue – Tuition" with a "Tuition Discounts" subtree).
- **Migration 006**: Default privileges for `authenticated` role on `public` schema — `ALTER DEFAULT PRIVILEGES` for tables, sequences, and functions created by `postgres` and `supabase_admin`, plus a catch-up grant on existing objects. Resolves the GRANT discipline class of bug (Migration 004 hit this; 005 worked around it with a per-table grant). Future migrations no longer need explicit per-table grants.
- **Migration 007**: Conditional hard delete on COA accounts — adds `chart_of_accounts_can_hard_delete(account_id)` function (returns `can_delete` + `blocking_reason`; today checks self-referential subaccount FK, body extends as Phase 2+ tables add FK references). Splits the COA write RLS policy from one `coa_write` (edit-gated) into three: `coa_insert` and `coa_update` (edit-gated; soft-delete still works at edit level), `coa_delete` (admin-gated). Hard-delete audit logging is automatic via the existing `coa_change_log` trigger.
- **Migration 008**: Annual Rhythm Settings — `school_lock_cascade_rules` table makes the lock-cascade semantic from Section 3.4 per-school configurable (text codes for `module_being_locked` / `required_module`, validated against `modules.code` by trigger; `required_state` text + CHECK; `is_required` distinguishes hard rule from warning-only). Read-gated to authenticated; write-gated to system admin. Audit-logged via `tg_log_changes()`. `change_log_read` policy extended with public-read arm for cascade rules.
- **Migration 009**: Initial Preliminary Budget refactor — created the first cut of `preliminary_budget_scenarios` / `preliminary_budget_lines` / `budget_snapshots` / `budget_snapshot_lines` tables, dropped the legacy flat budget tables from Migration 001, seeded Libertas's cascade rules. Superseded by Migration 011 once the workflow + stage framework landed; the original tables created here exist only briefly in repo history.
- **Migration 010**: Module workflows + stages framework. Adds `stage_type_definitions` (Praesidium-curated catalog: working / preliminary / adopted / reforecast / final), `module_workflows` (per-school active workflow per module — partial unique index enforces "one active per module"), and `module_workflow_stages` (school-named, type-tagged stages with sort_order and target_month). Helper `get_module_workflow_stages(module_code)` returns the active workflow's stages joined with the type catalog. RLS: anyone reads, system admin writes (Settings UI gating ships in Phase R2). Seeds Libertas's two-stage Budget workflow: Preliminary Budget (April) and Final Budget (October).
- **Migration 011**: Budget tables refactored to reference workflow stages. Drops the original 009 tables (no production data — only Phase 2 Session 1 test data was disposable). Renames the module's `code` from `preliminary_budget` to `budget` (FKs use IDs so user_module_permissions / school_lock_cascade_rules text references are updated by hand). Recreates `budget_stage_scenarios` (scope: AYE × Stage), `budget_stage_lines`, `budget_snapshots` (with `stage_id` + captured stage label / short_name / type), `budget_snapshot_lines`. Validation triggers: posting + non-pass-thru on lines, locked-scenario-blocks-line-writes. Snapshot immutability triggers carry forward. RLS gates point at `current_user_has_module_perm('budget', ...)`. `change_log_read` policy refreshed with arms for the new tables.
- **Migration 012**: Atomic stage-aware lock. `coa_hierarchy_path(account_id)` returns colon-delimited path captured by value into snapshots. `compute_budget_scenario_kpis(scenario_id)` returns the seven-KPI bundle matching the JS sidebar logic. `lock_budget_stage_scenario(scenario_id, locked_via, override_justification)` is the SECURITY DEFINER entry point that atomically: (1) validates approve_lock + scenario state + is_recommended, (2) reads stage metadata for capture, (3) computes KPIs, (4) inserts the snapshot header, (5) inserts every snapshot line with account state by value, (6) flips scenario state to `locked`. Single transaction — partial states impossible.
- **Migration 013**: Restored and extended `chart_of_accounts_can_hard_delete()`. The original Migration 007 function was lost during the architectural correction (010–012 dropped and recreated the budget tables) and was manually patched via SQL Editor with a `budget_stage_lines` reference check added. This migration brings the source of truth in line. Also adds `notify pgrst, 'reload schema';` at the end — the practice was promoted to a discipline (see "Migration practices" below) after the lost-function bug surfaced. Migrations 008–012 had the notify line added retroactively.
- **Migration 014**: COA phantom-row protection. Adds `tg_check_coa_phantom_creation` trigger on `chart_of_accounts` UPDATE that rejects toggling `posts_directly` to false (or `is_pass_thru` to true) while live `budget_stage_lines` rows reference the account — closes the gap that allowed phantom rows (a `budget_stage_lines` row pointing at a now-summary account) to accrue silently. Includes a one-time cleanup DELETE removing any existing phantoms across all scenarios. Snapshot tables (`budget_snapshot_lines`) are intentionally not counted by the trigger — they capture account state by value at lock time and are immune to subsequent COA changes by design.
- **Migration 015**: Lock-state guards across sibling scenarios. Two `BEFORE UPDATE` triggers on `budget_stage_scenarios` close two corruption paths that Migration 011's partial unique index didn't cover: `tg_prevent_recommend_while_sibling_locked` rejects `is_recommended → true` when any other scenario in the same `(aye_id, stage_id)` slot is `locked`; `tg_prevent_lock_submit_while_sibling_locked` rejects the `drafting → pending_lock_review` transition under the same condition. Both triggers fire only on the specific transition so no-op UPDATEs pass through. Includes a one-time historical-data repair DO block at the top of the migration that detects any locked scenario where `is_recommended = false` (the corruption the original bug actually produced), clears `is_recommended` on non-locked siblings in the slot, and restores `is_recommended = true` on the locked row; runs before triggers are installed and is idempotent on a clean DB. Section 8.7.1 documents the three-layer (DB trigger + application validator + UI affordance) enforcement.
- **Migration 016**: Unlock workflow schema. Adds eight columns to `budget_stage_scenarios` (`unlock_requested`, `unlock_request_justification`, `unlock_requested_at`, `unlock_requested_by`, `unlock_approval_1_at`, `unlock_approval_1_by`, `unlock_approval_2_at`, `unlock_approval_2_by`); four named CHECK constraints enforcing initiator separation and sequential ordering (`unlock_initiator_not_approver_1`, `unlock_initiator_not_approver_2`, `unlock_approvers_distinct`, `unlock_sequential_ordering`); a BEFORE-trigger `tg_unlock_only_when_locked` that rejects setting `unlock_requested = true` while `state <> 'locked'`; and a partial index on `(aye_id, stage_id) WHERE unlock_requested = true` for fast pending-request lookups. State machine deliberately uses flag fields layered on top of `state = 'locked'` rather than the `pending_unlock_review` value (which is reserved in the CHECK constraint but unused) — preserves Migration 015's sibling-lock guards without modification. Section 8.13 documents the workflow.
- **Migration 017**: `approve_unlock` permission. Extends the hierarchical `permission_level` enum with `'approve_unlock'`, inserted between `'approve_lock'` and `'admin'`. Subsumption semantics consistent with the rest of the system: `approve_lock` users do NOT auto-get `approve_unlock` (the `>=` check returns false against the higher level); `admin` users do (admin subsumes everything). Grants `approve_unlock` on the Budget module to the live user (jennsalazar@hotmail.com) via an idempotent `INSERT ... ON CONFLICT DO UPDATE WHERE permission_level < 'approve_unlock'` upsert — never demotes an admin-or-higher to the new level. Must be applied in two stages in the SQL Editor (the `ALTER TYPE ADD VALUE` and any reference to the new value cannot share a transaction); migration file is structured as PART A / PART B with explicit instructions.
- **Migration 018**: Unlock workflow functions. Three SECURITY DEFINER functions: `request_budget_stage_unlock(scenario_id, justification)` (requires `submit_lock`; non-empty justification), `approve_budget_stage_unlock(scenario_id)` (requires `approve_unlock`; returns `'first_approval_recorded'` or `'unlock_completed'` and on the second call atomically transitions state to `'drafting'` and clears all `unlock_*` fields via two UPDATE statements that preserve audit of the second approver), and `reject_budget_stage_unlock(scenario_id, reason)` (authorizes either `approve_unlock` holders or the original requester for self-withdraw; non-empty reason). All three set `app.change_reason` with a recognizable signature (`unlock_requested`, `unlock_first_approval`, `unlock_completed`, `unlock_rejected: <reason>`, `unlock_withdrawn: <reason>`) so the existing `tg_log_changes` trigger captures the workflow event in `change_log.reason` for permanent audit.
- **Migration 019**: `create_scenario_from_snapshot(p_target_stage_id, p_source_snapshot_id, p_scenario_name)`. SECURITY DEFINER function used by the non-first-stage setup gateway (§8.14). Validates: caller has `edit` on Budget; source snapshot's stage is a predecessor of target stage in the same workflow (lower `sort_order`, same `workflow_id`, same AYE); scenario name non-empty. Inserts a new drafting scenario in the target stage and copies snapshot lines into `budget_stage_lines` (skipping any with `account_id IS NULL` from prior hard-deletes). Tags `app.change_reason` as `'created_from_snapshot: <snapshot_id>'` so the audit trail of the new scenario links permanently back to the predecessor it came from. Replaces the conceptually-wrong "three-option flow" for non-first stages.
- **Migration 020**: Refactor unlock workflow to two-identity model (v3.7). Drops the CHECK constraint `unlock_initiator_not_approver_1` from `budget_stage_scenarios` so that the requester's identity can also satisfy approval_1. Other constraints (`unlock_initiator_not_approver_2`, `unlock_approvers_distinct`, `unlock_sequential_ordering`) and the `tg_unlock_only_when_locked` trigger remain unchanged. Schema-only migration; no data affected.
- **Migration 021**: Replaces the three SECURITY DEFINER unlock functions to reflect the two-identity model. `request_budget_stage_unlock` now requires `approve_unlock` (was `submit_lock`) and atomically populates BOTH the request fields AND the approval_1 fields from the caller's identity in a single transaction. `approve_budget_stage_unlock` returns void instead of text — no more `'first_approval_recorded'` / `'unlock_completed'` branching since approval_1 is always already populated by request time; the function only ever handles approval_2 + the state transition. `reject_budget_stage_unlock` logic unchanged. The function-layer initiator-separation check now reads "the unlock requester cannot also record the second approval."
- **Migration 022**: Tuition Worksheet schema (Tuition-A2, v3.8.1). Drops the legacy single-stage `tuition_worksheet` and `tuition_scenarios` tables from Migration 001 (CASCADE; pre-flight count check confirmed empty). Renames `modules.code` from `'tuition_worksheet'` to `'tuition'` (parallel to Migration 011's `preliminary_budget` → `budget` rename; user_module_permissions rows survive via module_id FK). Configures Tuition module workflow with two stages: `Tuition Planning` (stage_type `preliminary`, target month January) and `Tuition Audit` (stage_type `final`, target month September). Creates `tuition_worksheet_scenarios` table (parallel to `budget_stage_scenarios`: standard scenario / lock / unlock columns plus the layered-discount-taxonomy configuration columns — tier rates, discount envelopes, fee rates — per §7.3) and `tuition_worksheet_family_details` table (Stage 2 only; per-family rows with discount allocations and notes). Three layers of integrity: CHECK constraints (mirroring budget unlock), partial unique index for one-locked-recommended per (aye_id, stage_id), and triggers — the generic `tg_unlock_only_when_locked` from 016 is reused; `tg_enforce_tuition_stage_2_immutability` is the DB hard guard for §7.3's Stage 2 immutability rule (tier rates and per-student fees set in Stage 1 cannot be edited in Stage 2 because families have signed agreements at those rates); `tg_check_tuition_family_details_stage` blocks family detail rows on Stage 1 scenarios. Sibling-lock guards parallel to Migration 015 (dedicated tuition copies because the 015 functions reference `budget_stage_scenarios` by name in their SELECTs). RLS on view/edit; family details additionally gated by the `can_view_family_details` detail-visibility flag. `change_log_read` policy rebuilt with new tuition arms, dropping the legacy `tuition_worksheet` / `tuition_scenarios` arms.
- **Migration 023**: Tuition Worksheet snapshot schema (Tuition-A2, v3.8.1). Snapshot tables parallel to Budget's pattern from Migration 011 + the §5.1 captured-by-value binding rule established in v2.7. `tuition_worksheet_snapshots` carries scenario configuration (tier rates, fees, envelopes), stage metadata (display name, short name, type captured at lock), AYE label, locker / approver names, and nine KPI columns (gross tuition revenue, multi-student discount, faculty discount total, other discount total, financial aid total, curriculum fee revenue, enrollment fee revenue, B&A school revenue, net education program revenue) — all by value at lock time. `tuition_worksheet_snapshot_family_details` captures Stage 2 per-family rows with discount allocations and notes; ON DELETE CASCADE from snapshot. Both tables blocked from UPDATE via `tg_prevent_snapshot_update` (reused from 011). RLS gates read on view permission; INSERT requires submit_lock (gated for the lock RPC's snapshot capture). Family-detail snapshot tables additionally gated by `can_view_family_details`.
- **Migration 024**: Tuition Worksheet lock workflow RPCs (Tuition-A2, v3.8.1). `compute_tuition_scenario_kpis(scenario_id)` is a stable function returning the nine KPIs from the scenario's configuration plus (Stage 2 only) the family detail rows; deterministic, no random state. `submit_tuition_scenario_for_lock_review(scenario_id)` validates submit_lock + drafting state + is_recommended + no sibling locked, transitions to `pending_lock_review`, sets `app.change_reason = 'submitted_for_lock_review'`. `lock_tuition_scenario(scenario_id, locked_via, override_justification)` validates approve_lock + pending_lock_review state + is_recommended + valid `locked_via` ('cascade' or 'override') + override has justification. Captures stage metadata, AYE label, locker name; computes KPIs; inserts the snapshot header; for Stage 2 scenarios copies family detail rows into the snapshot family detail table; flips state to `locked`. Returns the new snapshot id. `reject_tuition_scenario_lock(scenario_id, reason)` validates approve_lock + pending state + non-empty reason; transitions back to `drafting` with `app.change_reason = 'lock_review_rejected: <reason>'`. Tuition's RPC surface is broader than Budget's (which handles submit and reject via direct client UPDATEs from `src/lib/budgetLock.js`) — server-side authorization on every state transition is appropriate given Tuition lock triggers downstream contractual commitments to families. Cross-module cascade per §7.5 is NOT enforced inside the Tuition lock function; cascade integration with Budget is a follow-up commit per the build sequence.
- **Migration 025**: Tuition Worksheet unlock workflow RPCs (Tuition-A2, v3.8.1). Three SECURITY DEFINER functions implementing the v3.7 two-identity unlock model on Tuition, parallel to Budget's Migration 021. `request_tuition_scenario_unlock(scenario_id, justification)` requires approve_unlock; atomically populates BOTH request fields AND approval_1 fields from the caller's identity. `approve_tuition_scenario_unlock(scenario_id)` returns void; validates approve_unlock + locked state + unlock requested + caller is not the requester + approval_2 not yet populated. Two UPDATEs in one transaction: Step 1 captures approval_2 identity (so change_log records who approved second), Step 2 flips state to `drafting` and clears all unlock_* fields. `reject_tuition_scenario_unlock(scenario_id, reason)` handles both reject and withdraw paths via the caller-vs-requester branch detection; sets `app.change_reason` with appropriate signature ('unlock_rejected: ...' or 'unlock_withdrawn: ...'); state stays locked, all unlock fields clear.
- **Migration 026**: `create_tuition_scenario_from_snapshot(target_stage_id, source_snapshot_id, scenario_label)` (Tuition-A2, v3.8.1). Parallel to Migration 019's Budget version. Used when Stage 2 (Tuition Audit) setup begins and the user picks a locked Stage 1 (Tuition Planning) scenario as the seed. Validates: caller has edit on Tuition; target stage exists and is Stage 2 (`stage_type = 'final'`); source snapshot exists and is from a Stage 1 lock (`stage_type_at_lock = 'preliminary'`); same workflow; same AYE; predecessor relationship (source sort_order < target sort_order); scenario label non-empty. Copies ALL configuration fields (tier_count, tier_rates, faculty_discount_pct, fee rates, discount envelopes, estimated_family_distribution) from the source snapshot into the new Stage 2 scenario. The Stage 2 immutability trigger from Migration 022 fires on UPDATE not INSERT, so the locked-from-edit fields populate freely at INSERT time. No per-family detail rows seeded — family detail is the operational substance of the audit; users enter one row per enrolled family at audit time. Tags `app.change_reason = 'created_from_snapshot: <id>'` for permanent audit linkage.
- **Migration 027**: Tuition B1.1 schema refinements (v3.8.2). Real-data design discovery during the B1 in-browser walkthrough surfaced six refinements that touch schema. (1) Adds four new columns to `tuition_worksheet_scenarios`: `total_students int`, `top_tier_avg_students_per_family numeric(4,2)`, `projected_faculty_discount_amount numeric(12,2) NOT NULL DEFAULT 0`, `total_families int`. (2) Reshapes `estimated_family_distribution jsonb` from `[{tier_size, family_count}]` to `[{tier_size, breakdown_pct, family_count}]`; `family_count` is now application-derived from `total_families × breakdown_pct / 100` and written to the jsonb on save so downstream reads (snapshots, KPIs) work without recomputation. (3) Renames on scenarios: `other_discount_envelope` → `projected_other_discount`, `financial_aid_envelope` → `projected_financial_aid`. (4) Mirrors all four new columns and both renames on `tuition_worksheet_snapshots` (no production rows; mechanical change). (5) Backfills existing B1-walkthrough scenarios: copies `family_count` forward, computes `breakdown_pct` from `family_count` ratios, sets `total_families = Σ family_count` and `total_students = Σ (tier_size × family_count)` (top tier_size treated as literal — one-time migration drift acceptable since no production data); rows with all-zero counts (the empty-state seed) leave `total_students` and `total_families` NULL so the UI's "fresh scenario" semantics carry through. (6) Installs trigger function `tg_validate_tuition_scenario` (BEFORE INSERT OR UPDATE) with two validators: breakdown_pct values sum to 100 ± 0.01 when `total_students IS NOT NULL` AND breakdown sum > 0 (relaxed from "when total_students is set" so on-blur saves do not fight users mid-data-entry — the UI buffers breakdown edits locally until sum is valid); `top_tier_avg_students_per_family >= max tier_size in tier_rates` when not null. (7) Updates three SECURITY DEFINER functions via CREATE OR REPLACE (return shapes unchanged): `compute_tuition_scenario_kpis` Stage 1 branch reads `total_students` from column directly (no longer walks family_count × tier_size); faculty-discount Stage 1 projection reads `projected_faculty_discount_amount` directly (no longer pct × gross); both branches reference renamed columns. `lock_tuition_scenario` snapshot INSERT writes new column names + new fields. `create_tuition_scenario_from_snapshot` reads renamed snapshot columns + new fields, writes them into the new scenario. (8) `faculty_discount_pct` column persists in schema unchanged — it is needed for Stage 2 per-family allocation math (Tuition-D / B2 territory) and does not appear in the B1.1 Stage 1 UI. Notify pgrst at the end.
- **Migration 030**: Drop unused `school_id` parameter from `get_latest_locked_budget` RPC (Tuition-C.1, v3.8.8). Single-tenant alignment cleanup. Migration 029 (Tuition-C) introduced `get_latest_locked_budget_for_school(p_school_id uuid)` with the parameter preserved-but-unused for forward-compat with eventual multi-tenancy. Architecture §1 and CLAUDE.md both explicitly direct against multi-tenant scaffolding ahead of the coordinated migration; pre-emptive scaffolding was a misstep. Migration 030 drops the old function (`DROP FUNCTION` is required because PostgreSQL identifies functions by name + argument types and `CREATE OR REPLACE` cannot change the parameter list) and creates `get_latest_locked_budget()` with no parameters. Body unchanged otherwise: same TABLE return shape, same SELECT against `budget_snapshots` joined to `academic_years`, same ordering, same `kpi_total_expenses` read per §5.1 binding rule. SECURITY DEFINER and GRANT EXECUTE TO authenticated preserved. The single JS call site in `TuitionWorksheet.jsx`'s `fetchLatestLockedBudget` helper updated to call the renamed function with no arguments. When multi-tenancy lands, the RPC gets re-parameterized as part of that coordinated migration.
- **Migration 029**: Tuition-C — Stage 1 expense comparator (v3.8.7). Three new columns on `tuition_worksheet_scenarios`, mirrored on `tuition_worksheet_snapshots`: `expense_comparator_mode text NOT NULL DEFAULT 'locked_budget'` with CHECK constraint enforcing `('locked_budget' | 'manual')`; `expense_comparator_amount numeric(12,2)` (nullable; populated from `get_latest_locked_budget_for_school` when mode='locked_budget' or user-entered when mode='manual'); `expense_comparator_source_label text` (nullable; "AYE 2025 Final Budget" or "Manual estimate" or null when no comparator available). New SECURITY DEFINER RPC `get_latest_locked_budget_for_school(p_school_id uuid)` returns the most-recent locked Budget snapshot's `(scenario_id, aye, stage_type, kpi_total_expenses, locked_at)` ordered by `academic_years.start_date DESC` then `locked_at DESC`. Reads `kpi_total_expenses` from `budget_snapshots` directly per §5.1 binding rule (no live recomputation). Single-tenant: `p_school_id` parameter is preserved for forward-compat naming but currently ignored — Agora has no `school_id` column anywhere in the schema. Two of the three Tuition SECURITY DEFINER functions get refreshed via CREATE OR REPLACE: `lock_tuition_scenario` snapshot INSERT extended to write the three new columns; `create_tuition_scenario_from_snapshot` extended to copy them forward when seeding Stage 2 from a Stage 1 snapshot. `compute_tuition_scenario_kpis` deliberately NOT touched — Stage 1 KPIs continue computing client-side per the v3.8.3 architectural decision; the hoist remains queued. Architecture §7.3 "Stage 1 expense comparator" subsection documents the cart-and-horse rationale, the dropdown mechanics, the silent stale-detection, and the per-scenario (not page-scoped) storage choice.
- **Migration 028**: Tuition B1.2 — Ed Program Revenue + B&A hours + Multi-Student Discount stream (v3.8.3). Two new columns on `tuition_worksheet_scenarios`, mirrored on `tuition_worksheet_snapshots`: `projected_b_a_hours int` (nullable; Stage 1 input for the projected total annual B&A hours across all enrolled students; Stage 2 audit captures actuals via the existing `actual_before_after_school_hours` column), and `projected_multi_student_discount numeric(12,2)` (nullable; persisted on every save that touches its computational inputs — tier_rates, total_students, estimated_family_distribution, top_tier_avg_students_per_family — as the at-save snapshot of the math; downstream reads such as the lock snapshot capture and future RPC bundle work without recomputation). Two of the three SECURITY DEFINER functions get refreshed via CREATE OR REPLACE: `lock_tuition_scenario` snapshot INSERT extended to write both new columns; `create_tuition_scenario_from_snapshot` extended to copy both forward when seeding Stage 2 from a Stage 1 snapshot. `compute_tuition_scenario_kpis` is NOT updated in B1.2 — Stage 1 KPIs (Multi-Student Discount, Gross Ed Program Revenue, Net Ed Program Revenue) compute client-side via `src/lib/tuitionMath.js` for instant feedback during Stage 1 iteration; server-side hoist is queued for Tuition-C when the RPC starts returning a real KPI bundle (break-even, net-ed-program-ratio, YoY) and the round-trip cost amortizes across multiple KPIs. Notify pgrst at the end. Architecture §7.3 "Stage 1 revenue vocabulary" subsection codifies the four-stream taxonomy this migration enables (Projected Gross Tuition, Projected Ed Program Revenue, Total Projected Discounts, Net Projected Ed Program Revenue with Multi-Student as the fourth discount stream alongside Faculty / Other / Financial Aid, mirroring Libertas's legacy AYE 2026 spreadsheet AYE26 lines 34–38).

### Migrations needed (per this architecture)

- **Migration 031**: Strategic Plan schemas (three instruments)
- **Migration 032**: Snapshot tables for Staffing, Enrollment (Budget shipped in 011; Tuition shipped in 023)
- **Migration 033**: Board Composition + Committees
- **Migration 034**: Org Acronyms registry, Custom KPI registry
- **Migration 035**: Module-to-Account mappings
- **Migration 036**: Workflow Configuration UI scaffolding (Phase R2) — depends on the Settings UI work; may add a dedicated `workflow_config` module-permission row
- (Additional migrations as build phases progress)

### Migration practices

- **PostgREST schema cache reload — every migration.** Every migration that creates or replaces a function, creates or alters a table, or changes any RPC-callable surface ends with `notify pgrst, 'reload schema';`. PostgREST does not refresh its schema cache automatically; without the notification, the API layer reports objects as "not found in schema cache" until the cache happens to refresh on its own. This was the bug that lost Migration 007 during the 010–012 architectural correction — the function existed in the database but was unreachable from the UI.
- **FK-completeness on safety-check functions.** Functions like `chart_of_accounts_can_hard_delete()` that test whether a record is safe to delete must be updated whenever a new table is added with an FK to the underlying record's table. If the function falls out of sync, the UI's pre-flight check claims a record is safe when the database's FK constraints will reject the deletion — a poor UX and a trust failure as much as a bug. Migration 013's header comment carries the running list of tables checked vs. tables intentionally not blocking; future migrations that add FK references must update both the function body and that list.
- **Disposable test data is disposable.** Migrations that drop and recreate tables in development should explicitly note "no production data — only Phase N test data, disposable" in the header comment. Migration 011 followed this pattern.

---

## Appendix C: Key Decisions Reference

For quick lookup of decisions made during design:

| Decision | Choice | Section |
|---|---|---|
| Permissions model | User-based, not role-based | 2.1 |
| Hierarchy display in Budget | Style A (rollup categories visible) | 4.5 |
| Chart of Accounts depth | Self-referential, arbitrary depth | 4.1 |
| QB import | Standard QB Account List CSV | 4.6 |
| Snapshot versioning | Option 2 (state captured at lock) | 4.7 |
| PDF rendering | Path B (HTML-to-PDF, upgradeable) | 5.3 |
| PDF mechanism | `window.print()` + dedicated print routes (no Puppeteer) | 5.3 |
| Locked-state render binding | Live joins to COA forbidden; snapshot tables only | 5.1 |
| Strategic Plan model | Three peers (ENDS / Financial / Operational) | 6.1 |
| Operational Plan structure | Three levels (Plan → Focus Area → Action) | 6.4 |
| Operational Plan post-adoption | Structure locked; living fields editable | 6.5 |
| Multi-scenario in operational modules | Yes, all three; one is_recommended at lock | 7.1 |
| Tuition module shape | Two-stage workflow: Tuition Planning (Stage 1, January) + Tuition Audit (Stage 2, September with family detail) | 7.3, 7.5 |
| Tuition discount taxonomy | Layered: multi-student tiers (primary), Faculty rule, Other envelope, Financial Aid envelope | 7.3 |
| Tuition stage typing | Reuse `preliminary` and `final` from existing catalog; school display name carries module-specific vocabulary | 7.3 |
| B&A School Care rate | Tuition Committee decision at Stage 1; hours actualized at Stage 2 | 7.3 |
| Tuition Audit per-family detail | Per-family rows with discount allocations and audit-trail notes column | 7.3 |
| Cross-module lock cascade | Cascade rules formalized in §7.5; each module's section references §7.5 for canonical definition | 7.5 |
| Sidebar structure | Module-grouped with collapsible stage children (Tuition + Budget under PLANNING). No numbers — sidebar shows places, governance calendar shows times. Parent click toggles; child click navigates. | 3.2 |
| Tuition setup gateway scope | Fresh-start only in v3.8.2. Bootstrap-from-prior queued for AYE 2027 cycle (no prior snapshot exists in the first cycle). CSV import permanently skipped (data shape too small to warrant CSV format). Precedent for future small-data-shape modules. | 7.3 |
| Tuition Stage 1 family-distribution input model | total_students + per-tier breakdown_pct as user inputs; total_families derives from total_students ÷ weighted-avg-students-per-family; user can override total_families with implicit "↻ revert to derived" affordance. Per-tier family_count is application-derived from total_families × breakdown_pct / 100 and written to the jsonb on save. Reframed in v3.8.2 to match how fiscal directors actually cast enrollment projections. | 7.3 |
| Stage 1 KPI computation locus | Client-side in `src/lib/tuitionMath.js` for B1.2 — instant feedback during tier-rate / breakdown / B&A-hours / discount iteration; server-side hoist into `compute_tuition_scenario_kpis` RPC deferred to Tuition-C when round-trip cost amortizes across multiple KPIs (break-even, net-ed-program-ratio vs locked Budget, YoY). Persisted column `projected_multi_student_discount` written from client-computed value on save for snapshot fidelity. | 7.3 |
| Multi-Student Discount as fourth discount stream | Vocabulary alignment with Libertas legacy AYE 2026 spreadsheet (lines 34–38: Multiple Student / Faculty / Other / Financial Aid). Gross Tuition is base × headcount everywhere in Agora; tier blending shows up exclusively as the Multi-Student discount line. Stage 1: Multi-Student is computed from tier math; Stage 2: per-family realized actual. The two are not expected to agree — variance is itself a calibration signal. | 7.3 |
| Accounting parentheses convention for subtractive currency values | Discount values, discount subtotals, and any negative currency render with parens — `($53,655)` not `-$53,655`. The `formatCurrency(value, { subtractive })` helper in `src/lib/format.js` accepts an explicit subtractive flag for known-subtractive contexts; negative values trigger parens automatically without the flag. Universal across the page; aligns with the visual language of the Tuition Committee's existing spreadsheets. | 10.12 |
| Stage 1 page section ordering | Projected Enrollment (Total students) sits above Tier Rates as the page's first content section, matching how the school actually thinks through Stage 1 (project enrollment, then set rates, then layer discounts). Total students editable exclusively in Projected Enrollment; Family Distribution renders read-only mirror. | 7.3 |
| Stage 1 expense comparator scope (locked_budget vs manual) | Per-scenario stored mode (`locked_budget` | `manual`), amount, and source label drive Net Education Program Ratio and Breakeven Enrollment KPIs. Default selects most recent locked Budget via `get_latest_locked_budget_for_school` RPC; manual override available via dropdown in the Net Ratio stat's sublabel. Silent stale-detection on scenario load refreshes the comparator if the underlying locked Budget changed; change_log captures the drift. Snapshot-faithful (mirrored on snapshots so locked Stage 1 KPIs are reproducible). | 7.3 |
| Comparator selection is per-scenario, not page-scoped | Each scenario stores its own comparator state. Switching scenarios does not carry the comparator forward — preserves snapshot fidelity (the locked snapshot reflects the comparator at lock time) and lets the user reason about each scenario against its own reference. | 7.3 |
| Tuition Planning Sheet PDF deferred to Tuition-E | Board approval record (working-document with DRAFT marking) capturing the recommended scenario's tier rates, fees, discount projections, and the two Stage 1 KPIs. The artifact the HoS brings to Board for the recommend-and-approve cycle. Family-facing Tuition Schedule PDF also deferred to Tuition-E. Both captured here as architectural commitments so they do not drift from the Phase 4 build sequence. | 7.3, 12 |
| RPC signatures align with single-tenant architecture | Forward-compat parameters for not-yet-implemented multi-tenancy are NOT added to RPC signatures. Architecture §1 and CLAUDE.md direct that multi-tenant scaffolding (org_id columns, school_id parameters, etc.) is deferred to the coordinated migration that lands when a second school onboards; pre-emptive scaffolding misaligns the codebase with the stated single-tenant architecture and forces ad-hoc cleanups when noticed. Tuition-C.1's drop of `school_id` from `get_latest_locked_budget` is the canonical example. | 1 |
| Staffing lock timing | After Preliminary Budget; required for Final | 7.4 |
| Module workflows | Hybrid: school display name × Praesidium-curated stage type | 3.8 |
| Budget editing model | Direct edit with undo | 8.3 |
| KPI panel placement | Collapsible sidebar | 8.1 |
| Multiple Budget scenarios | Supported (with HS / without HS use case) | 8.7 |
| Sibling lock enforcement | Three layers: DB trigger + app validator + UI affordance | 8.7.1 |
| Unlock approval count | Two distinct identities; request submission counts as approval 1 | 8.13 |
| Unlock initiator separation | Requester cannot be approval 2 | 8.13 |
| Unlock state model | State stays 'locked' during request; flag fields track in-progress | 8.13 |
| Unlock permission tier | Distinct from approve_lock; approve_unlock gates both request and approval. Module-scoped governance authority pattern (Budget: Treasurer or designee) named in user-facing copy. System enforces permission grant and distinct-identity only. | 3.5, 8.13 |
| Unlock UI pattern | Slim morphing banner; actions open modals | 8.13 |
| Stage initialization cascade | Non-first stages seed from locked predecessor | 3.4, 8.14 |
| Canonical naming of locked artifacts | Render-time, locked surfaces only | 8.15 |
| Formal tone in user-facing strings | No contractions in system-authored copy | 10.11 |
| Budget Summary narrative | Optional, Preliminary only, in Detail PDF | 8.8 |
| AYE close | Manual, two approvals, irreversible | 9.2 |
| Board/Committee composition lock | Live editing + snapshot at AYE close | 9.4 |
| Bootstrap default | Bootstrap from prior AYE; opt-out to start fresh | 9.2 |

---

## Appendix D: Known Limitations

Tactical gaps documented here for future hardening. Not architectural decisions — known compromises that are acceptable today and should be revisited as the platform matures.

- **RLS column-granularity gap (Chart of Accounts).** Edit-level users can technically deactivate or reparent accounts in `chart_of_accounts` via direct API calls. Postgres RLS UPDATE policies cannot easily distinguish *which column* an UPDATE touches, so the policy permits any UPDATE if the user has `edit` permission. UI-level gating is in place — the Deactivate / Reparent affordances only render for users with `approve_lock` permission — but a determined edit user could bypass via the JS console. Acceptable for the current single-school trust model where every edit-level user is staff at the same institution. Future hardening: implement column-aware UPDATE checks via a BEFORE UPDATE trigger when multi-school onboarding makes the trust model less homogeneous.

- **GRANT discipline (resolved in Migration 006).** Default privileges are now set on the public schema so future tables, sequences, and functions automatically grant SELECT/INSERT/UPDATE/DELETE/EXECUTE to the `authenticated` role. RLS continues to enforce row-level access.

---

## Document Maintenance

This document should be updated when:
- Architectural decisions change (rare, requires explicit board-of-the-builders agreement)
- Future modules are designed (move from Section 11 to dedicated section)
- Build phases complete (note completion in Section 12, update Appendix B)
- Schema migrations are applied (update Appendix B)

Version history:
- **v1.0** — April 26, 2026 — Initial consolidation from design conversations
- **v1.1** — April 27, 2026 — Migration ordering corrected: Chart of Accounts now precedes Budget refactor (was reversed in v1.0). Appendix B updated to reflect Migration 003 (tuition target ratio fix) which was implemented but missing from the list. COA schema implemented as Migration 004; Budget refactor renumbered to 005; subsequent migrations renumbered accordingly.
- **v1.2** — April 27, 2026 — Posting vs summary account model. Section 4 rewritten: leaf-only governance flag rule replaced with posting-only rule (`posts_directly = true`). The leaf-only rule made it impossible to flag parent accounts that post directly in QuickBooks (e.g., "Revenue – Tuition" containing a "Tuition Discounts" subtree), producing incorrect Ed Program Dollars math. See Migration 005 and Section 4.11 (Deprecated rules). Budget refactor pushed to Migration 006; subsequent migrations renumbered. Appendix D added for known tactical gaps.
- **v1.3** — April 27, 2026 — Migration 006: default privileges set on public schema. GRANT discipline resolved systemically. Appendix D entry updated from open issue to resolved. Budget refactor renumbered to Migration 007; subsequent migrations renumbered accordingly.
- **v1.4** — April 27, 2026 — UI corrections sweep: contrast tokens rationalized (`muted` redefined from warm gray `#6B6760` to navy-tinted `#475472` = navy at 80% opacity equivalent; `status-amber` darkened from `#BA7517` to `#8C5410` to pass WCAG AA on cream); back navigation `Breadcrumb` component added and wired into every content page; COA tree posting/summary visual distinction (italic "summary" tag with middot separator); Account Kind helper text tightened. No schema changes.
- **v1.5** — April 27, 2026 — CSV import/export implemented for Chart of Accounts. Two source formats supported on import: generic Agora format (round-trips with export) and QuickBooks Account List CSV (auto-detected via `Account` + `Type` headers). Five-stage import flow with preview tree, validation (path resolution, type consistency, cycle detection, duplicate codes), Append vs Replace conflict modes, auto-backup before Replace, and a bulk flag-review grid for QB imports where governance flags aren't in the CSV. Vocabulary refined to QuickBooks-aligned terminology in user-facing copy: "subaccount of" replaces "Parent" in form labels and table headers; "+ Subaccount" replaces "+ Child" buttons; helper text updated throughout. Database column `parent_id` unchanged — see Section 4.13. Trigger error messages translated client-side at UI surface (`translateError` in `CoaManagement.jsx`).
- **v1.6** — April 27, 2026 — CSV importer hardened against real QBO export format. Parser bugs fixed: (1) dynamic header detection — scan first 20 rows, discard metadata rows above the recognized header; (2) real QBO column names — `Account #`, `Full name`, `Type`, `Detail type` (vs the previously assumed `Account` and `Type`); (3) plural `Expenses` value normalized to `expense`. Non-Income/Expense rows (Bank, A/R, Equity, etc.) are now explicitly rejected with a budgeting-only message rather than silently skipped — user chooses skip-and-continue or cancel. **Guided flag review routing fixed**: QBO-format imports now auto-route to the bulk flag-review grid (mandatory next step), instead of dumping users on a success page where the grid was buried behind an extra click. Grid additionally upgraded with tree-order display, depth-based name indentation, and symmetric Pass-Thru ↔ Ed Program $ / Contribution mutual exclusivity. Save All now closes the panel directly on success (returns to the financial settings tree); Skip for now likewise. Added downloadable CSV template (`agora_coa_template.csv`) with example rows in the generic format. Improved unrecognized-format error: lists the columns found in the uploaded file and the columns expected for each supported format, with a link to download the template. Test fixture `test/fixtures/Libertas_Academy_Account_List.csv` preserved for regression testing.
- **v1.7** — April 27, 2026 — User-facing copy neutralized: QuickBooks references removed from product narrative (import panel description, helper text on the Account Kind radio, guided-review grid helper text, format-not-recognized error). Technical references in parser implementation and code comments preserved. Format-detected confirmation banner still factually names "QuickBooks Account List format" because it's identification of what was uploaded, not promotional copy. New Section 10.8 codifies the language standard. Sticky column headers added to the guided flag review grid (inner-scroll container with max-height) and the COA Flat view (page-level sticky on `<th>` cells), so the column legend stays visible while scrolling 70+ row charts of accounts.
- **v1.8** — April 27, 2026 — Sidebar: ACTUALS section added between BUDGET and ADMIN per Section 3.2 with two future-disabled sub-items (Advancement, Cash Flow). All five top-level categories (GOVERNANCE / OPERATIONS / BUDGET / ACTUALS / ADMIN) made collapsible — chevron + label both toggle, smooth `grid-template-rows` transition (200ms), state persisted in `localStorage` (`agora.sidebar.collapsedSections`). Auto-expand on route change so the section containing the active page is always visible in the sidebar. Dashboard remains a top-level link without a parent category. School Settings sub-item expand/collapse pattern (preserved from earlier work) operates independently of the top-level ADMIN toggle.
- **v2.0** — April 27, 2026 — Conditional hard delete on COA accounts implemented (Migration 007). New Section 4.12 documents the soft-delete (Deactivate) vs hard-delete distinction. The DB function `chart_of_accounts_can_hard_delete(account_id)` returns both a boolean and a human-readable blocking reason; the UI hides the Delete button when the account isn't safe and surfaces the reason via a hover (i) icon next to Deactivate. RLS policy split: `coa_insert` and `coa_update` keep the edit-permission gate (so soft-delete still works at edit level), `coa_delete` requires `admin`. Hard-delete audit logging is automatic via the existing change_log trigger. Function body is structured to extend as Phase 2+ modules add FK references to `chart_of_accounts`.
- **v2.1** — April 27, 2026 — COA management UI polish. Add / Edit / "+ Subaccount" interactions converted from inline expand to modal, mirroring Budget's "+ Add Account" pattern — same `AccountForm` React component opened in modal context. New Section 10.9 codifies the modal-not-inline-expand principle for row actions at scale. Tree-row layout restructured into fixed-width zones (metadata, type+status, actions) so the right edge stays aligned across 100+ rows; metadata zone surfaces the most informative governance flag with a "+N" + tooltip when multiple are set, instead of the prior inline pill stack. (i) info icon next to Deactivate recolored from muted-red to muted-navy with hover-to-navy treatment — informational, not destructive. AccountForm gained a `parentLocked` prop so the "+ Subaccount" entry path renders the parent as a read-only context line instead of an editable dropdown. No schema or business-logic changes.
- **v2.2** — April 28, 2026 — Phase 2 architectural correction. Budget module generalized from a hardcoded two-stage assumption (Preliminary, Final) to support **configurable workflows and stages** (new Section 3.7). Hybrid stage-type taxonomy: schools name and order stages freely; each stage is typed from a Praesidium-curated catalog (`working` / `preliminary` / `adopted` / `reforecast` / `final`). Migrations 010 (workflow framework + Libertas seed), 011 (Budget tables refactored to reference stages, module renamed `preliminary_budget` → `budget`), and 012 (stage-aware atomic lock function) land the new model. Section 8 rewritten with stage-agnostic language; Section 5.1 documents stage capture in snapshots; Section 9.7 introduced as the Annual Rhythm Configuration home; Section 12 adds Phase R2 (Workflow Configuration UI) as queued work. UI refactor: page renamed `PreliminaryBudget.jsx` → `BudgetStage.jsx`, route changed to `/modules/budget/:stageId`, sidebar slots filled dynamically from `get_module_workflow_stages('budget')`. The previously-pushed Migration 010 (`lock_preliminary_budget_scenario`) was never applied to any production database; it is removed from the repo and replaced by Migration 012.
- **v2.3** — April 28, 2026 — Budget UI: KPI sidebar moved from left of detail to right, with chevrons flipped (collapsed ◂ inward, expanded ▸ outward) and storage key renamed to `agora.kpiSidebar.collapsed`. Section 8.1 layout sketch updated with the new placement and a rationale note: navy KPI panel against cream surfaces on both sides reads as a clearly bounded element, where the original left placement created visual collision with the navy nav sidebar. Side placement is not architecturally binding; either side is acceptable as long as it doesn't collide with nav chrome. Companion fix to AppShell: duplicate React key on workflow-stage slot placeholders (both rendered `key=budget-—` during the brief async load) caused two-step-4 ghosting in the sidebar; key now incorporates step number and array index.
- **v2.4** — April 28, 2026 — COA UX hardening at 122-row scale. **Migration 013** restored and extended `chart_of_accounts_can_hard_delete()` with `budget_stage_lines` checks (Migration 007's function was lost during the architectural correction and was running off an SQL Editor patch). **Schema cache reload** discipline established: every migration that touches RPC-callable surfaces ends with `notify pgrst, 'reload schema';` — Migrations 008–012 had it added retroactively. **Toast system**: `<ToastProvider>` + `useToast()` at the app root render fixed-position toasts in the top-right of the viewport, visible regardless of scroll depth. CoaManagement, BudgetStage, and AYEManagement migrated from inline status banners to `toast.success` / `toast.error`. Form-field validation, modal-internal mid-action errors, and focal-panel feedback (CsvImportModal, ImportExportPanel) stay inline by design. **Sticky COA section header**: section banner, view tabs, action buttons, and Expand all / Collapse all controls pin to the top of the scroll container so they remain reachable from anywhere in a 100+ row tree. Flat view's column headers stick below the section header. New Section 10.10 codifies the long-list-controls + viewport-toasts pattern; Appendix B adds Migration Practices with the schema-cache and FK-completeness disciplines.
- **v2.5** — April 28, 2026 — Lock workflow validated end-to-end against the stage-aware schema. Snapshot integrity invariant confirmed: locked snapshots survive post-lock COA changes via captured-by-value account state and `ON DELETE SET NULL` on `budget_snapshot_lines.account_id`. Cascade override path verified as the realistic day-one path until upstream modules (Tuition Worksheet, Enrollment Estimator) gain lockable state. Reject-and-return-to-drafting path verified. Fixed kebab menu positioning bug (scenario tab dropdown was anchored `right-0` and clipped past the page's left edge into the nav sidebar — changed to `left-0` with `z-50` so it stays in the page content layer). Corrected Save and View PDF button gating to be independent of `is_recommended` (Save: confidence-affordance toast when state=drafting + canEdit; View PDF: stays a placeholder until Commit F with a tooltip naming the schedule rather than implying gating). Added inline guidance about the recommended-scenario requirement: when Submit for Lock Review's specific blocker is `is_recommended = false`, an inline hint below the button points the user at the scenario tab menu. New Section 8.12 codifies the header button gating rules.
- **v2.6** — April 28, 2026 — Phantom-row protection on COA edits (Migration 014). A row in `budget_stage_lines` pointing at a summary account surfaced during Commit E test pass when "Copy from current scenario" tried to insert it into a new scenario and Migration 011's validation trigger correctly rejected. Audit of every insert path confirmed they all filter for `posts_directly = true AND is_pass_thru = false AND is_active = true`; the phantom arrived via the COA EDIT path, where toggling `posts_directly` from true to false (or `is_pass_thru` from false to true) was not validated against existing `budget_stage_lines` references. Migration 014 closes the gap with a `BEFORE UPDATE` trigger on `chart_of_accounts` that rejects those transitions when live budget references exist, and runs a one-time cleanup DELETE removing any existing phantoms. Snapshot tables intentionally not counted (immune by the captured-by-value design). Section 4.12 extended to document the new edit-time protection alongside the existing delete-time protection. Also: View PDF wired as a `window.print()` stub with minimal print CSS (chrome hidden + DRAFT marker for non-locked scenarios) — the architectural-promise version of "View PDF works in any state" lands now, the polished print layout (diagonal watermark, approved-by footer, narrative block, hierarchical totals styling) ships in Commit F. Section 5.3 documents the chosen print mechanism (`window.print()` + `@media print` over a Puppeteer-on-Vercel approach) and the upgrade path if emailable PDFs become a real requirement.
- **v2.7** — April 29, 2026 — Locked-state Budget render path corrected. v2.5 claimed end-to-end verification of the snapshot integrity invariant; the deactivate-after-lock test that was supposed to confirm it actually surfaced a render-path bug. The locked Budget view was reading from `budget_stage_lines` joined client-side to live `chart_of_accounts`, then running the live tree builder which filters out inactive accounts whose lines are zero — so deactivating an account in a locked scenario made it disappear from the locked view. **The schema-level invariant was always intact**: the snapshot row was correctly populated with captured-by-value columns by Migration 012's lock function, and `budget_snapshot_lines.account_id` correctly uses `ON DELETE SET NULL`. The render simply wasn't using any of it. Fix splits the data load on `activeScenario.state`: locked → `fetchScenarioPayload` reads `budget_snapshots` + `budget_snapshot_lines`; drafting / pending → live `budget_stage_lines` + `chart_of_accounts`. New `buildSnapshotTree(snapshotLines)` reconstructs the tree from captured `account_hierarchy_path` segments and uses captured-by-value columns for every display field; `snapshotKpis(snapshot)` returns the seven KPI columns from the snapshot row directly. Locked-state KPI sidebar no longer recomputes — it shows what was captured at lock. New Section 5.1 binding rule codifies this: "Live-data joins are FORBIDDEN in locked-state render paths." Snapshot integrity invariant now actually verified end-to-end: deactivating an account in a locked scenario leaves the locked view unchanged.
- **v2.8** — April 29, 2026 — Lock-state guards across scenarios (Migration 015). With Scenario 1 locked, a user could still mark Scenario 2 as recommended (silently unmarking Scenario 1's `is_recommended` flag — a separate corruption path) AND submit Scenario 2 for lock review. Migration 011's partial unique index gates only the intersection of `(locked, recommended)` and didn't prevent either path. **Two BEFORE UPDATE triggers** on `budget_stage_scenarios` close the loophole: `tg_prevent_recommend_while_sibling_locked` rejects setting `is_recommended = true` when any other scenario in the same `(aye_id, stage_id)` is `locked`; `tg_prevent_lock_submit_while_sibling_locked` rejects the `drafting → pending_lock_review` transition under the same condition. Both fire only on the specific transition, so no-op UPDATEs pass through. These are hard guards — application-layer admin override cannot bypass them. **Application layer**: new `findLockedSibling(scenarios, currentScenarioId)` pure/sync helper in `src/lib/budgetLock.js`; `validateScenarioForLock` extended with an optional `lockedSibling` parameter that produces a failure tagged `hardBlock: true, kind: 'sibling_locked'`. SubmitLockModal hides the override path entirely when any hardBlock failure is present (rather than offering an override the DB would refuse). **UI affordances**: ScenarioTabs disables "Mark as recommended" with a tooltip naming the locked sibling; BudgetStage renders an amber informational banner above the detail zone when the active scenario is `drafting` and a sibling is locked, and the Submit button tooltip reflects the sibling-lock block before any other gate. **Historical-data repair**: a one-time DO block at the top of Migration 015 detects locked scenarios where `is_recommended = false` (the corruption the bug actually produced) and repairs them — clears `is_recommended` on any non-locked sibling in the slot, then restores `is_recommended = true` on the locked row. Runs before triggers are installed so the repair UPDATE isn't itself rejected; idempotent on a clean DB. New Section 8.7.1 codifies the three-layer enforcement and includes diagnostic queries for post-migration health checks.
- **v2.9** — April 29, 2026 — Phase 2 Commit F. Operating Budget Detail PDF (DRAFT + LOCKED variants), per-line audit history modal, per-scenario activity feed, and PDF exports of both audit surfaces. **Print routes** moved off the editing-screen `window.print()` stub onto dedicated routes under `/print/...` that render their own component tree (no AppShell, no nav sidebar, no KPI sidebar): `/print/budget/:scenarioId` (Operating Budget Detail), `/print/budget/:scenarioId/activity` (activity feed), `/print/budget-line/:lineId/history` (per-line history). Each route auto-fires `window.print()` on mount and provides on-screen Print/Back controls. The shared `PrintShell` component handles the letterhead (logo + title + generation timestamp), the diagonal DRAFT watermark, the running DRAFT banner, and the approved-by/override-justification footer. **DRAFT vs LOCKED** binding: the locked PDF reads exclusively from `budget_snapshots` + `budget_snapshot_lines` captured-by-value columns and the snapshot's `kpi_*` columns — the same §5.1 rule the in-app locked view follows. Live-COA joins are forbidden in the locked print path. **Audit surfaces**: `LineHistoryModal` opens from a clock affordance per leaf row in BudgetDetailZone and shows the chronological change_log for that single line with field-level diffs and PDF export. `ActivityFeedPanel` mounts as a collapsible panel above the budget detail with count dropdown, filter (All / Lock+Override only / Edits only), and PDF export. New `src/lib/auditLog.js` provides the query helpers (`fetchLineHistory`, `fetchScenarioActivity`), grouping (`groupChangeLogRows` collapses fan-out UPDATE rows into single events), classification (`classifyEvent` assigns one of nine kinds for visual treatment), and humanization (`summarizeEvent`, `describeField`). Lock events render with blue treatment + lock icon; override events render with amber treatment and the full justification text inline (no truncation — §9.1 commitment). Old `window.print()` stub CSS in `src/index.css` removed (only `.no-print` utility retained); the dedicated print routes own all print styling via `src/components/print/print.css`. Architecture §5.3 rewritten to reflect the print-route pattern; §8.11 marks Operating Budget Detail shipped (Summary and Variance Report deferred); §9.1 updated to document the modal + feed + PDF exports as implemented. Snapshot integrity invariant preserved end-to-end: deactivating an account in the live COA leaves the locked PDF unchanged.
- **v3.0** — April 29, 2026 — Budget PDF visual polish. Five issues from the Commit F shake-out fixed in one pass. (1) **Four-tier hierarchy** in budget detail (new §10.4 subsection): Tier 1 categories at Cinzel 16pt with gold underline; Tier 2 summaries at EB Garamond 13pt bold with thin navy rule; Tier 3 summaries at 12pt bold no rule; Tier 4 leaves at 11pt @ ~85% navy, regular weight, code in a 50px left column. Indentation 24px per tier. (2) **Print-preview chrome cleanup**: chrome bar now uses cream-highlight surface so the white document inside reads as a distinct artifact; document title removed from chrome and rendered inside the document letterhead only; "Print again" → "Print"; chrome elements (`.print-preview-chrome`, `.print-preview-back-link`, `.print-preview-print-button`) explicitly hidden in `@media print` so they cannot leak into saved PDFs. (3) **Forced page break eliminated**: removed the over-broad `print-category` (`break-inside: avoid`) wrapper that was pushing INCOME to page 2. Only Tier 2 blocks now carry `break-inside: avoid`; Tier 1 categories and Tier 4 leaves break freely so page 1 fills naturally with title + KPI summary + the start of INCOME. (4) **Full horizontal color logo** (`/public/logo-horizontal-color.png`) on the first page of every Budget PDF surface; subsequent pages use a thin Cinzel running header with title and DRAFT suffix when applicable. The crest (`/public/logo-mark.png`) stays the in-app/favicon asset. (5) **Tightened name-to-amount layout**: per-tier `max-width` (95% / 85% / 75% for Tiers 2/3/4) so account names and amounts read as connected units instead of opposite ends of the page. New §10.4 subsections "Hierarchical visual treatment in budget PDFs" and "Logo treatment in printed governance documents" codify the rules.
- **v3.1** — April 29, 2026 — Budget PDF second polish pass. Three issues from the v3.0 shake-out plus a density tightening, all in one pass. (1) **Logo aspect ratio** — the wordmark "LIBERTAS ACADEMY" was rendering vertically compressed because the `<img>` carried `h-[64px]` AND `maxWidth: 240px`; with the natural aspect ratio wider than 240/64, the browser forced the height to stay at 64px while clipping width, distorting the wordmark. Fix sets `width: 220px` explicitly with `height: auto` so the browser computes the correct height from the image's intrinsic aspect ratio. The print stylesheet additionally pins `.print-logo { height: auto !important; object-fit: contain; align-self: flex-start }` as a safety net against any parent flex container that might otherwise stretch the image. (2) **Print preview chrome bar** — Back/Print controls now render as a clear sticky UI bar with cream-highlight surface, navy@15% bottom border, and a soft drop shadow, visually distinct from the white document below. Buttons styled in print.css under `.print-preview-chrome` / `.print-preview-back-link` / `.print-preview-print-button` so the `@media print` suppression rule reliably hits the same selectors. Saved PDFs contain zero chrome. (3) **Tier 1 page-break orphan prevention** — every Tier 1 category (INCOME / EXPENSES) is now rendered with its header AND first Tier 2 child block inside a `.print-tier-1-with-first-tier-2` wrapper carrying `break-inside: avoid`. If "EXPENSES" + "Personnel" don't fit on the current page, both move to the next page — stranding the Tier 1 header alone at the bottom of a page is no longer possible. Subsequent Tier 2 siblings render outside the wrapper and break naturally. (4) **Vertical spacing tightened** by ~30% across all tiers: Tier 1 now 18pt/8pt (was 24pt/12pt), Tier 2 12pt/4pt (was 16pt/6pt), Tier 3 6pt/2pt (was 8pt/4pt), Tier 4 1pt/1pt (was 2pt/2pt). Companion elements (KPI cells, state-indicator banner, title block sub-elements) tightened to match. Document feels denser, more like a published financial statement than a draft worksheet. §10.4 updated with the new spacing table and a "Page break orphan prevention" subsection.
- **v3.7** — May 2, 2026 — Refactor unlock workflow from three-identity to two-identity model. The original H1/H2 design required three distinct identities — a separate `submit_lock`-permissioned requester plus two `approve_unlock` approvers. Bureaucratic overkill for the actual school governance reality where HoS, Treasurer, and Board Chair all hold `approve_unlock` and the requester's submission already represents their professional judgment. The v3.7 model collapses to two identities: the requester's submission counts as approval_1; one additional approver (distinct from the requester, also holding `approve_unlock`) records approval_2 and triggers the state transition to drafting. (1) **Migration 020** drops the CHECK constraint `unlock_initiator_not_approver_1` from `budget_stage_scenarios` so the requester's identity can also satisfy approval_1. Other integrity constraints (`unlock_initiator_not_approver_2`, `unlock_approvers_distinct`, `unlock_sequential_ordering`, `tg_unlock_only_when_locked` trigger) remain. Schema-only; no data affected. (2) **Migration 021** replaces all three SECURITY DEFINER functions. `request_budget_stage_unlock` permission gate changed from `submit_lock` to `approve_unlock` (submitting an unlock request is itself a governance act of approval; the gate matches the approve gate). The request function now atomically populates BOTH request fields AND approval_1 fields from the caller's identity in a single transaction. `approve_budget_stage_unlock` simplified — returns void instead of text, no first/second branching, only ever handles approval_2 + state transition. The "initiator cannot also record approval_2" check now reads more naturally as "requester cannot also record approval_2." `reject_budget_stage_unlock` logic unchanged. (3) **Application validator** (`src/lib/budgetUnlock.js`): `getUnlockBannerState` collapses from three states to two (`locked_no_request`, `locked_awaiting_final_approval` — the intermediate `locked_awaiting_first_approval` is gone). `canRequestUnlock` now takes `hasApproveUnlock` (was `hasSubmitLock`). `canApproveUnlock` removes the `is_first_approver` failure mode. `UNLOCK_REASON_COPY` updated: `is_initiator` copy refreshed to reflect the requester-as-approval_1 reality; `permission_insufficient` references `approve_unlock` specifically. (4) **UI**: `LockedBanner` collapses from three rendered states to two; the redundant "First approved by [requester] on [date]" line that v1 showed for the same identity goes away — replaced with a single inline sentence "Their submission counts as the first approval; one additional approver is required to complete the unlock." `RequestUnlockModal` body copy reframes: "Submitting this unlock request records your approval as the first of two." `ApproveUnlockModal` title simplifies to plain "Approve unlock" (no more first/final branching), copy reframes around the second-approval-completes-the-unlock framing, confirm button reads "Approve and unlock." `RejectUnlockModal` and `WithdrawUnlockModal` copy unchanged (no first/second references existed). (5) **`BudgetStage`** drops the `hasSubmitLock` prop from the LockedBanner call site; `RequestUnlockModal` similarly takes `hasApproveUnlock` instead. (6) **Architecture doc §8.13** rewritten end-to-end to reflect the two-identity model — schema fields, integrity rules (three layers), permission tier, audit trail, application validator, UI layer. Appendix B adds Migrations 020 and 021 to the implemented list and renumbers needed migrations 020-025 to 022-027. Appendix C unlock decision rows updated. **CLAUDE.md** Unlock workflow paragraph rewritten to match. (7) Pre-migration: the previously-pending unlock request on Final Budget Scenario 1 was withdrawn via the v1 UI before this refactor was applied; verified via `SELECT ... WHERE unlock_requested = true` returning zero rows.
- **v3.8** — May 2, 2026 — Tuition module refined to two-stage design. Architectural keystone update before any Tuition module schema or code work begins; documentation-only commit; no schema, no code. Real-data design discovery during the AYE 2026 Final Budget exercise surfaced that tuition is fundamentally a two-stage governance cycle (Tuition Planning in January feeding Preliminary Budget; Tuition Audit in September feeding Final Budget), with layered discount taxonomy and per-family detail in Stage 2. The previous §7.3 was written before this operational reality was articulated and treated tuition as single-stage with binary "flat tiers vs. percentage off" discount-model selection. (1) **§7.3 rewritten** end-to-end. New structure: Purpose (per-stage), Workflow stages (reuses `preliminary` + `final` stage types from existing catalog rather than introducing new types — judgment call: school display name carries the module-specific vocabulary, catalog stays small, cross-module cascade phrasing reads cleanly), Schema (`tuition_worksheet_scenarios` + `tuition_worksheet_family_details` + parallel snapshot tables per §5.1), Layered discount taxonomy (multi-student tiers as primary; Faculty rule, Other envelope, FA envelope each independently applied), Computed outputs (family-facing per-student rate vs. accounting-view gross-vs-net rollup), Stage 2 immutability rules (tier rates copy from Stage 1 snapshot but lock from edit because families have signed agreements; enforced via three-layer pattern per CLAUDE.md), Tuition Schedule PDF (Stage 1 family-facing artifact, content configured by Tuition Committee at Stage 1 lock), Module-scoped governance authority (Treasurer or designee, parallel to §8.13 Budget pattern). (2) **§3.6 (Cross-module data flow)** updated to remove "Enrollment Audit → Final Budget" as a separate module reference. Cross-module flows now correctly read Tuition Stage 1 → Preliminary Budget and Tuition Stage 2 → Final Budget. (3) **New §7.5 "Cross-module lock cascade rules"** formalizes which upstream module locks gate which downstream module locks. Cascade table covers Tuition Stage 1, Preliminary Budget, Tuition Stage 2, Final Budget; documents override paths; documents that cascade enforcement fires at submit-for-lock time, not at draft time. Existing §7.5 (Module-to-Budget mapping) renumbered to §7.6. (4) **§3.1, §3.2, §3.3, §5.2, §5.3, §8.9, §12 Phase 7, Appendix A** all updated to remove Enrollment Audit as a separate module: §3.1 three-layer architecture diagram drops the standalone "Enrollment Audit" line; §3.2 sidebar replaces flat list with two-stage Tuition tree (Tuition Planning + Tuition Audit) and same for Budget; §3.3 time-scoping table replaces "Tuition Worksheet" + "Enrollment Audit" rows with "Tuition Stage 1 (Planning)" + "Tuition Stage 2 (Audit)"; §5.2 detail-visibility flag description updated; §5.3 PDF view list folds the audit views into Tuition module; §8.9 cascade narrative updated to reference §7.5 explicitly; Appendix A permission profiles drop Enrollment Audit references and roll the family-detail role into Tuition. (5) **§12 Phase 4** rewritten as five sub-phases (4a schema → 4b UI → 4c calculation → 4d lock workflow → 4e PDF) reflecting the two-stage shape; §12 Phase 7 trimmed to Final Budget integration since family-level reality capture moved into Phase 4d. (6) **Appendix C** decision rows: NEW "Tuition module shape" (two-stage), REPLACED "Tuition discount models" with "Tuition discount taxonomy" (layered), NEW "Tuition stage typing" (judgment call documented), NEW "B&A School Care rate", NEW "Tuition Audit per-family detail", NEW "Cross-module lock cascade" pointing at §7.5. (7) **CLAUDE.md** extended with two paragraphs codifying patterns that recur: a "Two-stage modules" paragraph noting the Tuition / Budget parallel, and a "Cross-module lock cascade rules" paragraph pointing at §7.5 as the canonical definition referenced from each module's section. (8) Document header bumped 3.7.1 → 3.8. (9) **Sidebar restructure** (committed shortly after the doc work as a direct consequence of the §7.3 architectural rename): the sidebar's "BUDGET" section heading was wrong — it described a single module but actually contained the whole planning workflow. Renamed to "PLANNING" matching §3.1's "PLANNING LAYER" terminology. Tuition becomes a collapsible parent with one rendered child today (Planning, route `/modules/tuition`); the Audit child appears when Phase 4d ships Stage 2 setup. Budget becomes a collapsible parent with both stage children (Preliminary, Final), each routing to the existing parameterized `/modules/budget/<stage-uuid>`. Stage child labels derive sidebar-side from `display_name` with the trailing " Budget" stripped, so the parent carries the module name and the children carry the stage names — sidebar-render-only transform; other UI surfaces continue to read `display_name` / `short_name` as canonical per CLAUDE.md. Numbered prefixes ("1." through "6.") removed from PLANNING items — sidebar shows places, the governance calendar (when built) shows times. "Enrollment Audit" sidebar item removed entirely (it's Tuition Stage 2). New `toggleOnly: true` flag on `NAV_SECTIONS` items distinguishes the new collapsible-parent pattern (parent click toggles, no navigation; children own navigation) from the existing "navigable parent + subItems" pattern still used by School Settings under Admin. `findSectionForPath` updated to map `/modules/budget/*` to `'planning'`. React keys re-keyed without the `step` field; budget stage children use a stable `_slotKey` so React identity survives the async workflow load. Architecture §3.2 rewritten to document the new sidebar tree, the top-level collapse list (now PLANNING in place of BUDGET), and a codifying paragraph stating that sidebar shows places while the governance calendar shows times. CLAUDE.md adds a "Sidebar structure for staged modules" paragraph as future-pattern guidance. Appendix C adds a "Sidebar structure" decision row. The Sidebar component file modified is `src/components/AppShell.jsx` (the project has no separate `Sidebar.jsx`; AppShell hosts both header chrome and sidebar in one file).
- **v3.8.8** — May 3, 2026 — Tuition-C.1: drop unused `school_id` parameter from `get_latest_locked_budget` RPC. Single-tenant alignment cleanup. The RPC introduced in Tuition-C (v3.8.7) carried a preserved-but-unused `p_school_id uuid` parameter as forward-compat scaffolding for eventual multi-tenancy. Architecture §1 and CLAUDE.md both explicitly direct against multi-tenant scaffolding ahead of the coordinated migration ("Do NOT add org_id columns... those migrations are deferred until a second school onboards"); the forward-compat scaffolding was a misstep. Migration 030 drops the old function (`DROP FUNCTION` required because Postgres identifies functions by signature; `CREATE OR REPLACE` cannot change parameter lists) and creates `get_latest_locked_budget()` with no parameters. Function body unchanged otherwise. Single JS call site in `TuitionWorksheet.jsx`'s `fetchLatestLockedBudget` helper updated. When multi-tenancy lands, the RPC gets re-parameterized as part of that coordinated migration. New Appendix C decision row codifies the principle: RPC signatures align with single-tenant architecture; forward-compat parameters for not-yet-implemented multi-tenancy are not added pre-emptively. Document header bumped 3.8.7 → 3.8.8.
- **v3.8.7** — May 3, 2026 — Tuition-C: Stage 1 KPIs (Breakeven Enrollment, Net Education Program Ratio) + expense comparator infrastructure. Stage 1 is feature-complete for input as of v3.8.6; Tuition-C delivers the two decision-support KPIs the Tuition Committee uses to evaluate a scenario before recommending it to the Board. Migration 029 adds three columns + one new RPC; the frontend lands six new exports, a 7-stat sidebar restructure, and the comparator dropdown UI. (1) **Two new Stage 1 KPIs**: Breakeven Enrollment (forward-solve N where revenue equals expense_comparator + fixed envelopes, assuming the current breakdown_pct distribution holds; rounded up via Math.ceil) and Net Education Program Ratio (Net Projected Ed Program Revenue ÷ expense_comparator, rendered as percent — the 102%-of-expenses target lives here). Both compute client-side via `tuitionMath.js` extensions with strict null propagation; em-dash when comparator or core inputs are insufficient. (2) **Expense comparator infrastructure**: three new columns on `tuition_worksheet_scenarios` (mirrored on snapshots) — `expense_comparator_mode text NOT NULL DEFAULT 'locked_budget'` with CHECK ('locked_budget' | 'manual'), `expense_comparator_amount numeric(12,2)` (nullable), `expense_comparator_source_label text` (nullable). The default fetches the most recent locked Budget via the new `get_latest_locked_budget_for_school` SECURITY DEFINER RPC (joins `budget_snapshots` to `academic_years.label`, orders by `start_date DESC` then `locked_at DESC`, returns one row of `{scenario_id, aye, stage_type, total_expenses, locked_at}` reading `kpi_total_expenses` directly per §5.1 binding rule). The user can switch to manual entry via a small dropdown rendered inline in the Net Ratio stat's sublabel area; a custom `customSublabelNode` slot on the `Stat` subcomponent (new prop) renders the dropdown + conditional inline currency input in place of the standard text sublabel. (3) **Cart-and-horse rationale documented in §7.3** (new "Stage 1 expense comparator" subsection): Tuition Planning happens approximately three months before same-AYE Preliminary Budget per cascade rule §7.5, so same-AYE Preliminary is rarely available at planning time. Default comparator is the prior-AYE Final Budget; manual override is the escape valve when forward judgment about expenses warrants overriding the prior-year reference. (4) **Stale-detection silent refresh**: on every scenario load with `mode='locked_budget'`, the page silently fetches via the RPC and refreshes amount + source_label if either differs from stored values. The change_log captures the drift for audit history; the user is not interrupted with a modal or banner. Per-scenario storage (mode + amount + source_label) preserves snapshot fidelity at lock time. (5) **Sidebar restructure**: Projected Families removed (not a Tuition Committee KPI by Jenna's framing); Projected Students renamed to Projected Enrollment and promoted to the leading position; Net Education Program Ratio (emphasized) added as the sixth stat; Breakeven Enrollment added as the seventh. Final order: Projected Enrollment → Projected Gross Tuition → Projected Ed Program Revenue → Total Projected Discounts → Net Projected Ed Program Revenue (emphasized) → Net Education Program Ratio (emphasized, with comparator control in sublabel) → Breakeven Enrollment. (6) **`format.js` extension**: new `formatPercent(value, options)` helper that renders decimals as percentages with the §10.12 accounting parens convention — 1.021 → "102.1%", -0.85 → "(85.0%)". The `Stat` subcomponent's percent format case routes through this helper. (7) **Two SECURITY DEFINER functions refreshed via CREATE OR REPLACE** (return shapes unchanged): `lock_tuition_scenario` snapshot INSERT writes the three new columns; `create_tuition_scenario_from_snapshot` carries them forward when seeding Stage 2. `compute_tuition_scenario_kpis` deliberately NOT touched — Stage 1 KPIs continue computing client-side per the v3.8.3 architectural decision; the hoist remains queued for the next session that introduces a server-side reason to need them (cross-module dashboards, scheduled exports, etc.). (8) **PDF deferral codified**: family-facing Tuition Schedule PDF and the Tuition Planning Sheet PDF (board-approval working document) are explicitly Tuition-E deliverables. Captured as architectural commitment in Appendix C so they do not drift from the Phase 4 build sequence. (9) **Architecture doc**: §7.3 schema block extended with three new columns; new "Stage 1 expense comparator" subsection codifies the cart-and-horse rationale, the dropdown mechanics, the stale-detection silent refresh, and the per-scenario storage choice. Appendix B Migration 029 entry. Appendix C: three new decision rows ("Stage 1 expense comparator scope," "Comparator selection is per-scenario, not page-scoped," "Tuition Planning Sheet PDF deferred to Tuition-E"). Document header bumped 3.8.6 → 3.8.7.
- **v3.8.6** — May 3, 2026 — Tuition-B1.5: Projected Enrollment as page-leading section. Pure structural and visual reorder — no math changes, no schema changes, no formula changes, no persistence path changes. Real-data walkthrough surfaced the ordering insight: Stage 1 planning starts with projecting total enrollment, then sets per-student rates, then layers discounts. The previous order had the user setting rates before committing to a headcount. (1) **New `ProjectedEnrollmentSection.jsx`** rendered above Tier Rates as the page's first content section. Single-input section containing only Total students. Standard Tier 1 section header with gold border-bottom, italic muted help paragraph, Total students input rendered with bold typography (label and value, in display / focus / read-only states) — the bold weight is the visual differentiator that signals "load-bearing input"; the section's placement at the top of the page reinforces the same signal. (2) **Total students input relocated** from inside `FamilyDistributionSection.jsx` to the new section. Single source of truth for editing — Family Distribution now renders Total students as a read-only display mirror (no input chrome, value matches what the user entered above; em-dash when null). All other Family Distribution internals unchanged: Total families (with v3.8.2 override + revert behavior), breakdown table, top-tier average input, breakdown sum indicator, implied-students reconciliation. (3) **Help paragraph copy updates**: Family Distribution opens "Distribute projected enrollment across family sizes. Family counts derive from the breakdown percentages; override Total families if you have a more specific projection. Total students is set in the Projected Enrollment section above" (replacing the prior B1.1 phrasing that introduced both inputs in this section). Projected Enrollment opens "Project total enrollment for the academic year. Total students drives every downstream calculation — tier-blended tuition, fee revenue, B&A revenue, and discount projections. Stage 2 audit captures actual enrollment." (4) **Page section render order** in `TuitionConfigurationZone.jsx` changes from `Tier Rates → Tuition Fees → Projected Discounts → Family Distribution` to `Projected Enrollment → Tier Rates → Tuition Fees → Projected Discounts → Family Distribution`. (5) **Save path unchanged**. The page handler `handleUpdateField('total_students', value)` already triggers `applyDerivedFamilyCounts` recomputation when the user is "tracking derived" total_families — the new section just calls the same handler. Total families and family-distribution rows continue to derive from total_students × breakdown_pct exactly as before; downstream computations (tier-blended tuition, fee revenue, B&A revenue, Multi-Student Discount, Net Projected Ed Program Revenue) all read `scenario.total_students` regardless of which section the user entered it in. (6) **No `onChangeTotalStudents` prop passed to `FamilyDistributionSection`** anymore — the prop is removed from its API and the corresponding handler `handleSaveTotalStudents` is removed from the section. The `editingField` state union shrinks from `'total_students' | 'total_families' | 'top_tier_avg' | null` to `'total_families' | 'top_tier_avg' | null`. (7) **Stats sidebar unchanged**. Same six stats, same sublabels, same emphasis treatment, same values for the same scenario inputs — the sidebar feeders read `scenario.total_students` regardless of which section provided the input. (8) **Architecture doc**: §7.3 "Stage 1 page section ordering" addendum codifies the reorder rationale (operational reality of Stage 1 planning) and the bold-typography-on-Total-students convention. Appendix C: new "Stage 1 page section ordering" decision row. Document header bumped 3.8.5 → 3.8.6.
- **v3.8.5** — May 3, 2026 — Tuition-B1.4: copy alignment micro-commit. Sidebar Projected Gross Tuition stat sublabel updated from "Total students × Tier 1 rate" to "Total students × Base rate" to match the BASE badge in the Tier Rates section (B1.1) and the spreadsheet vocabulary used throughout Stage 1. One-string change in `src/pages/modules/TuitionWorksheet.jsx`; document header bumped 3.8.4 → 3.8.5.
- **v3.8.4** — May 3, 2026 — Tuition-B1.3: Projected Discounts consolidation + section subtotals + accounting parentheses convention. Pure UI restructure — no schema, no new RPCs, no math identity changes. One number-formatter update; one new helper in `tuitionMath.js` (`computeTuitionFeesSubtotal`). (1) **Projected Multi-Student Discount relocation** from the foot of the Tier Rates section (its v3.8.3 placement) to be the first row of the Projected Discounts section. The four-stream discount taxonomy from §7.3 is the architectural commitment; splitting Multi-Student visually undermined the model. Spreadsheet vocabulary (legacy AYE26 lines 34–38) lists Multiple Student first; Agora now matches that order. Multi-Student renders read-only at Stage 1 (computed from tier math) with no input chrome; standard row typography matching the three editable peers. The B1.2 subtotal block + horizontal rule at the Tier Rates table foot are removed entirely; "+ Add tier" becomes the last visible element in that section. (2) **Tuition Fees section subtotals** added at the section foot: `Per-Student Fees Subtotal` (italic muted, indented, no top rule) = `(curriculum_fee + enrollment_fee) × total_students`; `B&A Revenue Subtotal` (italic muted, indented, no top rule) = `b_a_hourly_rate × projected_b_a_hours`; `Tuition Fees Subtotal` (bold, navy@25 thin top rule, flush left) = sum of the two component subtotals with null-handling that treats one missing component as zero only if the other has a value (so a partially-populated section carries the present value through; both null → null em-dash). New helper `computeTuitionFeesSubtotal(scenario)` in `tuitionMath.js` centralizes the null-handling. (3) **Total Projected Discounts subtotal** added at the Projected Discounts section foot — bold, navy@25 thin top rule, parenthesized. Mirrors the sidebar's Total Projected Discounts stat exactly (same value, same `subtractive: true` formatter setting). (4) **Universal accounting parentheses convention for subtractive currency values** (new architecture §10.12). Discount values, the Total Projected Discounts subtotal at the section foot, and the sidebar Total Projected Discounts stat all render as `($X,XXX)`. Negative currency values anywhere on the page render with parens automatically (e.g., Net Projected Ed Program Revenue if it ever goes negative). The `-` character is never rendered for currency values; parens replace it universally. New helper `formatCurrency(value, options)` in `src/lib/format.js` accepts a `subtractive` boolean (default false): when true, always renders parens; when false, parens only when value < 0. The helper is conservative — `subtractive: true` applies only to discount-context surfaces; the rest of the codebase keeps its existing formatters and gets the negative-value-triggers-parens path as a free upgrade if currency rendering ever passes through `formatCurrency`. (5) **Editable input fields with parens display** keep the existing direct-edit-with-undo pattern (B1) — display-state button shows `($53,655)`, focus reverts to a plain numeric editable string (no `$`, no commas, no parens) for direct entry, blur returns to the parens display. Input parsing tolerates `$/,/() /space` characters silently so users can paste from spreadsheets that use parens for display. (6) **Section help paragraph copy updates**: Projected Discounts section opens "All four discount mechanisms in the layered taxonomy. Multi-Student is computed from tier math; the other three are user-entered envelope estimates" (replacing the prior "Three of the four discount mechanisms" since Multi-Student now renders here). Tuition Fees section opens "...applies to projected hours at Stage 1; Stage 2 audit captures the actual hours" (replacing the v3.8.2 phrasing that did not yet acknowledge Stage 1's projected hours). (7) **Architecture doc**: §7.3 "Stage 1 revenue vocabulary" subsection extended with a "Visual consolidation (v3.8.4 / B1.3)" addendum codifying the four-discount-stream consolidation in the Projected Discounts section and the Tuition Fees grand subtotal. New §10.12 "Accounting parentheses convention for subtractive currency values" codifies the universal pattern, the `formatCurrency` API, and the spreadsheet-vocabulary alignment. Appendix C: new "Accounting parentheses convention for subtractive currency values" decision row. Document header bumped 3.8.3 → 3.8.4.
- **v3.8.3** — May 3, 2026 — Tuition-B1.2: Net Projected Ed Program Revenue + B&A hours + Multi-Student Discount stream. Four real-data refinements that earned their own commit on top of v3.8.2 (B1.1). Migration 028 lands the schema piece; the frontend lands the UX piece. (1) **Multi-Student Discount surfaces as the fourth discount stream** alongside Faculty / Other / Financial Aid. Vocabulary aligned with Libertas's legacy AYE 2026 spreadsheet (lines 34–38: Multiple Student / Faculty / Other / Financial Aid — Multi-Student is the first discount line, not a tier blending artifact buried inside gross revenue). Gross Tuition is now base × headcount everywhere in Agora; tier blending shows up exclusively as the Multi-Student discount line. This forces all downstream math to use a consistent gross definition and makes the projection-vs-actual gap explicit per the §7.3 "Stage 1 projection vs. Stage 2 actual" subsection. New schema column `projected_multi_student_discount numeric(12,2)` on scenarios + snapshots; persisted on every save that touches its inputs (tier_rates, total_students, estimated_family_distribution, top_tier_avg_students_per_family) as the at-save snapshot of the math. New table-foot subtotal row in the Tier Rates section labels the value "Projected Multi-Student Discount" with help text "Computed from tier math. Stage 2 audit captures the actual realized discount per family." Read-only by definition; renders in all states with em-dash when inputs are insufficient. (2) **Net Projected Ed Program Revenue promoted from Tuition-C to B1.2** as the load-bearing operational KPI ("are we at 102% of expenses?"). Gross Projected Ed Program Revenue (= Projected Gross Tuition + curriculum + enrollment + B&A revenue) added alongside per real-data review — the user wants both numbers visible, not just the net. The stats sidebar grows from four to six stats; Net Projected Ed Program Revenue renders with visual emphasis (~1.15× value typography) within the stats column. The `Stat` subcomponent gains an `emphasized` prop (default false) for this; the data-driven sidebar contract from B1 is otherwise unchanged. (3) **Projected B&A hours input** added — fiscal directors budget B&A revenue annually, and the legacy spreadsheet captured this as a hand-set estimate. Agora captures it the same way at Stage 1 with Stage 2 audit picking up actual hours via the existing `actual_before_after_school_hours` column. New schema column `projected_b_a_hours int` on scenarios + snapshots. UI renders as a sub-line beneath the B&A hourly rate row in the Tuition Fees section, indented at the four-tier hierarchy's leaf rhythm; help text clarifies "Estimate total B&A hours across all enrolled students. Stage 2 audit captures the actual hours." Saves separately from the hourly rate; nullable column accepts the user clearing the field. (4) **Vocabulary cleanup**: "Projected Gross at Tier 1" → "Projected Gross Tuition" (sidebar label rename; the math identity `tier_1_rate × total_students` is what the renamed label now means). "Total Projected Discounts" sublabel updates from "Faculty + Other + Financial Aid" to "Multi-Student + Faculty + Other + Financial Aid" reflecting the new four-stream taxonomy. (5) **Architectural decision: client-side computation in `tuitionMath.js` for instant feedback during Stage 1 iteration**; server-side hoist into `compute_tuition_scenario_kpis` RPC deferred to Tuition-C when the round-trip cost amortizes across multiple KPIs (break-even enrollment count, net education program ratio vs locked Budget, YoY comparison). Persisted column `projected_multi_student_discount` is written from the client-computed value on save for snapshot fidelity — the lock RPC reads this stored value rather than recomputing, so if math evolves between save and lock, the snapshot reflects the at-save value (which is what the user committed to). (6) **`tuitionMath.js` extensions**: seven new pure functions with strict null propagation — `computeProjectedGrossAtTier1`, `computeTierBlendedTuition`, `computeProjectedMultiStudentDiscount`, `computeProjectedBARevenue`, `computeProjectedFeeRevenue`, `computeProjectedEdProgramRevenue`, `sumTotalProjectedDiscounts`, `computeNetProjectedEdProgramRevenue`. All take the full scenario object; return null when core inputs are insufficient (so a fresh scenario surfaces "not yet entered" honestly rather than a misleading zero). Faculty / Other / FA discounts and fees default to 0 when null (per the B1.1 schema defaults); B&A revenue defaults to 0 when null (legitimately zero for some schools); Multi-Student Discount, Gross Tuition, and Total Students propagate null because the absence is meaningful. (7) **Architecture doc**: §7.3 schema block extended; new "Stage 1 revenue vocabulary" subsection codifies the four-stream taxonomy and the gross-is-base × headcount rule; new "Stage 1 projection vs. Stage 2 actual" subsection codifies the variance-as-calibration-signal model and the deliberate refusal to make Stage 1 projection match Stage 2 actual. Appendix B Migration 028 entry. Appendix C: two new decision rows ("Stage 1 KPI computation locus", "Multi-Student Discount as fourth discount stream"). Document header bumped 3.8.2 → 3.8.3.
- **v3.8.2** — May 2, 2026 — Tuition-B1: Stage 1 (Tuition Planning) configuration UI. The placeholder `TuitionWorksheet.jsx` from v3.8.1 is replaced with the production page; eight new components in `src/components/tuition/` plus a small seed-defaults helper in `src/lib/tuitionDefaults.js` deliver the multi-scenario shell, four configuration sections, fresh-start setup gateway, and data-driven stats sidebar. No schema changes (Migration 022 already provides everything). No lock workflow, no PDF, no Stage 2 affordances — those ship in Tuition-D / Tuition-E / Tuition-B2. (1) **Setup gateway scope deviation**. The Tuition module deviates from the universal three-option setup gateway pattern documented in CLAUDE.md "Module workflows and stages." `TuitionEmptyState.jsx` shows a single "Create first scenario" button — fresh-start only. Bootstrap-from-prior is deferred until the AYE 2027 cycle: no prior locked Tuition Planning snapshot exists yet (AYE 2026 is the first cycle in which Tuition runs as a module). CSV import is permanently skipped — Tuition's data shape (4 tier rows + 3 fees + N family-distribution rows) is too small to warrant a CSV format; module authors of future modules with similarly small data shapes should consider this precedent. The empty-state copy explicitly notes both choices so users understand the trade-off. (2) **Three-zone layout** parallel to BudgetStage (architecture §8.1). Sticky header reads "AYE 2026 Tuition Planning · DRAFTING" with the AYE label and stage display name pulled dynamically from `module_workflow_stages.display_name` per CLAUDE.md "Module workflows and stages" — never hardcoded. Configuration zone in the middle hosts the four sections in order: Tier rates, Per-student fees, Discount envelopes, Projected family distribution. Right-side stats sidebar mirrors Budget's `KpiSidebar` exactly (navy panel, collapsibility with chevrons ◂ collapsed inward / ▸ expanded outward, localStorage key `agora.tuitionStatsSidebar.collapsed`). (3) **Data-driven `StatsSidebar` from inception**. The component accepts a `stats` prop array of `{ key, label, value, format, subtitle?, target?, comparison?, status? }` rather than hardcoded KPI fields. Tuition-B1 passes four direct-sum stats (projected gross at Tier 1, total discount envelopes, projected families, projected students). Tuition-C will swap in computed KPIs (break-even enrollment count, net education program ratio, year-over-year comparison) without component rewrite — the parent simply passes a richer array with `target` / `comparison` / `status` fields and the sidebar renders the indicator pill / status icon when present. The optional fields stay dormant in B1. This is the architectural commitment for "build sidebars data-driven so subsequent KPI work is a parent-side change, not a sidebar rewrite." (4) **Multi-scenario shell** parallel to Budget. Tabs render with ★ recommended marker, kebab menu (Mark as recommended / Rename / Edit description / Delete with confirmation). "+ New scenario" opens `TuitionNewScenarioModal` with two paths: copy-from-current (small-diff alternates — copies all configuration fields including tier_rates and estimated_family_distribution) or start-fresh (zeroed defaults). Bootstrap-from-prior path absent here mirroring the empty-state deviation. Auto-name fallback: when label is blank, modal queries scenario count and assigns "Scenario N+1." (5) **Tier Rates section** — dynamic tier count with add / remove. UI rule: `tier_count` is computed from `tier_rates.length`, never directly editable. Add and remove operations modify `tier_rates` AND `estimated_family_distribution` atomically (both arrays must stay in sync — the projection table reads tier rows from tier_rates). Tier 1 is permanent; the highest-tier row's label uses "X+" framing. Removing a tier with non-zero values requires confirmation. (6) **Fees section** — three currency fields (curriculum, enrollment, B&A hourly rate). The B&A rate uses two-decimal currency formatting (per-hour rates are typically expressed as $15.00 not $15); the per-student fees use whole-dollar formatting matching Budget. (7) **Discount Envelopes section** — three rows (faculty discount %, other envelope, FA envelope). Each row carries inline help text linking the Stage 1 configuration to Stage 2 per-family allocation per architecture §7.3. (8) **Family Distribution section** — table of tier rows (derived from tier_rates) with editable family_count plus computed Total families and Total students rows in Tier 2 weight. The "X+" tier is treated as exactly X for B1 student totals; refined in Tuition-C if break-even math needs it. (9) **Direct-edit-with-undo** mirrors Budget's editing pattern (architecture §8.3). Click any amount → inline numeric input → Enter or blur saves; Escape cancels. Optimistic UI: local state updates immediately, then Supabase write; on error, revert and surface via toast. Save button in the header is a confidence affordance (toast confirms persistence), not a gate. (10) **Permission gating** via `useModulePermission('tuition', 'view'|'edit')`. Read access requires view; field edits and scenario operations require edit. Read-only mode cascades to every section: input chrome disappears, values render as plain text, "+ Add tier" / "× remove" affordances vanish. State-aware rendering: `drafting` is editable; `pending_lock_review` and `locked` are read-only with explanatory banners (only `drafting` is reachable in B1, but read-only paths are stubbed-in so Tuition-D drops in cleanly). (11) **Recent Activity link rendered as a stub** with explanatory tooltip. The activity-log query helper (`src/lib/auditLog.js`'s `fetchScenarioActivity`) is hardcoded to Budget's table names today; generalizing it for tuition tables is a Tuition-D follow-up. The link is rendered as disabled with a tooltip rather than omitted entirely so the placement convention from Budget carries forward to where the wired-up version will land. (12) **Stage resolve via module/workflow/stage join**. The page reads `module_workflow_stages` joined to `module_workflows` and `modules` filtered by `code = 'tuition'` and `stage_type = 'preliminary'` to find the active Tuition Planning stage. The route is `/modules/tuition` (no stageId in URL — there's only one Stage 1 to mount); Tuition-D's audit page will be at a separate route. (13) **Architecture doc**: Appendix C adds the "Tuition setup gateway scope" decision row referencing the deviation; document header bumped 3.8.1 → 3.8.2.

  **B1.1 follow-on** (May 3, 2026) — six real-data refinements surfaced during the in-browser walkthrough of B1 against actual Libertas AYE 2026 numbers. Schema-touching polish session within the same v3.8.2 label. Migration 027 (see Appendix B for the full enumeration) lands the schema piece; the frontend lands the UX piece. (a) **Family-distribution input model reframe** — instead of "input family counts directly," the user enters `total_students` plus per-tier `breakdown_pct`, and `total_families` derives from `total_students ÷ weighted-avg-students-per-family`. The user can override `total_families` when their projection is more specific; an "↻ revert to derived" affordance clears the override. Per-tier `family_count` becomes application-derived and is written to the jsonb on save so downstream reads remain self-consistent. The reframe matches how fiscal directors natively cast enrollment projections (Jenna's legacy spreadsheet uses exactly this shape). New §7.3 subsection "Stage 1 family-distribution input model" documents the math and the override semantics. New Appendix C decision row captures the input-model choice. (b) **Top-tier "X+" bucket refinement** — the "4+" tier may include families with 4, 5, or more students. New `top_tier_avg_students_per_family numeric(4,2)` column on scenarios refines the projection; defaults to top tier_size when null; DB validator enforces the value is ≥ top tier_size. The input lives below the breakdown table (deliberate — separating the row-level breakdown from the bucket-shape parameter); UI help text explains the semantics. (c) **Faculty-discount Stage 1 reframe** — Stage 1 budgeting input moves from "% of gross" (computed) to "$ projected" (entered). New `projected_faculty_discount_amount numeric(12,2)` column captures the user's deliberate $ projection. The existing `faculty_discount_pct` column persists in schema (Stage 2 per-family allocation math still needs it) but does NOT render in the Stage 1 UI as of v3.8.2. (d) **Vocabulary cleanup**: "envelope" → "projected." Two column renames on scenarios + snapshots: `other_discount_envelope` → `projected_other_discount`; `financial_aid_envelope` → `projected_financial_aid`. UI section header "Discount Envelopes" → "Projected Discounts"; the file moves from `DiscountEnvelopesSection.jsx` to `ProjectedDiscountsSection.jsx`. (e) **Tier Rates Discount column** — new column between Family Size and Per-Student Rate showing each tier's percentage off the Tier 1 rate; muted italic, computed read-only. Tier 1's row gets a "BASE" badge in the tier-number column instead of "1" — Tier 1 is the reference rate against which discounts are computed; the badge makes the relationship explicit. (f) **Section header rename**: "Per-Student Fees" → "Tuition Fees." The Before & After School Care line is hourly, not per-student — the original B1 section name was over-specified. (g) **Stats sidebar formula refresh**: Projected Gross at Tier 1 now reads `total_students × tier_1_rate` directly (instead of Σ tier_size × family_count); "Total discount envelopes" → "Total projected discounts" (now sums all three projected $ fields including faculty); Projected Families and Projected Students read directly from the new column fields. Stats render em-dashes when underlying inputs are null (rather than zero) so a fresh scenario surfaces "not yet entered" honestly. The data-driven `StatsSidebar` component itself is unchanged — only the parent's stat array shape changes. (h) **DB validators**: `tg_validate_tuition_scenario` BEFORE INSERT/UPDATE trigger enforces breakdown_pct sum = 100 ± 0.01 when both total_students and breakdown sum are non-trivial (the strict "when total_students is set" semantics from the spec was relaxed by 0.01 in practice — see Migration 027 entry for rationale on the relaxation: on-blur-save UX would otherwise fight users mid-data-entry; the UI buffers breakdown edits locally until valid). Top-tier-average validator enforces ≥ top tier_size when set. (i) **`faculty_discount_pct` preserved in schema** — explicitly NOT cleaned up despite being unreferenced by B1.1 UI. The column returns when Stage 2 (Tuition Audit) per-family allocation math ships in B2 / D. (j) **Direct-edit-with-undo respected throughout** — every new field (total_students, total_families, top_tier_avg, breakdown_pct, projected_faculty_discount_amount) saves on blur. Breakdown_pct edits buffer locally in `FamilyDistributionSection` until the sum is valid (100 ± 0.01) OR cleared to zero, then push to the parent. (k) **State-aware rendering** for non-drafting states: read-only mode omits input chrome on every new affordance; the override revert button hides entirely. (l) **Pull-from-prior-AYE-snapshot path** captured as architectural intent for AYE 2027+ cycles. Three preconditions before the path can ship: (i) AYE 2027 cycle started; (ii) Tuition-D shipped (lock workflow); (iii) AYE 2026 Tuition Audit locked, producing the prior-cycle snapshot to seed from. Implementation is a follow-up commit when the preconditions converge. (m) **Manual entry of prior-AYE actuals for new-school onboarding** captured as queued architectural commitment. Implementation likely lives in the school onboarding flow (Phase 1 work) rather than the Tuition module proper — when a new school onboards, they need a path to enter the prior cycle's actuals as a one-time seed so YoY comparison and bootstrap-from-prior have something to read. The shape of that surface is undecided; documented here as a known need.
- **v3.8.1** — May 2, 2026 — Tuition-A2: schema and lock/unlock workflow RPCs. Database-layer realization of the v3.8 architectural keystone. Five migrations (022–026) plus an AppShell sidebar lockKey rename + a placeholder TuitionWorksheet.jsx page (the legacy display page's source tables were dropped). No production UI work; the configuration UI for Stage 1 and the per-family detail editor for Stage 2 ship in Tuition-B as a separate session. Pre-flight: user-confirmed count check on legacy `tuition_worksheet` and `tuition_scenarios` tables (both empty; CASCADE-drop safe). (1) **Migration 022** (`create_tuition_worksheet_schema`): drops legacy tables; renames `modules.code` 'tuition_worksheet' → 'tuition' (parallel to Migration 011's `preliminary_budget` → `budget` rename — `user_module_permissions` rows survive via FK by id); seeds the Tuition module workflow with two stages (`Tuition Planning` preliminary, `Tuition Audit` final — judgment call to reuse the existing stage_type catalog rather than introducing new types per v3.8 §7.3); creates `tuition_worksheet_scenarios` mirroring `budget_stage_scenarios`'s shape plus the §7.3 layered-discount-taxonomy fields; creates `tuition_worksheet_family_details` for Stage 2 per-family rows. Three layers of integrity enforcement: CHECK constraints on the unlock workflow (mirroring 016 + 020), partial unique index for one-locked-recommended per (aye_id, stage_id), and triggers — `tg_unlock_only_when_locked` reused from 016; `tg_enforce_tuition_stage_2_immutability` is the new DB hard guard for §7.3 (tier_count, tier_rates, faculty_discount_pct, and the three fee rates cannot change in a Stage 2 scenario; raises with the field names changed); `tg_check_tuition_family_details_stage` blocks family detail rows on Stage 1 scenarios; sibling-lock guards parallel to 015 (dedicated tuition copies because 015's functions reference `budget_stage_scenarios` by name in their SELECTs). RLS gates view/edit; family details additionally require `can_view_family_details`. `change_log_read` policy rebuilt — drops the legacy 'tuition_worksheet' / 'tuition_scenarios' arms, adds new arms for the four new tuition tables (family-detail arms include the `can_view_family_details` redaction check parallel to `enrollment_audit_families`). `locked_via` left unconstrained at the column level (mirrors Budget; lock RPC validates the value at function level — Budget uses `('normal', 'override')`, Tuition uses `('cascade', 'override')` per the prompt's spec). (2) **Migration 023** (`create_tuition_worksheet_snapshots_schema`): snapshot tables `tuition_worksheet_snapshots` and `tuition_worksheet_snapshot_family_details`. All configuration captured by value at lock time (tier rates, fees, envelopes); nine KPI columns computed at lock and stored (gross tuition, multi-student / faculty / other / financial-aid discount totals, three fee revenue lines, net education program revenue); locker / approver names captured by value (ON DELETE SET NULL on `locked_by` / `approved_by` UUIDs preserves render-correctness if user rows are later deleted); stage display name + short name + type captured at lock per §5.1 binding rule; immutability via `tg_prevent_snapshot_update` (reused from 011). RLS: read on view; INSERT requires submit_lock (lock RPC's snapshot capture path). (3) **Migration 024** (`tuition_worksheet_lock_workflow_functions`): four functions. `compute_tuition_scenario_kpis(scenario_id)` is a stable function returning the nine KPIs from the scenario's configuration plus (Stage 2 only) family detail rows; deterministic. Walks `tier_rates` jsonb and `estimated_family_distribution` jsonb for Stage 1 projection math; walks `tuition_worksheet_family_details` for Stage 2 actuals math; same shape returned in both cases for downstream parity. `submit_tuition_scenario_for_lock_review(scenario_id)` validates submit_lock + drafting + is_recommended + no sibling locked; transitions to `pending_lock_review`. `lock_tuition_scenario(scenario_id, locked_via, override_justification)` validates approve_lock + pending state + is_recommended + valid `locked_via` ('cascade' or 'override') + override-has-justification. Captures stage and AYE metadata; computes and stores KPIs; copies Stage 2 family detail rows into the snapshot family detail table; flips state to `locked`; returns snapshot id. `reject_tuition_scenario_lock(scenario_id, reason)` validates approve_lock + non-empty reason; transitions back to `drafting`. Judgment call: Tuition has dedicated submit and reject RPCs whereas Budget handles those via direct client UPDATEs in `src/lib/budgetLock.js` — server-side authorization on every state transition is the stricter pattern, appropriate for a module whose lock triggers downstream contractual commitments to families. Cross-module cascade per §7.5 NOT enforced inside the Tuition lock function; the cascade integration with Budget's lock function is a follow-up commit. (4) **Migration 025** (`tuition_worksheet_unlock_workflow_functions`): three SECURITY DEFINER functions implementing the v3.7 two-identity unlock model on Tuition, parallel to Budget's Migration 021. `request_tuition_scenario_unlock` requires approve_unlock; atomically populates request + approval_1 fields from the caller. `approve_tuition_scenario_unlock` returns void; two-UPDATE pattern preserves the audit trail of who approved second before the unlock fields clear. `reject_tuition_scenario_unlock` handles both reject and withdraw paths via caller-vs-requester branch detection. (5) **Migration 026** (`create_tuition_scenario_from_snapshot`): parallel to Migration 019's Budget version. Validates: caller has edit on Tuition; target stage is Stage 2 (`stage_type = 'final'`); source snapshot is a Stage 1 lock (`stage_type_at_lock = 'preliminary'`); same workflow + same AYE + predecessor sort_order. Copies ALL configuration fields from snapshot to new Stage 2 scenario. The Stage 2 immutability trigger fires on UPDATE not INSERT, so locked-from-edit fields populate freely at INSERT. No per-family detail rows seeded — family detail is the operational substance of the audit. Tags `app.change_reason = 'created_from_snapshot: <id>'` for permanent audit linkage. (6) **Application surface changes**: `src/components/AppShell.jsx` Tuition collapsible parent's `lockKey` updated from `'tuition_worksheet'` to `'tuition'` (matches the renamed module code). `src/lib/budgetLock.js` `humanModuleLabel` map updated: `'tuition_worksheet' → 'Tuition Worksheet'` removed in favor of `'tuition' → 'Tuition'`; `'enrollment_audit'` removed (it's Tuition Stage 2 per v3.8). `src/pages/modules/TuitionWorksheet.jsx` replaced with a 30-line placeholder ("Schema landed · UI in Tuition-B") so the `/modules/tuition` route does not 500 — the previous implementation queried the legacy tables that Migration 022 dropped. (7) **Architecture doc updates**: Appendix B implemented list extended with detailed entries for Migrations 022–026; needed migrations renumbered 022–026 → 027–032 (Strategic Plan / Snapshot tables for Staffing+Enrollment / Board Composition / KPI registry / Module mappings / Workflow Config UI). Document header bumped 3.8 → 3.8.1. (8) Build verified clean (`npm run build`). All five migrations run successfully against live DB (per validation step in commit). Live data integrity preserved: Budget Final Budget Scenario 1 (drafting state, 77 lines) and Preliminary Budget Scenario 1 (locked, snapshot 64cfda0c) untouched.
- **v3.7.1** — May 2, 2026 — Module-scoped governance authority codification (follow-up to v3.7). Small fix surfaced when reviewing the v3.7 modal copy: `RequestUnlockModal` still carried stale paragraph copy referencing the obsolete three-identity model ("two distinct approvers, other than you"). Replaced with two-identity-model copy that names the canonical fiscal authority for the Budget module: "Submitting records your approval as the first of two. Treasurer (or designee) must confirm to complete the unlock of {scenario_label}. The locked snapshot remains in audit history; this only reopens the live working copy." Audit of the other unlock-flow components (`ApproveUnlockModal`, `RejectUnlockModal`, `WithdrawUnlockModal`, `LockedBanner`) confirmed they were already clean — no remaining three-identity references. (1) **New §3.5 "Module-scoped governance authority in lock/unlock workflows"** codifies the principle that lock/unlock system mechanics are uniform across modules but the canonical governance authority named in user-facing copy is module-specific. Budget names "Treasurer (or designee)" because it is fiscal; future Strategic Plan would name "Board Chair (or designee)" because it is governance; an Accreditation module would name "Head of School (or designee)" because it is curricular. The "or designee" trailer keeps the same string portable across role rotations and ad-hoc designation fallbacks. The system enforces only the permission grant (`approve_unlock`) and the distinct-identity constraint between requester and approval_2; the procedural mapping of which user holds the named role is school-level configuration, not a system rule. (2) **Renumbering**: existing §3.5 (Cross-module data flow) → §3.6, §3.6 (Custom KPI registry per school) → §3.7, §3.7 (Module workflows and stages) → §3.8. Cross-references updated throughout the architecture doc (one in §3.4, one in §5.1's snapshot schema comment, one in §8 module intro, one in Appendix B's settings discussion, one in §12 Phase 2 phase-list, one in Appendix C's "Module workflows" decision row), in `CLAUDE.md` (Module workflows paragraph), and in Migration 019's header reference list. (3) **§8.13 extended** with a "Module-scoped governance authority for the Budget module" paragraph explicitly naming Treasurer (or designee) as the second approver and documenting Libertas's procedural mapping: HoS as typical requester, Treasurer as typical second approver, Board Chair as designee fallback. The paragraph cross-references §3.5 so future readers find both the principle and the Budget-specific instance. (4) **Appendix C "Unlock permission tier"** decision row updated to capture the module-scoped authority pattern alongside the existing permission-grant mechanics; section reference extended to `3.5, 8.13`. No code changes beyond the modal copy. No schema changes. No new RPCs.
- **v3.6** — May 1, 2026 — Phase 2 polish session: items surfaced during the Final Budget end-to-end exercise. Six refinements + one copy fix; no schema changes, no new RPCs. (1) **Four-tier hierarchical treatment in-app** (architecture §10.4 extended). The four-tier system originally codified for PDF rendering now applies to in-app `BudgetDetailZone`. Tier 1 categories at Cinzel 17px with gold border-bottom; Tier 2 top summaries at 15px semibold with navy@25 border-bottom; Tier 3 mid summaries at 13.5px medium; Tier 4 leaves at 13px navy@85 with the account code in 11px navy@55. Hierarchy reads strongly even in locked state, where the input chrome is gone. Editable input fields on Tier 4 leaves coexist without competing — input chrome reads as "you can change this," strengthened typography reads as the structural backbone. Applies to drafting and locked, Preliminary and Final. (2) **Per-line clock icon suppression in locked state** (§9.1 extended). The audit-history affordance that opens `LineHistoryModal` is now hidden when scenario state is locked. Per-line drilldown is editing-mode functionality; the activity feed remains the comprehensive surface for locked-state audit exploration. New `hideLineHistory` prop on `BudgetDetailZone` threaded down through the row tree. (3) **Recent Activity affordance relocation**. The cream-highlight bordered banner above the budget detail (which competed with the Income heading) is removed. Replaced by a right-aligned text link in the scenario tabs row reading simply "Recent Activity" — no counter, no parenthetical. Click opens the activity feed in a modal. `ActivityFeedPanel` renamed to `ActivityFeedModal`; internal feed UI (count/filter dropdowns, FeedRow list, PDF export) unchanged from the prior inline-panel version — only the shell changed (panel → modal). The pattern matches `LineHistoryModal` / `SubmitLockModal`. (4) **DRAFT treatment uniform across print routes** (§5.3 extended; this was already implemented but had not been codified in the doc). PrintShell renders the watermark + running banner + footer note when `draft={true}` is passed; all three print routes already pass `draft={scenario.state !== 'locked'}`. The doc note clarifies the rule generally so the next print-route addition naturally inherits the same behavior. (5) **Audit log PDF density** tightened. Body text dropped from 11pt to 8.5–9.5pt; tighter line-height (`leading-snug`); tighter row padding. Audit log PDFs now read as reference documents (think SEC filing exhibit) rather than presentation pieces. Justification and reason text remain at full content (no truncation, §9.1 commitment). The two document classes (Operating Budget Detail vs. audit logs) share `PrintShell` letterhead/footer/page-break/DRAFT treatment; only body density differs. (6) **Predecessor card whitespace fix on Final Budget setup**. The `KpiRow` `flex justify-between` (which pushed label far left and amount far right inside each grid cell) replaced with `inline-flex gap-1.5` (label and amount sit close as a connected unit), with the three pairs sharing a horizontal flex row separated by `gap-x-5`. Now reads "Income $1,237,983 · Expenses $1,277,758 · Net -$39,775" rather than three label-value-far-apart blocks. (7) **Sibling-locked banner copy fix**. Removed redundant leading "Scenario " word in three places: the in-app sibling-locked banner in `BudgetStage`, the Submit-button tooltip in `BudgetStage`, and the hardBlock failure message in `budgetLock.js` (which surfaces inside `SubmitLockModal`). All three suffered from the same `Scenario "${scenario_label}"` interpolation pattern producing "Scenario Scenario 1 is currently locked..." Now the interpolated scenario label carries the noun.
- **v3.5** — May 1, 2026 — Phase 2 follow-on: Final Budget setup gateway, canonical naming of locked artifacts, formal-tone copy convention. Pre-demo session addressing six gaps surfaced during review of the Final Budget surface. (1) **Final Budget setup gateway** (architecture §8.14, new): `BudgetStage` setup view now branches on whether the active stage is the first in its workflow. First stages keep the original three-option flow (`BudgetEmptyState`); non-first stages render a new `PredecessorSelector` showing locked predecessor snapshots as cards (working scenario name from the snapshot, lock date, locker, KPI totals), or a friendly empty state with a link back to the predecessor stage when none exists. The conceptually-wrong "fresh start / CSV import" path no longer surfaces on Final Budget. Card click opens a new `SeedFromPredecessorModal` confirmation modal. (2) **Migration 019** ships `create_scenario_from_snapshot` SECURITY DEFINER RPC: validates predecessor relationship (lower `sort_order`, same `workflow_id`, same AYE), inserts new drafting scenario, copies snapshot lines into `budget_stage_lines` (skipping any with `account_id IS NULL` from prior hard-deletes), tags `app.change_reason` as `'created_from_snapshot: <snapshot_id>'` for permanent audit linkage. (3) **Canonical naming of locked artifacts** (architecture §8.15, new): new `src/lib/scenarioName.js` exposes `getCanonicalLockedArtifactName(aye, stage, fallback)` and the dispatch helper `getDisplayNameForContext(context, refs)`. Locked artifacts now display canonical computed name (`{school} {aye_label} {stage_display_name}`, e.g. "Libertas Academy AYE 2026 Preliminary Budget") in the Operating Budget Detail PDF letterhead (locked variant only) and the LockedBanner heading (all three locked-state variants, since artifact identity does not change while unlock is pending). Working-tool surfaces — scenario tabs, audit-log entries, drafting-mode UI — continue to use the working scenario label. Render-time computation only; no schema change, no snapshot data backfill. (4) **`src/lib/schoolConfig.js`** new: extracts the hardcoded `"Libertas Academy"` school name into a single source of truth referenced by both PrintShell and the canonical-name helper. When multi-tenancy lands and the school name moves to `school_brand_settings`, only this file changes. (5) **Formal tone convention** (architecture §10.11, new): codebase-wide audit of user-facing strings; contractions replaced with full forms ("is not" not "isn't", "cannot" not "can't", "you are" not "you're", etc.). Captured user input exempt; code comments and identifiers exempt. Twelve user-facing strings updated across 9 files (BudgetStage, SubmitLockModal, CoaManagement, AYEManagement, TuitionWorksheet, three print pages, AutoDetectBanner, ImportExportPanel, plus two strings in the unlock validator's exported reason-copy map that used typographic curly apostrophes — those were missed by the initial ASCII-apostrophe sweep until a follow-up Unicode-aware grep caught them). One judgment call: `aria-label="Why can't I delete this?"` was rewritten as `aria-label="Why can I not delete this?"` rather than mechanically expanded as `"Why cannot I delete this?"` (which reads awkwardly even formally) — minor reordering preserves natural English. No phrases were rephrased entirely; mechanical expansion read fine in every other case. (6) **BudgetEmptyState copy cleanup**: removed the redundant "You're working on AYE [year]. Switch above if this isn't the right year." line (the AYE selector above is sufficient identification; the line both repeated and used contractions). (7) **CLAUDE.md** updated with formal-tone paragraph (under user-facing copy conventions) and stage-initialization gateway sub-bullet (under Module workflows and stages). (8) **Architecture doc**: §3.4 extended with stage-initialization-cascade paragraph distinguishing it from the lock-cascade rules; new §8.14, §8.15, §10.11; Appendix B adds Migration 019 to implemented and renumbers needed Migrations 019→020 through 024→025; Appendix C adds three decision rows.
- **v3.4** — May 1, 2026 — Phase 2 Session H2: unlock workflow (UI layer). Application validator + UI layers complete the three-layer enforcement model started in H1. (1) **`src/lib/budgetUnlock.js`** is a pure/sync helper module mirroring `src/lib/budgetLock.js` in structure: `canRequestUnlock`, `canApproveUnlock`, `canRejectUnlock`, `canWithdrawUnlock`, plus `validateUnlockRequest` / `validateUnlockRejection` / `validateUnlockWithdraw` that wrap the gates with min-length text-content validation. `getUnlockBannerState(scenario)` is the single source of truth for which of three banner states to render. All `can*` helpers return `{ok: true}` or `{ok: false, reason: '<short_code>'}`; `UNLOCK_REASON_COPY` exports the user-facing copy map so wording lives in one place. **Permission shape divergence from prompt:** the prompt assumed a permission-level string + client-side hierarchy comparison; the actual codebase pattern is `useModulePermission(...)` returning `{allowed: bool}` per gate (server-side `>=` via `current_user_has_module_perm`). Helpers take pre-evaluated booleans (`hasSubmitLock`, `hasApproveUnlock`) accordingly. (2) **`LockedBanner` extended** to morph through three states based on `unlock_requested` and `unlock_approval_1_at`. State 1 (no request) keeps existing production behavior plus a "Request unlock" button. States 2 and 3 use amber treatment with full justification text rendered inline (no truncation — §9.1 commitment, parallel to override events) and action buttons gated by helper outcomes; the Approve button is rendered as disabled-with-tooltip when initiator-separation blocks the user, so they understand the rule rather than wondering where the affordance went. (3) **Four new modals** in `src/components/budget/`: `RequestUnlockModal`, `ApproveUnlockModal`, `RejectUnlockModal`, `WithdrawUnlockModal`. All match the `SubmitLockModal` pattern. ApproveUnlockModal title and copy adapt to first-of-two vs final approval (the final-approval modal emphasizes the state-transition consequence). RejectUnlockModal uses destructive button styling; WithdrawUnlockModal uses muted/secondary styling — both call the same `reject_budget_stage_unlock` RPC; H1's function auto-detects withdraw vs reject via caller-vs-requester comparison. (4) **Audit log integration**: `src/lib/auditLog.js` `classifyEvent` extended with five new kinds (`unlock_requested`, `unlock_first_approval`, `unlock_completed`, `unlock_rejected`, `unlock_withdrawn`), detected via `change_log.reason` signatures BEFORE field-based heuristics (necessary because `unlock_completed` transitions state `'locked'` → `'drafting'` which would otherwise misclassify as `'edit'`). New `extractUnlockReasonText` helper pulls the user's reason text from the `'unlock_rejected: <text>'` / `'unlock_withdrawn: <text>'` reason markers. `summarizeEvent` humanizes each kind with inline reason text; visual treatments added to `LineHistoryModal`, `ActivityFeedPanel`, `BudgetActivityPrint`, `BudgetLineHistoryPrint` — amber for in-progress, blue with 🔓 for `unlock_completed` (mirrors lock 🔒 — governance milestones at the symmetric ends of the cycle), red-muted for rejected, plain muted for withdrawn. (5) **`BudgetStage` wired**: extended scenario SELECT to include the eight `unlock_*` columns, added `useModulePermission('budget', 'approve_unlock')` hook call, single `unlockModal` state controls which (if any) of the four modals is open, modals share a single `handleUnlockModalSuccess` that closes and refetches via the existing `loadAyeContext` pattern. (6) **Architecture doc**: §8.13 extended with two new subsections ("Application validator layer" and "UI layer") replacing the H1 "H1/H2 split" placeholder; Appendix C adds "Unlock UI pattern → Slim morphing banner; actions open modals". CLAUDE.md not updated — the rules established in v3.2 already cover everything H2 introduces (three-layer enforcement, locked-state rendering, unlock workflow on locked scenarios).
- **v3.3** — May 1, 2026 — Phase 2 Session H1: unlock workflow (DB layer). Three new migrations and the documentation that explains them. (1) **Migration 016** adds eight `unlock_*` columns to `budget_stage_scenarios`, four named CHECK constraints enforcing initiator separation and sequential ordering, a BEFORE trigger `tg_unlock_only_when_locked` (the unlock_requested flag cannot be true unless state = 'locked'), and a partial index on `(aye_id, stage_id) WHERE unlock_requested = true`. State machine deliberately uses flag fields on top of `state = 'locked'` rather than the reserved-but-unused `pending_unlock_review` state value — preserves Migration 015's sibling-lock guards without modification, since they check `state = 'locked'` and that remains true throughout the unlock-in-progress window. (2) **Migration 017** extends the hierarchical `permission_level` enum with `'approve_unlock'` inserted between `'approve_lock'` and `'admin'`, then grants `approve_unlock` on the Budget module to the live user. The "distinct from approve_lock" requirement is satisfied via subsumption-aware placement: `approve_lock` users do NOT auto-get `approve_unlock` (their level falls below the threshold); `admin` users do (admin subsumes everything, consistent with the rest of the system); `approve_unlock` users implicitly hold `approve_lock` (subsumption — fine, since trust to approve unlocks subsumes trust to approve locks). The grant is idempotent and never demotes an admin user. The migration file is structured in two parts (PART A: `ALTER TYPE`; PART B: grant) because PostgreSQL forbids referencing a newly-added enum value within the same transaction that added it. (3) **Migration 018** delivers three SECURITY DEFINER functions: `request_budget_stage_unlock` (requires `submit_lock`; non-empty justification; sets unlock_requested = true and stores justification + initiator), `approve_budget_stage_unlock` (requires `approve_unlock`; raises explicit exceptions on initiator-as-approver and same-user-twice; returns `'first_approval_recorded'` then `'unlock_completed'`; the second-approval branch issues two UPDATEs in one transaction so the audit trail captures who approved second before the unlock fields are cleared), `reject_budget_stage_unlock` (authorizes either `approve_unlock` holders or the original requester for self-withdraw; non-empty reason). All three tag `app.change_reason` with recognizable signatures (`unlock_requested`, `unlock_first_approval`, `unlock_completed`, `unlock_rejected: <reason>`, `unlock_withdrawn: <reason>`) so the existing `tg_log_changes` trigger captures workflow events permanently in `change_log.reason`. (4) **Architecture doc** new §8.13 documents the workflow in full; §3.4 extended with the unlock-has-no-cascade note; §5.1 extended with the unlock-doesn't-change-render-binding note; Appendix B adds Migrations 016–018 to implemented and renumbers needed Migrations 016→019 through 021→024; Appendix C adds four decision rows. (5) **CLAUDE.md** new "Unlock workflow on locked scenarios" paragraph under Database & migration conventions. UI layer (request modal, approval banner, withdraw affordance, change_log surfacing of unlock events) is queued for Session H2 as a separate commit.
- **v3.2** — April 29, 2026 — Phase 2 Commit G: documentation consolidation. No code or schema changes. Doc-level cleanup pass to bring the architecture document into a coherent state at the close of Phase 2 Commit F. (1) **Document header version corrected** from stale "v1.0" to "v3.2" with current date and Commit G annotation. (2) **Author name typo fixed** in the Purpose section ("Jenna Szar" → "Jenna Salazar"). (3) **Section 9.2 reframed** to mark the AYE lifecycle cadence parameters (auto-creation interval, naming convention, close grace-period thresholds) as Libertas defaults pending schema-level configurability. The earlier v1.x vision of a fully configurable Annual Rhythm Settings table was deliberately trimmed during the v2.2 architectural correction; rather than restoring that ambition prematurely, 9.2 now reads honestly about the present state and points to §9.7 as the future home — the schema extends when a second school onboards with a different calendar. (4) **Section 12 Phase 2** marks shipped Commit F items with ✅ (Stage-aware Budget UI, KPI sidebar, snapshot capture, Operating Budget Detail PDF, lock workflow, audit surfaces) and adds queued items (Unlock workflow, Comparison PDF) as explicit bullets so the sequence document tracks reality. (5) **Appendix B** adds Migration 015 (sibling lock guards) to the implemented list — it had been documented in the v2.8 entry and Section 8.7.1 but was missing from the migration manifest, while colliding with a "needed" entry that also carried the number 15. Subsequent needed migrations renumbered 015→016, 016→017, etc. (6) **Appendix C** extended with four Commit E/F-era decisions that were missing: PDF mechanism (`window.print()` + dedicated print routes, not Puppeteer), locked-state render binding rule (live joins forbidden, §5.1), module workflow taxonomy (hybrid school-display × Praesidium stage-type, §3.7), and sibling lock enforcement (three-layer DB+app+UI, §8.7.1). (7) **Version history reordered chronologically** — v2.7 through v3.1 had been interleaved out of date order in the file, making top-to-bottom reading misleading. Now strictly chronological. CLAUDE.md updates planned to follow as a separate task.

---

**End of document.**
