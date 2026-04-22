import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'src/tests/**',
      'dist/**',
      'node_modules/**',
      '*.config.js',
      '*.config.ts',
      '*.config.mjs',
    ],
  },
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // TypeScript-specific rules
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      
      // General code quality
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'always'],
      'no-console': 'off', // Allow console in tools
      'no-debugger': 'error',
      
      // Code style (not formatting - let prettier handle that)
      'prefer-template': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-arrow-callback': 'error',
    },
  }
);