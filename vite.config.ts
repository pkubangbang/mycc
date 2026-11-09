// vp migrate: merged .oxlintrc.json (82ea83a02c5f9a369fb2d9d41e56b444).
import { defineConfig } from 'vite-plus';

export default defineConfig({
  staged: {
    '*': 'vp check --fix'
  },
  lint: {
    plugins: ['oxc', 'typescript', 'unicorn'],
    categories: {
      correctness: 'warn'
    },
    env: {
      builtin: true
    },
    ignorePatterns: [
      'src/tests/**',
      'src/web/**',
      'dist/**',
      'node_modules/**',
      '*.config.js',
      '*.config.ts',
      '*.config.mjs',
      // Out of scope, matching the pre-consolidation `vp lint src/` + format.js
      // filter. `skills/` and `docs/` are author-owned content — a self-learning
      // reference and a demo game must not red the repo gate.
      'skills/**',
      'docs/**',
      '.codegraph/**',
      '.mycc/**',
      // Manual, live-provider diagnostics: run by hand against real APIs,
      // never part of a gate (see vitest `exclude` below).
      'scripts/tp-violation/**'
    ],
    rules: {
      'constructor-super': 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'error',
      'no-case-declarations': 'error',
      'no-class-assign': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': 'error',
      'no-const-assign': 'error',
      'no-constant-binary-expression': 'error',
      'no-constant-condition': 'error',
      'no-control-regex': 'error',
      'no-debugger': 'error',
      'no-delete-var': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': 'error',
      'no-empty-character-class': 'error',
      'no-empty-pattern': 'error',
      'no-empty-static-block': 'error',
      'no-ex-assign': 'error',
      'no-extra-boolean-cast': 'error',
      'no-fallthrough': 'error',
      'no-func-assign': 'error',
      'no-global-assign': 'error',
      'no-import-assign': 'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-loss-of-precision': 'error',
      'no-misleading-character-class': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-nonoctal-decimal-escape': 'error',
      'no-obj-calls': 'error',
      'no-prototype-builtins': 'error',
      'no-redeclare': 'error',
      'no-regex-spaces': 'error',
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-shadow-restricted-names': 'error',
      'no-sparse-arrays': 'error',
      'no-this-before-super': 'error',
      'no-unassigned-vars': 'error',
      'no-undef': 'error',
      'no-unexpected-multiline': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-unused-labels': 'error',
      'no-unused-private-class-members': 'error',
      'no-unused-vars': 'error',
      'no-useless-assignment': 'error',
      'no-useless-backreference': 'error',
      'no-useless-catch': 'error',
      'no-useless-escape': 'error',
      'no-with': 'error',
      'preserve-caught-error': 'error',
      'require-yield': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-array-constructor': 'error',
      'no-unused-expressions': 'error',
      'typescript/ban-ts-comment': 'error',
      'typescript/no-duplicate-enum-values': 'error',
      'typescript/no-empty-object-type': 'error',
      'typescript/no-explicit-any': 'error',
      'typescript/no-extra-non-null-assertion': 'error',
      'typescript/no-misused-new': 'error',
      'typescript/no-namespace': 'error',
      'typescript/no-non-null-asserted-optional-chain': 'error',
      'typescript/no-require-imports': 'error',
      'typescript/no-this-alias': 'error',
      'typescript/no-unnecessary-type-constraint': 'error',
      'typescript/no-unsafe-declaration-merging': 'error',
      'typescript/no-unsafe-function-type': 'error',
      'typescript/no-wrapper-object-types': 'error',
      'typescript/prefer-as-const': 'error',
      'typescript/prefer-namespace-keyword': 'error',
      'typescript/triple-slash-reference': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error'
    },
    overrides: [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        rules: {
          'constructor-super': 'off',
          'getter-return': 'off',
          'no-class-assign': 'off',
          'no-const-assign': 'off',
          'no-dupe-class-members': 'off',
          'no-dupe-keys': 'off',
          'no-func-assign': 'off',
          'no-import-assign': 'off',
          'no-new-native-nonconstructor': 'off',
          'no-obj-calls': 'off',
          'no-redeclare': 'off',
          'no-setter-return': 'off',
          'no-this-before-super': 'off',
          'no-undef': 'off',
          'no-unreachable': 'off',
          'no-unsafe-negation': 'off',
          'no-var': 'error',
          'no-with': 'off',
          'prefer-const': 'error',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error'
        }
      },
      {
        files: ['**/*.ts'],
        rules: {
          'no-var': 'error',
          'prefer-const': 'error',
          eqeqeq: ['error', 'always'],
          'no-console': 'off',
          'prefer-template': 'warn',
          'object-shorthand': ['error', 'always'],
          'prefer-arrow-callback': 'error',
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['require'],
                  message: 'Use ESM import syntax instead of require()'
                }
              ]
            }
          ],
          'no-unused-vars': [
            'error',
            {
              argsIgnorePattern: '^_',
              varsIgnorePattern: '^_',
              caughtErrorsIgnorePattern: '^_'
            }
          ],
          'typescript/no-explicit-any': 'warn',
          'typescript/explicit-function-return-type': 'off',
          'typescript/no-non-null-assertion': 'off'
        },
        jsPlugins: []
      },
      {
        files: ['src/tools/**/*.ts'],
        rules: {
          // Migrated from the former eslint-rules/no-console-in-tools.js:
          // tool implementations must emit through ctx.core.brief() so output
          // flows through the agent's stream with consistent tool tagging.
          'no-console': 'error'
        }
      },
      {
        files: ['scripts/**/*.ts'],
        rules: {
          'no-var': 'error',
          'prefer-const': 'error',
          eqeqeq: ['error', 'always'],
          'no-console': 'off',
          'prefer-template': 'warn',
          'object-shorthand': ['error', 'always'],
          'prefer-arrow-callback': 'error',
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['require'],
                  message: 'Use ESM import syntax instead of require()'
                }
              ]
            }
          ],
          'no-unused-vars': [
            'error',
            {
              argsIgnorePattern: '^_',
              varsIgnorePattern: '^_',
              caughtErrorsIgnorePattern: '^_'
            }
          ],
          'typescript/no-explicit-any': 'warn',
          'typescript/explicit-function-return-type': 'off',
          'typescript/no-non-null-assertion': 'off'
        }
      },
      {
        files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
        rules: {
          'typescript/no-require-imports': 'off'
        },
        globals: {
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
          fetch: 'readonly'
        }
      }
    ],
    options: {
      typeAware: true,
      typeCheck: true
    },
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin'
      }
    ]
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    // Belt-and-braces: NOTHING outside src/tests is a test file. In particular
    // `scripts/tp-violation/` holds a MANUAL, live-provider diagnostic
    // (`main.mjs` / `probe.mjs` / `deepseek.mjs` / `ollama.mjs`) that posts
    // real requests. It is run by hand, never by `pnpm test`; this exclude makes
    // that invariant explicit so a future include-glob edit cannot silently
    // sweep it in.
    exclude: ['**/node_modules/**', '**/dist/**', 'scripts/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/tests/**', 'src/index.ts', 'src/lead.ts']
      // Ratchet: these floors only guard against a test deletion that
      // silently drops coverage. They are deliberately set below the
      // measured baseline and must be raised (never lowered) once a higher
      // baseline is established — see TESTING_STANDARDS.md.
      // Requires `@vitest/coverage-v8` (`pnpm add -D @vitest/coverage-v8`);
      // it is in pnpm-lock.yaml but not declared in package.json yet.
      // thresholds: { lines: 0, branches: 0, functions: 0 },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false
  },
  fmt: {
    semi: true,
    singleQuote: true,
    tabWidth: 2,
    trailingComma: 'none',
    printWidth: 120,
    bracketSpacing: true,
    arrowParens: 'always',
    bracketSameLine: false,
    htmlWhitespaceSensitivity: 'css',
    proseWrap: 'preserve',
    endOfLine: 'lf',
    sortPackageJson: false,
    // Scope mirrors the former scripts/format.js gate: code + text assets under
    // src/, scripts/ and root config, while docs/ and markdown stay author-
    // controlled (proseWrap 'preserve' cannot save hand-laid-out docs from a
    // machine reflow). Tests are excluded: vitest fixtures are churn, not style.
    ignorePatterns: [
      'docs/**',
      'skills/**',
      '.codegraph/**',
      '.mycc/**',
      '.vscode/**',
      '**/*.md',
      '**/*.sh',
      'src/tests/**',
      'src/web/dist/**',
      'dist/**',
      'node_modules/**'
    ]
  }
});
