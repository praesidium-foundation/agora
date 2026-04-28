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

## Database & migration conventions

**GRANT discipline.** Migration 006 sets default privileges so any future table, sequence, or function created in `public` automatically grants the appropriate privileges to the `authenticated` role. RLS continues to gate row-level access. New migrations no longer need to issue per-table GRANTs. If a "permission denied for table X" error appears in any new migration, verify the migration is being run as `postgres` or `supabase_admin` (which is the case for all Supabase migrations); other creator roles would not inherit the default privileges.

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

The school crest is core to Libertas Academy's identity and appears throughout the app. Two versions exist:

- `/logo-mark-white.png` — use on dark backgrounds (navy, black, dark gray, etc.)
- `/logo-mark.png` — use on light backgrounds (white, cream, light gray, etc.)

Always pick the version that contrasts with the surrounding background. Never apply CSS filters, color overlays, or opacity changes to the crest itself — use the correct file instead.

Standard placements:
- Login page: white version, centered above "LIBERTAS ACADEMY" wordmark
- Dashboard / app navigation bar (top-left): white version (nav bar is dark)
- Printable reports and PDFs: navy version (light backgrounds)
- Browser favicon: handled separately via `/favicon.png`

When building any new page or component that includes the crest, follow these rules without needing to ask.
