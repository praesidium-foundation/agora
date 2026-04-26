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
        muted: '#6B6760',

        // Status palette — paired text + light fill per state.
        'status-green':    '#3B6D11',
        'status-green-bg': '#EAF3DE',
        'status-blue':     '#185FA5',
        'status-blue-bg':  '#E6F1FB',
        'status-amber':    '#BA7517',
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
