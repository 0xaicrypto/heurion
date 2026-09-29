// #1150: eslint 9 flat config（ESLint 8 已 EOL）。
// 显式 flat 配置(不依赖 FlatCompat 的 override 转换);CJS 形态保持
// `node -r ./scripts/eslint-ts-patch.cjs` 的 tsgo require 拦截有效
// (typescript-eslint v8 需要 TS >=5.x JS API,tsgo 7 缺 JS API)。
const js = require('@eslint/js')
const tseslint = require('typescript-eslint')

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**', 'eslint.config.cjs'] },
  { ...js.configs.recommended, files: ['**/*.ts'] },
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': 'error',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
)
