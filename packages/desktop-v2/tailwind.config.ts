import type { Config } from 'tailwindcss';

/**
 * Design tokens from docs/design/nexus-architecture.md §4.
 * Two-mode (light/dark) colour tokens are CSS variables in index.css;
 * the Tailwind config just exposes them as named utilities so the JSX
 * stays theme-agnostic (`bg-surface`, not `bg-[#252320]`).
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-elevated': 'var(--surface-elevated)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-tertiary': 'var(--text-tertiary)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',

        // Single accent — the Google blue we already aligned to in #189
        accent: {
          DEFAULT: '#1A73E8',
          hover: '#1765CC',
          press: '#0F4FA0',
          subtle: 'var(--accent-subtle)',
        },

        // Semantic — used sparingly, never decoratively
        caution: '#B45309',
        retract: '#B91C1C',
        confirmed: '#15803D',
        unread: '#1A73E8',
      },

      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
      },

      fontFamily: {
        display: [
          'Charter',
          'Tiempos Text',
          'Georgia',
          'Cambria',
          'Times New Roman',
          'serif',
        ],
        body: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Inter',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'SF Mono',
          'ui-monospace',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },

      fontSize: {
        display: ['28px', { lineHeight: '36px', letterSpacing: '-0.01em' }],
        section: ['18px', { lineHeight: '24px' }],
        body: ['14px', { lineHeight: '20px' }],
        caption: ['12px', { lineHeight: '16px' }],
      },

      transitionTimingFunction: {
        'out-soft': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },

      transitionDuration: {
        80: '80ms',
        150: '150ms',
      },
    },
  },
  plugins: [],
} satisfies Config;
