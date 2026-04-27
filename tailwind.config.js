/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Brand chrome
        navy: '#192A4F',
        gold: '#D7BF67',

        // Working area (light theme)
        cream: '#FAF8F2',
        'cream-highlight': '#F5F0E0',
        'card-border': '#E5E0D5',
        'alt-row': '#FAFAF7',

        // Text on light backgrounds.
        // (Use `text-navy` for primary headings; `navy` is already in palette.)
        body: '#2C2C2A',
        // `muted` is the canonical de-emphasized text token. It is navy
        // composited at ~80% opacity onto cream/white. Computed contrast
        // on cream #FAF8F2 = 6.7:1 — passes WCAG AA with margin. Use this
        // everywhere you would have used text-navy/40, /50, /55, /60. See
        // architecture doc Section 10.2 + v1.4 version-history entry.
        muted: '#475472',

        // Status palette — paired text + light fill per state. Text-on-cream
        // variants verified WCAG AA. status-amber darkened in v1.4 from
        // #BA7517 (3.5:1 — failed AA) to #8C5410 (5.6:1 — passes AA).
        'status-green':    '#3B6D11',
        'status-green-bg': '#EAF3DE',
        'status-blue':     '#185FA5',
        'status-blue-bg':  '#E6F1FB',
        'status-amber':    '#8C5410',
        'status-amber-bg': '#FAEEDA',
        'status-red':      '#A32D2D',
        'status-red-bg':   '#FCEBEB',
      },
      fontFamily: {
        display: ['Cinzel', 'serif'],
        body: ['"EB Garamond"', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
}
