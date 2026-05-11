import next from 'eslint-config-next';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import noForbiddenVocabulary from './eslint-rules/no-forbidden-vocabulary.js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'drizzle/migrations/**',
      'next-env.d.ts',
    ],
  },
  ...next,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'qrsiparis': {
        rules: {
          'no-forbidden-vocabulary': noForbiddenVocabulary,
        },
      },
    },
    rules: {
      // TypeScript-aware base rules
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Forbidden-vocabulary enforcement: legally-binding (Doc 01 §7.1, IMPL §1.PB4)
      'qrsiparis/no-forbidden-vocabulary': ['error', { excludeRoleConstants: true }],
    },
  },
  {
    // Test files: relax some rules
    files: ['tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
