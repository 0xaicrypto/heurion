const anyBaseline = require('./scripts/any-baseline.json').files

module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    // P2 债务收口: 新增文件禁止显式 any;存量文件在 scripts/any-baseline.json
    // 白名单(只减不增 — 修完一个移除一条)。
    '@typescript-eslint/no-explicit-any': 'error',
  },
  overrides: [
    {
      files: anyBaseline,
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
};
