# Libertas Agora

Governance and operations platform for Libertas Academy, a classical Christian TK–12 school (~120 students, ~$1.09M budget).

## Tech Stack
- Vite + React 19 (JavaScript)
- Tailwind CSS v3
- Supabase (Postgres, Auth, RLS)
- Vercel (hosting, planned)

## Brand
- **Navy** `#13213F` — primary background
- **Gold** `#D7BF67` — accents, titles, borders
- **Cinzel** — display/title font (regular weight only, never bold)
- **Georgia / Garamond** — body font

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
