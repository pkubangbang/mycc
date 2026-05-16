import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import noConsoleInTools from './eslint-rules/no-console-in-tools.js';

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
    plugins: {
      'custom': {
        rules: {
          'no-console-in-tools': noConsoleInTools,
        },
      },
    },
    rules: {
      // TypeScript-specific rules
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      
      // General code quality
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'always'],
      'no-console': 'off', // Allow console elsewhere
      'no-debugger': 'error',
      
      // Code style (not formatting - let prettier handle that)
      'prefer-template': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-arrow-callback': 'error',
      
      // Custom rule: no console.* in src/tools (rule self-checks directory)
      'custom/no-console-in-tools': 'error',

      // Disallow require() — project uses ESM imports only
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['require'],
          message: 'Use ESM import syntax instead of require()',
        }],
      }],

      // Disallow await import() — use static ESM imports
      'no-restricted-syntax': ['error', {
        selector: 'AwaitExpression > CallExpression[callee.type="Import"]',
        message: 'Use static ESM import syntax instead of await import()',
      }],
    },
  }
);