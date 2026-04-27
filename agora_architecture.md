# Agora by Praesidium — Architecture Design Document

**Version 1.0** — Consolidated from design conversations completed April 26, 2026

---

## Purpose of this document

This is the canonical architecture reference for Agora by Praesidium. It captures the platform's design decisions, schema patterns, module relationships, and cross-cutting principles as agreed during design conversations between the Praesidium Foundation Board Chair (Jenna Szar) and Claude.

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
  Tuition Worksheet
  Staffing
  Preliminary Budget (integrates above)
  Enrollment Audit (October — family-level reality)
  Final Budget (integrates Audit + revised plans)
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
  1. Enrollment Estimator
  2. Tuition
  3. Staffing
  4. Preliminary Budget
  5. Enrollment Audit
  6. Final Budget

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

### 3.3 Time-scoping across modules

| Module | Time scope | Lifecycle |
|---|---|---|
| Strategic Financial Plan | Multi-year (e.g. AYE 25–28) | Adopted, monitored, occasionally revised |
| Strategic ENDS Priorities | Multi-year (currently 1, target 3+) | Board-adopted, periodically renewed |
| Operational Strategic Plan | Single AYE | HoS-submitted, Board-adopted, May/July |
| Enrollment Estimator | Single AYE | Multiple scenarios; locked once recommended |
| Tuition Worksheet | Single AYE | Locked once per AYE (typically January) |
| Staffing | Single AYE | Locked once per AYE (typically late summer) |
| Preliminary Budget | Single AYE | Locked April |
| Final Budget | Single AYE | Locked October (after Enrollment Audit) |
| Enrollment Audit | Single AYE | Conducted October |
| Advancement | Continuous | Monthly updates, year-round |
| Board Composition | Single AYE, with carryforward | Live editing; snapshotted at AYE close |
| Committees | Multi-year (committees) + per-AYE (memberships) | Live editing; snapshotted at AYE close |

### 3.4 Lock cascade rules

**Rule 1**: A downstream module cannot be locked unless its upstream sources are locked.

**Exception for Preliminary Budget**: Preliminary Budget can be locked with Staffing in a non-locked (projection) state. This matches reality — Staffing isn't typically finalized until just before school starts (August/September), well after April Preliminary Budget approval. Final Budget DOES require locked Staffing.

**Rule 2**: Locking an upstream module after a downstream is locked creates a "stale data" warning, not an error. The downstream snapshot stays preserved; a banner alerts users that re-locking is recommended.

**Override**: Per Section 2.3, System Admins can override lock cascade rules with required justification.

### 3.5 Cross-module data flow

Data flows downstream only:

- Enrollment Estimator → Tuition Worksheet (per-grade counts × rates = revenue)
- Enrollment Estimator → Budget (student count for cost-per-student calculations)
- Tuition Worksheet → Budget (revenue values for tuition/fee accounts)
- Staffing → Budget (compensation totals for personnel accounts)
- Enrollment Audit → Final Budget (actual reality replaces projection)
- Advancement → Enrollment Estimator (actuals as starting point for projections)
- Strategic Plan → all modules (target comparisons in KPIs)

Budget is read-only for upstream-fed values. To change them, edit the upstream source.

### 3.6 Custom KPI registry per school

In addition to universal KPIs, each school can define custom KPIs in `school_custom_kpis`. These appear in dashboards, comparison views, and target-setting alongside standard KPIs. Formula stored as text now; structured formula support is future work.

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

### 4.6 QuickBooks CSV import

QuickBooks's standard "Account List" export uses colon-delimited parent paths (e.g., `"Educational Program Revenue:Revenue – Tuition:"`). The importer:

1. Parses CSV
2. Walks parent paths to find or create ancestor accounts
3. Sets parent_id, code, name, account_type, is_active from row
4. Leaves governance flags blank (default false)
5. Surfaces imported chart for guided flag application

After import, a guided "review and flag" step walks the user through:
- Which accounts are summary (rollup only) vs posting. QB's CSV doesn't distinguish — every account starts as posting (the migration default). The user marks summaries explicitly during review (e.g., "Educational Program Revenue" as summary, "Revenue – Tuition" beneath it as posting).
- Which income accounts are pass-thrus
- Which income accounts count as Ed Program Dollars
- Which income accounts are contributions
- Which expense accounts are pass-thrus

