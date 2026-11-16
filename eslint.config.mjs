import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import nodePlugin from 'eslint-plugin-n';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', '.cospan/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      'import-x': importX,
      n: nodePlugin,
    },
    rules: {
      'max-lines': ['error', { max: 350, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 4],
      complexity: ['error', 15],
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
      'import-x/extensions': [
        'error',
        'ignorePackages',
        { mjs: 'always', js: 'never', cjs: 'never' },
      ],
      'n/file-extension-in-import': ['error', 'always'],
      'n/prefer-node-protocol': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tests/**/*.test.mjs'],
    rules: {
      'max-lines-per-function': ['error', { max: 120, skipBlankLines: true, skipComments: true }],
    },
  },
  prettierConfig,
  {
    files: ['**/*.mjs'],
    rules: {
      'max-len': [
        'error',
        {
          code: 100,
          tabWidth: 2,
          ignoreUrls: true,
          ignoreRegExpLiterals: true,
        },
      ],
    },
  },
];
