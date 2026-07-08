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

        // Research Workspace palette (rw-*). See index.css.
        // Always dark — independent of the global light/dark theme.
        rw: {
          bg: 'var(--rw-bg)',
          'bg-deep': 'var(--rw-bg-deep)',
          surface: 'var(--rw-surface)',
          'surface-2': 'var(--rw-surface-2)',
          'surface-3': 'var(--rw-surface-3)',
          border: 'var(--rw-border)',
          'border-soft': 'var(--rw-border-soft)',
          t1: 'var(--rw-t1)',
          t2: 'var(--rw-t2)',
          t3: 'var(--rw-t3)',
          t4: 'var(--rw-t4)',
          accent: 'var(--rw-accent)',
          'accent-2': 'var(--rw-accent-2)',
          'accent-bg': 'var(--rw-accent-bg)',
          'accent-bd': 'var(--rw-accent-bd)',
          brand: 'var(--rw-brand)',
          green: 'var(--rw-green)',
          'green-bg': 'var(--rw-green-bg)',
          red: 'var(--rw-red)',
          'red-bg': 'var(--rw-red-bg)',
          orange: 'var(--rw-orange)',
          'orange-bg': 'var(--rw-orange-bg)',
          blue: 'var(--rw-blue)',
        },
      },

      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
      },

      fontFamily: {
        // Research Workspace uses Space Grotesk for display + body
        // (matches docs/design/visual-mock/). Plex Mono for numbers,
        // code, identifiers.
        'rw-display': [
          'Space Grotesk',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        'rw-mono': [
          'IBM Plex Mono',
          'JetBrains Mono',
          'ui-monospace',
          'Menlo',
          'monospace',
        ],
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

      // ── Chat "thinking" animation ────────────────────────────────
      // Used by <ThinkingIndicator/> on every chat surface to give the
      // medic a strong visual cue that the AI is still working.
      // Staggered phase via inline `style.animationDelay` so the three
      // dots bounce one after another instead of in unison.
      keyframes: {
        'thinking-bounce': {
          '0%, 80%, 100%': {
            transform: 'translateY(0)',
            opacity: '0.4',
          },
          '40%': {
            transform: 'translateY(-3px)',
            opacity: '1',
          },
        },
      },
      animation: {
        'thinking-bounce': 'thinking-bounce 1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