For Libertas: ~70 accounts, ~15-20 minutes once.

### 4.7 Versioning (Option 2: account state at lock time)

Snapshots capture chart-relevant fields (code, name, hierarchy_path, account_type, flags) at lock time. Future renames don't change historical snapshots. Costs additional storage; preserves governance integrity.

### 4.8 Permissions (Section 2.1)

Chart of Accounts is a permissionable module like the others. Office Manager case: `edit` permission allows adding/editing accounts and flags; `approve_lock` or higher allows deactivation and reparenting; `admin` allows hard deletes.

### 4.9 Settings UI

Lives at **Admin → School Settings → Financial → Chart of Accounts**. Three views: tree (hierarchical), flat (sortable list), import (CSV upload + guided flagging).

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
  
  -- Captured upstream module references at lock time:
  tuition_scenario_snapshot_id uuid
  staffing_scenario_snapshot_id uuid (NULL if Staffing was in projection state at Preliminary lock)
  enrollment_estimate_snapshot_id uuid
  strategic_financial_plan_snapshot_id uuid
  
  -- For Preliminary Budget locked while Staffing was unlocked:
  staffing_state_at_lock enum ('locked', 'projected')
  
  -- Captured KPIs at lock time:
  kpi_total_income, kpi_total_expenses, kpi_net_income, etc.
```

When Preliminary Budget is locked with Staffing in projection state, the snapshot records that fact. Board members viewing the snapshot see "Personnel: $852,759 (based on projected Staffing as of April 15, 2026; final Staffing locked September 1)."

### 5.2 Redaction

**Principle**: Storage stores everything. Rendering filters by viewer permission.

**Detail-visibility flags** (orthogonal to module permissions per Section 2.1):
- `can_view_staff_compensation` — see individual staff salary lines
- `can_view_family_details` — see individual family rows in Enrollment Audit
- `can_view_donor_details` — see individual donor amounts in Fundraising (future)

**Rendering**: Same snapshot serves all viewers. Permissions checked at render time. Aggregate totals always visible to anyone with `view` permission; line-item detail filtered by detail-visibility flags.

### 5.3 PDF/Document Architecture

**Three layers**, isolated for upgrade flexibility:

1. **Snapshot retrieval + redaction** — get snapshot, filter by viewer permissions
2. **View selection** — pick which template/layout (Detail, Summary, Public, etc.)
3. **Render** — produce the actual PDF

**Implementation choice**: Path B from design discussion. HTML-to-PDF rendering for now (Puppeteer or similar). Layer 3 swaps to typographic engine (Typst, ReportLab, etc.) later if needed. Layers 1 and 2 don't change. Migration cost contained to template work.

**Per-school branding**: Every PDF accesses `school_brand_settings` for that school's logo, fonts, colors, tagline. Configured during school onboarding by Praesidium staff.

**Multiple views per module**:

```
Budget module:
  - "operating_budget_detail" (full line items)
  - "budget_summary" (category totals only, public-facing)
  - "variance_report" (comparison view)

Tuition Worksheet:
  - "tuition_schedule_public" (family-facing, branded)
  - "scenario_comparison" (board view)
  - "tuition_recommendation" (committee report)

Staffing:
  - "comp_summary" (aggregate)
  - "position_detail" (with redaction)
  - "staffing_scenarios" (scenario comparison)

Strategic Plan:
  - "adopted_document"
  - "tracking_report"

Enrollment Audit:
  - "summary_by_grade"
  - "family_detail" (with redaction)
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

**Purpose**: Tuition revenue scenarios for an AYE, plus family-facing Tuition Schedule.

**Inputs**: Enrollment estimate (per-grade counts), per-grade rates, sibling discount logic, fees.

**Outputs**: Revenue values feeding Budget; family-facing Tuition Schedule PDF.

**Schema** (built on existing `tuition_worksheet`, `tuition_scenarios`, with extensions):

