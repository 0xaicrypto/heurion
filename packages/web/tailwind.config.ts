import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        /* 正文/界面控件 = 系统无衬线;标题/节名 = Source Serif 4(学术编辑气质) */
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Noto Sans SC', 'sans-serif'],
        serif: ['var(--font-serif)'],
      },
      colors: {
        background: 'hsl(var(--background))',
        surface: 'hsl(var(--surface))',
        'surface-elevated': 'hsl(var(--surface-elevated))',
        border: 'hsl(var(--border))',
        'border-strong': 'hsl(var(--border-strong))',
        'text-primary': 'hsl(var(--text-primary))',
        'text-secondary': 'hsl(var(--text-secondary))',
        'text-tertiary': 'hsl(var(--text-tertiary))',
        accent: 'hsl(var(--accent))',
        'accent-hover': 'hsl(var(--accent-hover))',
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        error: 'hsl(var(--error))',
        ring: 'hsl(var(--ring))',
        /* §11.3 (#221): clinical semantic palette */
        'clinical-low-conf': 'hsl(var(--clinical-low-conf))',
        /* WRITING_MODULE_REDESIGN 视觉系统:作者轴 + 可信度轴 + 提议来源轴
           (带 alpha-value 占位,支持 bg-x/10 一类的软底色徽标) */
        'author-ai': 'hsl(var(--author-ai) / <alpha-value>)',
        'author-human': 'hsl(var(--author-human) / <alpha-value>)',
        'verify-verified': 'hsl(var(--verify-verified) / <alpha-value>)',
        'verify-pending': 'hsl(var(--verify-pending) / <alpha-value>)',
        'source-conflict': 'hsl(var(--source-conflict) / <alpha-value>)',
        nexus: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
          950: '#082f49',
        },
      },
      /* §11.3 (#221): radius language — 8/12/16 professional rounding */
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        full: '999px',
      },
      keyframes: {
        floaty: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
      },
      animation: {
        floaty: 'floaty 5s ease-in-out infinite',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
} satisfies Config;
