# Libertas Agora

Governance and operations platform for Libertas Academy, a classical Christian TK–12 school (~120 students, ~$1.09M budget).

## Project ownership and naming

- **Praesidium Foundation, Inc.** owns this product (IP, infra, brand). Repo: `praesidium-foundation/agora` (public, no LICENSE yet).
- **Agora by Praesidium** is the platform/product brand. **Libertas Agora** is the instance branded for Libertas Academy (founding customer, perpetual free instance). Future schools follow the pattern (e.g., "Veritas Agora").
- **Multi-tenant in spirit, single-tenant in implementation.** Do NOT add `org_id` columns or per-school `school_brand_settings` — those migrations are deferred until a second school onboards.
- **User-facing UI strings stay "Libertas Agora"** (headers, login, dashboard). Use "Agora by Praesidium" or "Agora" only in commit messages, README, LICENSE, and other meta-content. Do not rename `package.json` name or other internal identifiers from the old `libertas-agora` slug without explicit instruction.
- **Live URL:** `agora-praesidium.vercel.app` (will eventually move to subdomains on `agoraweb.app`, e.g., `libertas.agoraweb.app`). Local working folder is `agora`; remote origin is `praesidium-foundation/agora`.

## Tech Stack
- Vite + React 19 (JavaScript)
- Tailwind CSS v3
- Supabase (Postgres, Auth, RLS)
- Vercel (hosting, planned)

## Brand & palette

All colors are exposed as Tailwind tokens (see `tailwind.config.js`).

**Brand chrome**
- **Navy** `#192A4F` — header + sidebar background; primary headings on light bg; "Board approved" badge fill
- **Gold** `#D7BF67` — accents, active nav highlight, AYE badge border, section underlines

**Working area (light theme)**
- **Cream** `#FAF8F2` — main working area background
- **Cream highlight** `#F5F0E0` — hover/active sidebar nav, locked-tuition badge fill, MetricCard background
- **Card border** `#E5E0D5` — warm light gray, subtle borders on white cards and dividers
- **Alt row** `#FAFAF7` — alternating table row tint

**Text on light backgrounds** (use `text-navy` for primary headings)
- **Body** `#2C2C2A` — body copy, table cells
- **Muted** `#6B6760` — captions, sublabels, italic notes

**Status palette** (paired text + light fill per state — used in chips, accent bars, alerts)
- **Green** `text-status-green` `#3B6D11` / `bg-status-green-bg` `#EAF3DE` — done, on-target
- **Blue** `text-status-blue` `#185FA5` / `bg-status-blue-bg` `#E6F1FB` — active, in progress
- **Amber** `text-status-amber` `#BA7517` / `bg-status-amber-bg` `#FAEEDA` — warning, attention
- **Red** `text-status-red` `#A32D2D` / `bg-status-red-bg` `#FCEBEB` — error, off-target

**Typography**
- **Cinzel** (`font-display`) — page titles, card titles, section labels, metric values. Regular weight (400) only — **never bold**.
- **EB Garamond** (`font-body`) — body text, table cells, form labels, descriptions. Georgia fallback.

**Muted text tokens.** Use `text-muted` (navy at AA-compliant opacity, computed as the solid color `#475472`) for all de-emphasized text on cream surfaces — page subtitles, helper text, `FieldLabel`, `SectionLabel`, table headers, breadcrumb crumbs. Do not use lower-opacity navy (`text-navy/40`, `/50`, `/55`, `/60`) for any text the user needs to read; it fails WCAG AA. Sidebar disabled items (modules not yet built) are an explicit exception and remain at `text-white/30` by design — they signal "not yet available" through their faintness. See architecture doc Section 10.2 for the contrast math and the v1.4 history note for the rationale.

**COA vocabulary.** Account hierarchy uses QuickBooks-aligned terminology in all user-facing copy: **"subaccount of"** (not "parent"), **"subaccount"** (not "child"), **"+ Subaccount"** button. Database column `parent_id` is internal-only and must never surface in UI, error messages, or tooltips. Trigger error messages still use older `parent / child / cycle` wording (from Migration 004) and are translated at the UI surface — see `translateError` in `CoaManagement.jsx`. When adding new COA-related copy, follow the subaccount vocabulary; when surfacing DB errors, route them through the translator.

**Software-neutral language.** Agora is sold to schools using a variety of accounting software (QuickBooks Online, Xero, Sage, Wave, Aplos, etc.). User-facing descriptive copy must not name third-party products by brand. Use **"your accounting software"**, **"your books"**, or **"standard account list format"** instead of QuickBooks-specific phrasing. Format detection results may name a format by its source when that's a factual statement (e.g., "QuickBooks Account List format detected") — the user uploaded a specific file and Agora is reporting what it found. Conceptual explanations ("money posts here in QuickBooks") use brand-neutral phrasing instead ("transactions post directly to this account"). Internal code, comments, and variable names may freely reference QuickBooks — the boundary is the rendered string. See architecture doc Section 10.8.