```
tuition_worksheet
  ...existing fields...
  enrollment_estimate_id uuid (FK; which Enrollment scenario feeds this)

tuition_scenarios
  ...existing fields...
  
  sibling_discount_model enum ('flat_tiers', 'percentage_off')
  
  -- For 'flat_tiers' model (Libertas current):
  tuition_1_student numeric
  tuition_2_student numeric
  tuition_3_student numeric
  tuition_4plus_student numeric
  
  -- For 'percentage_off' model (Libertas previously):
  base_tuition numeric
  second_student_discount_pct numeric
  third_student_discount_pct numeric
  fourth_student_discount_pct numeric
  
  -- High school options (Libertas-specific structure):
  hs_full_time_annual numeric
  hs_3day_hybrid_annual numeric
  hs_2day_hybrid_annual numeric
  hs_alacarte_core_annual numeric
  hs_alacarte_elective_annual numeric
  hs_enrichment_day_annual numeric
  
  -- Fees:
  enrollment_fee_early numeric
  enrollment_fee_late numeric
  curriculum_fee_per_student numeric
  curriculum_fee_admin_fee_monthly numeric
  before_after_school_hourly numeric
  volunteer_buyout_fee numeric
  unfulfilled_volunteer_assessment numeric
  
  -- Customization escape hatch:
  custom_pricing_structure jsonb
```

**Design choices**:
- Customizable pricing structure per school (some have flat, some have percentage)
- Customizable PDF template per school (Praesidium configures during onboarding)
- Generates family-facing Tuition Schedule PDF on lock (eliminates HoS manual production hours)
- Once-per-year artifact — no mid-year changes
- Feeds Budget Tuition Revenue category via Module Mappings (Section 9.3)

**Tuition Schedule PDF**: The family-facing document. Sections include tuition table (TK-8 with sibling discount tiers), high school options (if applicable), enrollment & curriculum fees, payment options, program fees, withdrawal policy, family volunteer hours policy, school contact info. Per-school template configured during onboarding.

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

### 7.5 Module-to-Budget mapping

Each upstream module's outputs flow into specific Budget accounts. Mapping configured in **School Settings → Module Configuration**.

Examples:
- Tuition Worksheet's net tuition → account "Revenue – Tuition"
- Staffing's salary type total → account "Staff Salaries"
- Staffing's hourly type total → account "Hourly Wages"
- Staffing's contractor type total → account "Subcontractors"
- Staffing's tax computation → account "Taxes"

Praesidium configures mappings during school onboarding. Schools can see and verify. Mappings can be changed but flagged as consequential (Section 9.3).

---

## 8. Budget Module (the integration layer)

The most-used screen. Holly's primary workspace.

### 8.1 Visual layout — three zones

```
┌─────────────────────────────────────────────────────┐
│  HEADER ZONE (sticky)                                │
│  AYE 2027 Preliminary Budget • DRAFTING              │
│  [Save] [View PDF] [Submit] [Compare ▾]              │
└─────────────────────────────────────────────────────┘
┌────────────────┬────────────────────────────────────┐
│  KPI SIDEBAR   │  BUDGET DETAIL ZONE                │
│  (collapsible) │                                     │
│                │  ▼ INCOME                           │
│  Total Income  │     Tuition Revenue   $852,208     │
│  $1,237,983    │     ...                             │
│                │                                     │
│  Total Expense │  ▼ EXPENSES                         │
│  $1,277,757    │     Personnel        $852,759      │
│                │     ...                             │
│  Net Income    │                                     │
│  -$39,774      │                                     │
│                │                                     │
│  Ed Program    │                                     │
│  Ratio: 0.716  │                                     │
│  Target: 1.02  │                                     │
│  ⚠️             │                                     │
│  ...           │                                     │
│  [Collapse]    │                                     │
└────────────────┴────────────────────────────────────┘
```

KPI sidebar collapsible (thin strip with badge when collapsed). Wide screens: default expanded. Narrow screens: default collapsed. Always accessible without scrolling. PDFs render KPIs at top (header treatment), not sidebar — PDFs aren't constrained by screen width.

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
- Prior year's locked Final Budget
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

### 8.7 Multiple Budget scenarios per AYE

