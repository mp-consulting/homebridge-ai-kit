import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Ignores
  {
    ignores: ['dist/**', 'node_modules/**', 'tmp/**'],
  },
  // Base recommended configs
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // Language options
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  // Core rules
  {
    rules: {
      // Style
      'quotes': ['error', 'single', { avoidEscape: true }],
      'indent': ['error', 2, { SwitchCase: 1 }],
      'linebreak-style': ['error', 'unix'],
      'semi': ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'object-curly-spacing': ['error', 'always'],
      'max-len': ['error', { code: 160, ignoreUrls: true, ignoreStrings: true }],

      // Best practices
      'dot-notation': 'error',
      'eqeqeq': ['error', 'smart'],
      'curly': ['error', 'all'],
      'brace-style': ['error', '1tbs'],
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
      'no-var': 'error',

      // TypeScript
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': ['error', { classes: false, enums: false, functions: false }],
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  // Test files — relaxed rules
  {
    files: ['src/**/*.{test,spec}.ts', 'test/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts', 'src/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-use-before-define': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