**Formal tone — no contractions in system-authored user-facing strings.** System-authored user-facing strings use full forms — "is not" rather than "isn't", "cannot" rather than "can't", "do not" rather than "don't", "you are" rather than "you're", etc. Captured user input (justification text, audit-log reason text typed by users) is exempt; preserve the user's voice. Code comments and identifiers are exempt — not user-visible. The convention parallels the software-neutral language rule above: both are about how the platform speaks to users in its own voice. Reference architecture §10.11.

## Database & migration conventions

**GRANT discipline.** Migration 006 sets default privileges so any future table, sequence, or function created in `public` automatically grants the appropriate privileges to the `authenticated` role. RLS continues to gate row-level access. New migrations no longer need to issue per-table GRANTs. If a "permission denied for table X" error appears in any new migration, verify the migration is being run as `postgres` or `supabase_admin` (which is the case for all Supabase migrations); other creator roles would not inherit the default privileges.

**PostgREST schema cache reload — every migration.** Every migration that creates or replaces a function, creates or alters a table, or changes any RPC-callable surface must end with `notify pgrst, 'reload schema';`. PostgREST does not refresh its schema cache automatically when migrations run — without the reload notification, the API layer reports objects as "not found in schema cache" until the cache happens to refresh on its own. The reload is idempotent and cheap; include it defensively even when you're not sure it's needed. Migration 013 is the first to follow the discipline; 008–012 had it added retroactively in v2.4.

**FK-completeness on safety-check functions.** Functions like `chart_of_accounts_can_hard_delete()` that test whether a record is safe to delete must be updated whenever a new table is added with an FK to the underlying record's table. If the function falls out of sync with the schema, the UI's pre-flight check can claim a record is safe when the database's FK constraints will reject the deletion — producing a poor UX and a trust failure. Migration 013's header carries the explicit list of tables checked vs. tables intentionally not blocking (snapshot tables with `ON DELETE SET NULL` are by design); future migrations that add references must update both the function body and that list.

**Module workflows and stages.** The Budget module (and future modules with cycle-based work — Strategic Plan, Accreditation) supports school-configurable workflows. Each module has one active workflow per school (`module_workflows`); each workflow has ordered stages (`module_workflow_stages`). Stages are typed from a Praesidium-curated catalog (`stage_type_definitions`: `working` / `preliminary` / `adopted` / `reforecast` / `final`) but **named freely by the school**. Libertas's Budget workflow has two stages — Preliminary Budget and Final Budget — but every school's workflow can differ (single-stage, quarterly reforecasts, etc.). Architecture doc Section 3.8 has the full design.

  - **UI rule**: never hardcode "Preliminary" or "Final" in user-facing copy. Page titles, breadcrumbs, sidebar labels, button text, and notice strings all read stage labels dynamically from the loaded stage object (`stage.display_name` for titles, `stage.short_name` for compact contexts).
  - **Cross-module references** (e.g., "the locked budget for this AYE"): match by `stage_type_at_lock` from snapshots, not by display name. Example — "the most recent locked snapshot for AYE X whose `stage_type_at_lock` is terminal" is the canonical "official budget."
  - **Internal code** may freely use stage-type identifiers (`'preliminary'`, `'final'`) as constants — those are stable identifiers, not user-facing strings. Display labels come from the school's workflow row.
  - **Stage initialization gateway.** A stage's setup view (rendered when no scenario exists yet for the active AYE+stage) branches on whether the stage is the first in its workflow. First stages (lowest `sort_order` in `module_workflow_stages` for the workflow) use the original setup options (bootstrap from prior AYE, CSV upload, fresh start). Non-first stages require a locked predecessor stage in the same AYE; setup is blocked until at least one predecessor is locked, and seeding occurs from a user-selected predecessor snapshot via `create_scenario_from_snapshot` (Migration 019). The non-first-stage UI lives in `src/components/budget/PredecessorSelector.jsx`. See architecture §8.14.

**Locked-state rendering and snapshots.** When a module supports locking (Budget today; Tuition, Staffing, Strategic Plan, Final Budget, etc. as they ship), render paths must split on state:

  - **Drafting / pending states** read from live tables joined to live `chart_of_accounts` (or whatever the live schema is for that module).
  - **Locked state** reads exclusively from snapshot tables (`*_snapshots` + `*_snapshot_lines`) using their captured-by-value columns. Live joins to `chart_of_accounts` (or any other source table that can change post-lock) are **forbidden** in locked render paths.

The reason is governance integrity: a locked snapshot is the document a board chair puts in a binder. It must be invariant under post-lock edits to live data — deactivating an account, renaming an account, or reparenting an account in the live COA must leave every locked PDF and every locked in-app view exactly as it was at lock time. The schema enforces this with `ON DELETE SET NULL` on snapshot FKs to source tables; the render code enforces it by not joining live. The Budget module follows this pattern in `fetchScenarioPayload` (locked path) and `buildSnapshotTree` (reconstruction from captured `account_hierarchy_path` segments). See architecture doc Section 5.1 binding rule and v2.7 history note.