Real use case: HoS presents board with "with HS" vs. "without HS" budget options. Schema supports this via parallel scenarios (like Tuition and Staffing).

```
preliminary_budget_scenarios    (parallel structure to other modules)
  id, aye_id, scenario_label, description, is_recommended
  state enum
  narrative text (optional — see Section 8.8)
  show_narrative_in_pdf boolean (default true if narrative present)
  audit fields

preliminary_budget_lines
  id, scenario_id (FK), account_id, amount, source_type, source_ref_id, etc.

final_budget_scenarios + final_budget_lines    (same pattern)
```

ONE scenario marked `is_recommended` at lock time → becomes the official locked snapshot. Other scenarios remain queryable for "what-if" review.

### 8.8 Narrative space (Preliminary Budget only)

Optional narrative field on each Preliminary Budget scenario. HoS or Treasurer's contextual notes about priorities, cuts, decisions. Renders in Operating Budget Detail PDF when present. NOT in Budget Summary (community-facing). Optional — leave blank, hidden in UI.

### 8.9 Lock workflow

**Submit-time validation**:
- Recommended Tuition scenario must be locked → error or override
- Recommended Enrollment Estimate must be locked → error or override
- For Preliminary Budget: Staffing can be in any state (allowed projection state)
- For Final Budget: Recommended Staffing scenario must be locked → error or override
- Strategic Financial Plan adopted (covers this AYE) → warning only, not blocking
- Recommended scenario must exist (`is_recommended = true` on exactly one scenario)

If override used: justification text required, recorded in `override_justification`.

**Approval step**: Submit → `pending_lock_review` → Treasurer (or designated approver) reviews → Approve → `locked` → snapshot atomically captured.

**Re-lock workflow**: Locked Preliminary → work on Final → submit → approve → state becomes `final_locked` → new snapshot captured. Preliminary snapshot stays archived.

### 8.10 Operating tool layer (future)

Schema and UI ready to extend when QB actuals integration is built:
- Future `monthly_actuals` table referencing `chart_of_accounts.id` and `aye_id`
- Budget detail zone grows "actuals to date" column when actuals data exists
- KPI panel grows current-month and YTD variance indicators
- Variance reports join actuals to locked Budget snapshot

### 8.11 Print-ready outputs

- **Operating Budget Detail**: full hierarchical line items, board/internal use
- **Budget Summary**: category totals only, public/community-facing
- **Variance Report**: comparison view (priority — recent pain point)

All three render from same locked snapshot. View selected at PDF generation.

---

## 9. Cross-Cutting Concerns

### 9.1 Audit Log Surfacing

Three contextual views of `change_log` data:

**Per-record history**: On any record, "View History" → modal/drawer showing changes to that specific record.

**Per-module recent activity**: Module main page shows last N changes (user-configurable, default 10-25). Helps users orient when returning to a module.

**Per-user activity**: Admin-only view. "Show me everything user X did in date range Y."

**Lock events** rendered distinctly (highlighted background, lock icon, more vertical space). They're governance milestones, not routine edits.

**Override events** rendered MORE distinctly (yellow/amber, full justification visible). SCL accreditation review wants overrides documented, not buried.

**Schema additions to `change_log`**:
```
display_priority enum ('routine', 'milestone', 'override')
related_snapshot_id uuid (FK; for milestone events)
```

**Search/filter**: Not implemented in v1. Schema and UI designed to accept later.

### 9.2 AYE Lifecycle

**States**: `planning`, `active`, `closed`.

**Naming convention**: `AYE [end_year]` (e.g., AYE 2027 = July 1, 2026 - June 30, 2027). Configured in **School Settings → Organization → Fiscal Year Settings**.

**Auto-creation**: System auto-instantiates next AYE in `planning` state ~9 months before it begins. No human action required.

**Bootstrap workflow**: When new AYE is created, default behavior is to bootstrap from prior AYE (copy structure: grade sections, default staffing positions, default tuition rates as starting point). Opt-out option to start fresh.

**`planning → active` transition**: Triggered by AYE start date arriving. Likely automatic with manual confirmation.

