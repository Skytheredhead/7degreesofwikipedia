// tailwind.config.ts
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--font-syne)', 'sans-serif'],
        mono: ['var(--font-azeret)', 'monospace'],
      },
      colors: {
        void: '#06060a',
        'node-bg': 'rgba(8,9,16,0.85)',
      },
      keyframes: {
        subtlePulse: {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
        driftFloat: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' },
        },
      },
      animation: {
        subtlePulse: 'subtlePulse 0.9s ease-in-out infinite',
        driftFloat: 'driftFloat 4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
