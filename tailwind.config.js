/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        navy: '#13213F',
        gold: '#D7BF67',
      },
      fontFamily: {
        display: ['Cinzel', 'serif'],
        body: ['Georgia', 'Garamond', 'serif'],
      },
    },
  },
  plugins: [],
}
