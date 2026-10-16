import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import noConsoleInTools from './eslint-rules/no-console-in-tools.js';

// Node globals declared by hand (the `globals` package is not a project
// dependency). Plain `.js`/`.mjs`/`.cjs` files under `scripts/` are runtime
// Node shims with no TypeScript program to infer globals from, so `no-undef`
// otherwise flags every `process`/`console`/`require`/`AbortSignal` reference.
// Scoped to those flat-config entries below, never to the whole repo.
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'src/tests/**',
      'src/web/**',
      'dist/**',
      'node_modules/**',
      '*.config.js',
      '*.config.ts',
      '*.config.mjs',
    ],
  },
  {
    // Typed linting needs a TS program. Scope it to TypeScript sources: the
    // project's `src/` modules are `.ts` (consumed by tsx/TS), and only the
    // `scripts/` bins (e.g. `scripts/mycc-compose/mycc-compose.js`) ship plain
    // `.js` entry shims — those are NOT part of tsconfig.json's program
    // (allowJs is false). Without this scope the parser errors with
    // "The file was not found in any of the provided project(s)".
    //
    // `scripts/**/*.ts` is EXCLUDED here: those files live in
    // tsconfig.scripts.json's program, not tsconfig.json's, so pointing them
    // at `./tsconfig.json` makes the parser fail with the same "not found in
    // any of the provided project(s)" error. They get their own block below.
    files: ['**/*.ts'],
    ignores: ['scripts/**/*.ts'],
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
      'prefer-template': 'warn',
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
  },
  {
    // `scripts/**/*.ts` (the mycc-compose lib modules) are typed by a SEPARATE
    // program — tsconfig.scripts.json — not tsconfig.json. Pointing the main
    // `**/*.ts` block at them errors with "The file was not found in any of
    // the provided project(s)", so they get this dedicated block bound to the
    // correct project. Same rule set as `src/`.
    files: ['scripts/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.scripts.json',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',

      // General code quality
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'always'],
      'no-console': 'off',
      'no-debugger': 'error',

      // Code style (not formatting - let prettier handle that)
      'prefer-template': 'warn',
      'object-shorthand': ['error', 'always'],
      'prefer-arrow-callback': 'error',

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
  },
  {
    // The `.js`/`.mjs` entry shims under `scripts/` (e.g.
    // `scripts/mycc-compose/mycc-compose.js`, which registers tsx and
    // dynamically imports the `.ts` lib modules) are runtime-only Node
    // programs with no type-aware program to infer globals from, so they get
    // the base recommended rules plus the hand-declared Node globals.
    // `require` is declared as a global here because `.cjs` shims (e.g.
    // `scripts/retire-tests.cjs`) legitimately use CommonJS.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: nodeGlobals,
    },
    rules: {
      // `require()` is the whole point of a `.cjs` shim; the ESM-only
      // restriction is enforced on `.ts` sources above, not here.
      '@typescript-eslint/no-require-imports': 'off',
    },
  }
);