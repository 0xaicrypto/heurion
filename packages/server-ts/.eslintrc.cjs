const anyBaseline = require('./scripts/any-baseline.json').files

module.exports = {
  root: true,
  env: { node: true, es2022: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.cjs', 'prisma', 'web-dist'],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: {
    // P2 债务收口: 新增文件禁止显式 any;存量文件在 scripts/any-baseline.json
    // 白名单(只减不增 — 修完一个移除一条)。
    '@typescript-eslint/no-explicit-any': 'error',
    // 真 bug 类:未使用变量(故意忽略用 _ 前缀)。
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // 注释掉的空 catch(/* best-effort */)按 ESLint 语义不算 empty;裸 catch {} 仍拦截。
    'no-empty': 'error',
    // 存量正则转义风格(大量 \[ 等)不强制;新代码可用。
    'no-useless-escape': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-this-alias': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
  },
  overrides: [
    {
      // any 存量白名单 — 文件级豁免;新增 any 只在未列入的文件中报错。
      files: anyBaseline,
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
};
