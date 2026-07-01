/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0e1116',
        panel: '#161b22',
        edge: '#262d38',
        accent: '#3b82f6'
      }
    }
  },
  plugins: []
}