**`active → closed` transition (manual, ceremonious)**:
- System Admin initiates close action
- Pop-up window with explicit explanation: "Closing AYE 2026 will make all module data read-only. Snapshots remain accessible. This action cannot be undone."
- TWO approvals required: System Admin AND one of (Treasurer | Board Chair). Both names + timestamps recorded.
- Grace period: soft reminders July 1+, escalating banners, obnoxious warnings August 1+
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
- **Muted/caption text on cream**: `#6B6760` minimum (verify contrast)
- **No body text on gold accent.** Gold is for accents, dividers, badges only.
- **Dark surfaces** (navy header/sidebar): white text at 90%+ opacity for primary, never below 70%
- **Status colors** (green/amber/red) must pass contrast on their backgrounds
- **Cream-on-cream surfaces** are fine for visual grouping (intentional design choice). The issue is text contrast, not surface contrast.

### 10.3 Spacing

- Card padding: 24px minimum
- Between sections: 32-48px
- Between cards: 16-24px
- Form field height: 40px minimum

### 10.4 PDF-Specific Standards

- Margins: 0.75" minimum, 1" preferred
- Logo: rendered at intended dimensions, never stretched, aspect ratio maintained
- Page breaks: avoid orphaning headers, keep table headers with first row of data
- Footer: school name + page number + generation date
- Header: section name on every page after first
- Locked-snapshot indicator: discreet "Approved [date] by [name]" + Snapshot ID
- DRAFT marking: prominent on all non-final outputs (Section 2.5)

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
- Preliminary Budget UI with manual entry, hierarchical display
- KPI sidebar (real-time computation)
- Snapshot capture on lock
- Operating Budget Detail PDF generation
- Lock workflow (submit → approve → locked)
- Audit log per-record history view

### Phase 3: Staffing Module
- Multi-scenario UI
- Position editing with all compensation types
- Module-to-Budget integration (Staffing totals → Budget Personnel category)
- Snapshot capture with redaction support

### Phase 4: Tuition Worksheet
- Full edit mode (currently read-only)
- Multi-scenario support
- Sibling discount model selection (flat tiers vs. percentage)
- Family-facing Tuition Schedule PDF generation

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

### Phase 7: Final Budget + Enrollment Audit
- Enrollment Audit UI (family-level reality)
- Final Budget integrating Audit
- Variance Report view

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
- Enrollment Audit: edit
- Staffing: view + can_view_staff_compensation
- Budget: view
- Strategic Plan: view

**Treasurer**:
- Budget: approve_lock + can_view_staff_compensation + can_view_family_details
- Staffing: approve_lock + can_view_staff_compensation
- Tuition: approve_lock
- Enrollment Audit: view + can_view_family_details
- Strategic Plan: view

**HoS**:
- Edit on most modules + all detail-visibility flags
- Approve_lock varies by module

**Board members (default)**:
- View on Budget, Staffing, Enrollment Audit (no detail-visibility flags)
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

### Migrations needed (per this architecture)

- **Migration 007**: Refactor `preliminary_budget` and `final_budget` for chart-of-accounts FK (validated via `is_posting_account()`), scenario structure
- **Migration 008**: Strategic Plan schemas (three instruments)
- **Migration 009**: Snapshot tables for Budget, Tuition, Staffing, Enrollment
- **Migration 010**: Board Composition + Committees
- **Migration 011**: Org Acronyms registry, Custom KPI registry
- **Migration 012**: Module-to-Account mappings
- (Additional migrations as build phases progress)

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
| Strategic Plan model | Three peers (ENDS / Financial / Operational) | 6.1 |
| Operational Plan structure | Three levels (Plan → Focus Area → Action) | 6.4 |
| Operational Plan post-adoption | Structure locked; living fields editable | 6.5 |
| Multi-scenario in operational modules | Yes, all three; one is_recommended at lock | 7.1 |
| Tuition discount models | Both flat tiers AND percentage off | 7.3 |
| Staffing lock timing | After Preliminary Budget; required for Final | 7.4 |
| Budget editing model | Direct edit with undo | 8.3 |
| KPI panel placement | Collapsible sidebar | 8.1 |
| Multiple Budget scenarios | Supported (with HS / without HS use case) | 8.7 |
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

---

**End of document.**
