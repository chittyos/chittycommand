/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        chitty: {
          50: '#f0f4ff',
          100: '#dbe4ff',
          500: '#4c6ef5',
          600: '#3b5bdb',
          700: '#364fc7',
          900: '#1b2559',
        },
        chrome: {
          bg: '#1a1a2e',
          surface: '#16213e',
          border: '#2a2a4a',
          text: '#e2e8f0',
          muted: '#94a3b8',
        },
        card: {
          bg: '#ffffff',
          hover: '#f8fafc',
          border: '#e2e8f0',
          text: '#1e293b',
          muted: '#64748b',
        },
        urgency: {
          red: '#ef4444',
          amber: '#f59e0b',
          green: '#22c55e',
        },
      },
      borderRadius: {
        card: '12px',
      },
    },
  },
  plugins: [],
};