**PDF/print rendering.** Agora's PDFs are produced via dedicated print routes plus `window.print()`, not a server-side renderer (no Puppeteer, no react-pdf, no headless Chromium). Each print surface lives at a `/print/...` route that mounts its own component tree (no AppShell, no nav sidebar, no KPI sidebar), renders with the shared `PrintShell` component (letterhead, watermark, footer), and auto-fires `window.print()` on mount. All print styling lives in `src/components/print/print.css`. Existing routes: `/print/budget/:scenarioId` (Operating Budget Detail), `/print/budget/:scenarioId/activity` (per-scenario activity feed), `/print/budget-line/:lineId/history` (per-line audit history). New PDF surfaces follow the same pattern. This avoids server-side rendering infrastructure for ad-hoc PDF generation; the upgrade path (if emailable PDFs become a real requirement) is to mount the same React tree in a Vercel serverless function with a headless-Chromium renderer — Layers 1 and 2 of the §5.3 architecture (snapshot retrieval + view selection) stay unchanged. See architecture doc Section 5.3 and v2.9 history note.

**Three-layer enforcement for state invariants.** When the schema requires that some action be impossible under certain conditions (e.g., "marking Scenario 2 as recommended is forbidden while Scenario 1 is locked"), enforce in three layers:

  - **Database** — `BEFORE UPDATE` (or equivalent) trigger that rejects the disallowed transition. This is the hard guard; nothing in the application layer can bypass it. Triggers should fire only on the specific transition so no-op UPDATEs pass through.
  - **Application validator** — a pure/sync helper (e.g., `findLockedSibling`, `validateScenarioForLock` in `src/lib/budgetLock.js`) that detects the condition and produces a structured failure (typically tagged `hardBlock: true, kind: '...'`). Lets the UI explain the block before the user attempts it; lets submission paths hide override affordances when the DB will refuse anyway.
  - **UI affordance** — disable the offending control with a tooltip naming the specific blocker; render an informational banner where appropriate. Prevents the user from ever hitting the trigger in normal use.

All three layers must agree. The DB trigger is the source of truth; the application and UI layers exist to make the user experience graceful, not to substitute for the trigger. Migration 015 (sibling lock guards) is the canonical example. See architecture doc Section 8.7.1.

**Unlock workflow on locked scenarios.** Unlock requests on locked scenarios use flag fields (`unlock_requested`, `unlock_request_justification`, `unlock_requested_at`, `unlock_requested_by`, plus paired `unlock_approval_1_*` / `unlock_approval_2_*` columns) on top of `state = 'locked'`, not a separate state machine state. Two-identity model (v3.7): the requester's submission atomically populates both the request fields and the approval_1 fields (request submission counts as approval_1); one additional approver — distinct from the requester, also holding `approve_unlock` — records approval_2 and triggers the state transition to `'drafting'`. See architecture doc §8.13.

## Architecture reference

The file `agora_architecture.md` at the project root is the **canonical architecture reference** for Agora by Praesidium — schema patterns, module relationships, permission model, design standards, AYE lifecycle, and build sequencing. Read it before any non-trivial schema or feature work. Where conflicts arise between this doc, build prompts, or earlier conversation snippets, the architecture doc wins. Appendix B lists implemented and planned migrations; keep it current.

## Design system reference

The file `design-reference.html` at the project root is the **visual source of truth** for layout, colors, components, and typography. It is gitignored (not deployed) and used as a reference document only.

Future sessions should consult it before making visual changes. It defines:
- Exact color palette (navy chrome, cream working area, gold accents, chip colors)
- Typography system (Cinzel + EB Garamond, sizes, letter-spacing)
- Sidebar structure with section headers and numbered nav items
- Status chip system for AYE workflow states
- Card system with subtle borders
- Two-step lock workflow visual treatment
- AYE badge in the top-right header

When implementing visual changes, match the mockup precisely — don't approximate borders, radii, padding, font sizes, or letter-spacing.

## Brand asset rules

The school crest is core to Libertas Academy's identity and appears throughout the app. Three logo assets exist:

- `/logo-mark-white.png` — crest version, use on dark backgrounds (navy, black, dark gray, etc.)
- `/logo-mark.png` — crest version, use on light backgrounds (white, cream, light gray, etc.); also the in-app and favicon source asset
- `/logo-horizontal-color.png` — full horizontal wordmark in color, used on the first page of every printable governance document (Budget PDFs and future report PDFs). Subsequent pages of the same PDF use a thin Cinzel text running header instead of the logo (see architecture doc §10.4 "Logo treatment in printed governance documents")

Always pick the version that contrasts with the surrounding background. Never apply CSS filters, color overlays, or opacity changes to the logo itself — use the correct file instead.

Standard placements:
- Login page: white crest version (`logo-mark-white.png`), centered above "LIBERTAS ACADEMY" wordmark
- Dashboard / app navigation bar (top-left): white crest (`logo-mark-white.png`) — nav bar is dark
- Printable reports and PDFs: full horizontal color wordmark (`logo-horizontal-color.png`) on the first page; text running header on subsequent pages
- Browser favicon: handled separately via `/favicon.png`

When building any new page or component that includes a logo, follow these rules without needing to ask.
