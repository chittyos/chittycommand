/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Figtree', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        display: ['Syne', 'Figtree', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        chitty: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#1e1b4b',
        },
        chrome: {
          bg: '#0f0f1a',
          surface: '#161625',
          border: '#252540',
          text: '#e4e4f0',
          muted: '#8888a8',
        },
        card: {
          bg: 'rgba(255, 255, 255, 0.97)',
          hover: 'rgba(248, 250, 255, 0.98)',
          border: 'rgba(200, 205, 225, 0.5)',
          text: '#1a1a2e',
          muted: '#5c5c7a',
        },
        urgency: {
          red: '#f43f5e',
          amber: '#f59e0b',
          green: '#10b981',
        },
      },
      borderRadius: {
        card: '16px',
      },
      boxShadow: {
        'card': '0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.03)',
        'card-hover': '0 2px 8px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)',
        'glow-brand': '0 0 20px rgba(99,102,241,0.15)',
        'glow-success': '0 0 20px rgba(16,185,129,0.15)',
        'glow-danger': '0 0 20px rgba(244,63,94,0.15)',
        'inner-highlight': 'inset 0 1px 0 rgba(255,255,255,0.6)',
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.4s ease-out both',
        'fade-in': 'fadeIn 0.3s ease-out both',
        'slide-in-left': 'slideInLeft 0.3s ease-out both',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
