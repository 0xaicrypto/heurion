// #1150: eslint 9 flat config（ESLint 8 已 EOL）。
// 显式 flat 配置(不依赖 FlatCompat 的 override 转换);CJS 形态保持
// `node -r ./scripts/eslint-ts-patch.cjs` 的 tsgo require 拦截有效
// (typescript-eslint v8 需要 TS >=5.x JS API,tsgo 7 缺 JS API)。
const js = require('@eslint/js')
const tseslint = require('typescript-eslint')

const reactHooks = require('eslint-plugin-react-hooks')
const reactRefresh = require('eslint-plugin-react-refresh')
const anyBaseline = require('./scripts/any-baseline.json').files

const TS = ['**/*.ts', '**/*.tsx']

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**', 'eslint.config.cjs', '.eslintrc.cjs'] },
  { ...js.configs.recommended, files: TS },
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: TS })),
  {
    files: TS,
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // tailwind.config.ts 的 require 是有意为之(配置期动态 require)。
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  { files: anyBaseline, rules: { '@typescript-eslint/no-explicit-any': 'off' } },
)
