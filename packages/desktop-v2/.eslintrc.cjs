module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', 'src-tauri/target', 'src-tauri/gen', '.eslintrc.cjs'],
  settings: { react: { version: '18.3' } },
  rules: {
    // We use the new JSX transform — no need to import React in scope.
    'react/react-in-jsx-scope': 'off',
    // TypeScript handles prop validation.
    'react/prop-types': 'off',
    // Allow underscore-prefixed unused args (common for stubs in U0/U1).
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // Permit empty catch / fallbacks for storage gracefulness.
    'no-empty': ['warn', { allowEmptyCatch: true }],
  },
};
